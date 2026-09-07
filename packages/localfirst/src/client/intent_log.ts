import { BinaryReader, BinaryWriter, Uuid } from 'spacetimedb';
import { assert, assertDefined } from '../shared/assert';
import {
  INTENT_ARGS_BYTES_MAX,
  INTENTS_PENDING_MAX,
  LOG_SLOT_BYTES_COMPACT_AT,
  REDUCER_NAME_CHARS_MAX,
  SESSION_EPOCH_MAX,
} from '../shared/limits';
import type { Session } from '../shared/session';
import { decodeFrames, encodeFrame } from './framing';
import type { StorageAdapter } from './storage/adapter';

export type IntentStatus = 'pending' | 'acked' | 'failed' | 'cancelled';

export interface IntentRecord {
  intentId: Uuid;
  /** Wire name, e.g. `create_todo`. */
  reducerName: string;
  /** Accessor on the module namespace object, e.g. `createTodo`. */
  accessorName: string;
  /**
   * BSATN-encoded record product (user args + intentId + clientTs). The
   * session fields are added at send time, since one intent may be sent in
   * several sessions.
   */
  argsBsatn: Uint8Array;
  clientTsMicros: bigint;
  /** Whether the local prediction succeeded when the intent was created. */
  predicted: boolean;
  readSet: string[];
  writeSet: string[];
}

const KIND_INTENT = 1;
const KIND_MARK = 2;
const KIND_HEADER = 3;
const KIND_COMMIT = 4;
const KIND_SESSION = 5;
const STATUS_CODE: Record<Exclude<IntentStatus, 'pending'>, number> = {
  acked: 1,
  failed: 2,
  cancelled: 3,
};

export const idKey = (id: Uuid): string => id.toString();

function encodeIntent(rec: IntentRecord): Uint8Array {
  assert(rec.argsBsatn.length <= INTENT_ARGS_BYTES_MAX, 'intent args exceed INTENT_ARGS_BYTES_MAX');
  assert(rec.reducerName.length > 0, 'intent has an empty reducer name');
  assert(rec.reducerName.length <= REDUCER_NAME_CHARS_MAX, 'reducer name too long');
  const w = new BinaryWriter(128 + rec.argsBsatn.length);
  w.writeU8(KIND_INTENT);
  w.writeU128(rec.intentId.asBigInt());
  w.writeString(rec.reducerName);
  w.writeString(rec.accessorName);
  w.writeUInt8Array(rec.argsBsatn);
  w.writeI64(rec.clientTsMicros);
  w.writeBool(rec.predicted);
  w.writeU32(rec.readSet.length);
  for (const s of rec.readSet) w.writeString(s);
  w.writeU32(rec.writeSet.length);
  for (const s of rec.writeSet) w.writeString(s);
  return w.getBuffer();
}

function encodeMark(
  id: Uuid,
  status: Exclude<IntentStatus, 'pending'>,
  message: string
): Uint8Array {
  const w = new BinaryWriter(64 + message.length);
  w.writeU8(KIND_MARK);
  w.writeU128(id.asBigInt());
  w.writeU8(STATUS_CODE[status]);
  w.writeString(message);
  return w.getBuffer();
}

function encodeSession(session: Session): Uint8Array {
  assert(session.epoch > 0n, 'session epoch must be positive');
  assert(session.epoch <= SESSION_EPOCH_MAX, 'session epoch above SESSION_EPOCH_MAX');
  const w = new BinaryWriter(32);
  w.writeU8(KIND_SESSION);
  w.writeU128(session.clientId.asBigInt());
  w.writeU64(session.epoch);
  return w.getBuffer();
}

function encodeGen(kind: number, generation: bigint): Uint8Array {
  const w = new BinaryWriter(16);
  w.writeU8(kind);
  w.writeU64(generation);
  return w.getBuffer();
}

type Decoded =
  | { kind: 'intent'; rec: IntentRecord }
  | { kind: 'mark'; id: Uuid; status: number; message: string }
  | { kind: 'header' | 'commit'; generation: bigint }
  | { kind: 'session'; session: Session };

function decodeRecord(payload: Uint8Array): Decoded | null {
  const r = new BinaryReader(payload);
  const kind = r.readU8();
  if (kind === KIND_INTENT) {
    const intentId = new Uuid(r.readU128());
    const reducerName = r.readString();
    const accessorName = r.readString();
    const argsBsatn = r.readUInt8Array();
    const clientTsMicros = r.readI64();
    const predicted = r.readBool();
    const nr = r.readU32();
    const readSet: string[] = [];
    for (let i = 0; i < nr; i++) readSet.push(r.readString());
    const nw = r.readU32();
    const writeSet: string[] = [];
    for (let i = 0; i < nw; i++) writeSet.push(r.readString());
    return {
      kind: 'intent',
      rec: {
        intentId,
        reducerName,
        accessorName,
        argsBsatn,
        clientTsMicros,
        predicted,
        readSet,
        writeSet,
      },
    };
  }
  if (kind === KIND_MARK) {
    const id = new Uuid(r.readU128());
    const status = r.readU8();
    const message = r.readString();
    return { kind: 'mark', id, status, message };
  }
  if (kind === KIND_HEADER || kind === KIND_COMMIT) {
    return { kind: kind === KIND_HEADER ? 'header' : 'commit', generation: r.readU64() };
  }
  if (kind === KIND_SESSION) {
    const clientId = new Uuid(r.readU128());
    const epoch = r.readU64();
    return { kind: 'session', session: { clientId, epoch } };
  }
  return null;
}

export interface LogRecovery {
  records: number;
  torn: boolean;
  truncatedBytes: number;
  /** Which slot was chosen and its generation. */
  slot: 'a' | 'b';
  generation: bigint;
}

interface ParsedSlot {
  generation: bigint;
  pending: Map<string, IntentRecord>;
  /** The last session frame in the slot, or null if the client never began one. */
  session: Session | null;
  records: number;
  torn: boolean;
  validLength: number;
}

/**
 * Append-only, checksummed intent log with two slots.
 *
 * A slot file is `HEADER(gen) SESSION? INTENT* COMMIT(gen) (INTENT|MARK|SESSION)*`.
 * Compaction writes a fresh slot (session + pending intents) to the *other* file and switches
 * to it only if that write succeeded, so a torn or failed rewrite can never
 * lose intents that were already reported durable. On open, the valid slot
 * (header + matching commit) with the highest generation wins.
 *
 * A torn tail in the chosen slot is dropped by compaction rather than by
 * truncating in place. Until a clean slot exists, `append` rejects, keeping
 * the promise "durable resolved = will be recovered" honest.
 */
export class IntentLog {
  readonly pending = new Map<string, IntentRecord>();
  readonly baseName: string;
  recovery: LogRecovery = { records: 0, torn: false, truncatedBytes: 0, slot: 'a', generation: 0n };
  #storage: StorageAdapter;
  #queue: Promise<unknown> = Promise.resolve();
  #marksSinceCompact = 0;
  #slot: 'a' | 'b' = 'a';
  #generation = 0n;
  /** False while the active slot has a torn tail or no slot exists on disk. */
  #clean = false;
  /** Bytes appended to the active slot since it was written; compaction resets it. */
  #slotBytes = 0;
  /** The newest session frame known to be durable. */
  #session: Session | null = null;

  private constructor(storage: StorageAdapter, baseName: string) {
    this.#storage = storage;
    this.baseName = baseName;
  }

  #file(slot: 'a' | 'b'): string {
    return `${this.baseName}.${slot}`;
  }

  get slot(): 'a' | 'b' {
    return this.#slot;
  }

  get generation(): bigint {
    return this.#generation;
  }

  get clean(): boolean {
    return this.#clean;
  }

  /** The session the next intent is sent in; null until `beginSession()` has resolved once. */
  get session(): Session | null {
    return this.#session;
  }

  static async open(storage: StorageAdapter, baseName = 'intents.log'): Promise<IntentLog> {
    const log = new IntentLog(storage, baseName);
    const a = await log.#parseSlot('a');
    const b = await log.#parseSlot('b');
    let chosen: ParsedSlot | null = a;
    let slot: 'a' | 'b' = 'a';
    if (b && (chosen === null || b.generation > chosen.generation)) {
      chosen = b;
      slot = 'b';
    }
    if (chosen) {
      assert(
        chosen.pending.size <= INTENTS_PENDING_MAX,
        'log holds more intents than INTENTS_PENDING_MAX'
      );
      for (const [k, v] of chosen.pending) log.pending.set(k, v);
      log.#slot = slot;
      log.#generation = chosen.generation;
      log.#clean = !chosen.torn;
      log.#slotBytes = chosen.validLength;
      log.#session = chosen.session;
      log.recovery = {
        records: chosen.records,
        torn: chosen.torn,
        truncatedBytes: chosen.torn ? -1 : 0,
        slot,
        generation: chosen.generation,
      };
      if (chosen.torn) {
        // Move to a clean slot now if storage allows; otherwise appends retry it.
        await log.compact().catch(() => undefined);
      }
    } else {
      // Nothing valid on disk: start generation 1 in slot a.
      await log.compact().catch(() => undefined);
    }
    return log;
  }

  async #parseSlot(slot: 'a' | 'b'): Promise<ParsedSlot | null> {
    // A read error is not "no slot"; swallowing it would silently discard
    // durable intents. Let it propagate so the app can retry opening.
    const bytes = await this.#storage.read(this.#file(slot));
    if (!bytes || bytes.length === 0) return null;
    const { frames, validLength, torn } = decodeFrames(bytes);
    if (!frames.length) return null;
    const head = decodeRecord(assertDefined(frames[0], 'frames is non-empty'));
    if (!head || head.kind !== 'header') return null;
    const pending = new Map<string, IntentRecord>();
    let session: Session | null = null;
    let committed = false;
    for (const f of frames.slice(1)) {
      const d = decodeRecord(f);
      if (!d) continue;
      if (d.kind === 'commit') {
        if (d.generation === head.generation) committed = true;
      } else if (d.kind === 'intent') pending.set(idKey(d.rec.intentId), d.rec);
      else if (d.kind === 'mark') pending.delete(idKey(d.id));
      else if (d.kind === 'session') session = d.session;
    }
    if (!committed) return null;
    return {
      generation: head.generation,
      pending,
      session,
      records: frames.length,
      torn,
      validLength,
    };
  }

  /** Serialize all writes so frames land in call order even when awaited concurrently. */
  #enqueue<T>(f: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(f, f);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  /**
   * Record a new intent. Resolves once the frame is durable. On failure the
   * intent is still kept in memory (volatile) so it can be sent this session;
   * the caller learns via the rejection that it will not survive a restart.
   */
  append(rec: IntentRecord): Promise<void> {
    const key = idKey(rec.intentId);
    assert(!this.pending.has(key), `intent ${key} appended twice`);
    assert(this.pending.size < INTENTS_PENDING_MAX, 'pending intents exceed INTENTS_PENDING_MAX');
    this.pending.set(key, rec);
    return this.#enqueue(() => this.#appendFrame(encodeFrame(encodeIntent(rec))));
  }

  mark(id: Uuid, status: Exclude<IntentStatus, 'pending'>, message = ''): Promise<void> {
    this.pending.delete(idKey(id));
    this.#marksSinceCompact++;
    return this.#enqueue(() => this.#appendFrame(encodeFrame(encodeMark(id, status, message))));
  }

  /**
   * Open the next session: same client id (or a fresh one from `newClientId`
   * the first time), epoch one above the last durable one. Resolves once the
   * frame is durable; until then, and if it rejects, `session` is unchanged
   * and nothing may be sent under the new epoch.
   */
  beginSession(newClientId: () => Uuid): Promise<Session> {
    return this.#enqueue(async () => {
      const previous = this.#session;
      const next: Session = {
        clientId: previous === null ? newClientId() : previous.clientId,
        epoch: previous === null ? 1n : previous.epoch + 1n,
      };
      assert(next.epoch <= SESSION_EPOCH_MAX, 'session epochs exhausted');
      await this.#appendFrame(encodeFrame(encodeSession(next)));
      this.#session = next;
      assert(previous === null || next.epoch > previous.epoch, 'session epoch must grow');
      return next;
    });
  }

  async #appendFrame(frame: Uint8Array): Promise<void> {
    if (!this.#clean) await this.#compactNow();
    if (this.#slotBytes + frame.length > LOG_SLOT_BYTES_COMPACT_AT) await this.#compactNow();
    assert(this.#clean, 'appending to a dirty slot');
    try {
      await this.#storage.append(this.#file(this.#slot), frame);
      this.#slotBytes += frame.length;
    } catch (e) {
      // A failed append may have left a partial frame; anything appended after
      // it would be unreadable. Switch slots before the next write.
      this.#clean = false;
      throw e;
    }
  }

  get marksSinceCompact(): number {
    return this.#marksSinceCompact;
  }

  /** Write pending intents to the other slot and switch to it. Safe to call any time. */
  compact(): Promise<void> {
    return this.#enqueue(() => this.#compactNow());
  }

  async #compactNow(): Promise<void> {
    const generation = this.#generation + 1n;
    const target: 'a' | 'b' =
      this.#clean || this.#generation > 0n ? (this.#slot === 'a' ? 'b' : 'a') : 'a';
    const parts = [encodeFrame(encodeGen(KIND_HEADER, generation))];
    if (this.#session !== null) parts.push(encodeFrame(encodeSession(this.#session)));
    for (const r of this.pending.values()) parts.push(encodeFrame(encodeIntent(r)));
    parts.push(encodeFrame(encodeGen(KIND_COMMIT, generation)));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    // If this write fails or tears, the current slot is untouched and stays authoritative.
    await this.#storage.write(this.#file(target), out);
    const old = this.#slot;
    this.#slot = target;
    this.#generation = generation;
    this.#clean = true;
    this.#slotBytes = out.length;
    this.#marksSinceCompact = 0;
    assert(this.#generation > 0n, 'generation must be positive after compaction');
    if (old !== target) {
      await this.#storage.remove(this.#file(old)).catch(() => undefined);
    }
  }

  /** Wait for every queued write to settle (test helper). */
  flush(): Promise<void> {
    return this.#queue.then(
      () => undefined,
      () => undefined
    );
  }
}
