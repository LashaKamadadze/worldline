import { BinaryReader, BinaryWriter, Uuid } from 'spacetimedb';
import { decodeFrames, encodeFrame } from './framing';
import type { StorageAdapter } from './storage/adapter';

export type IntentStatus = 'pending' | 'acked' | 'failed' | 'cancelled';

export interface IntentRecord {
  intentId: Uuid;
  /** Wire name, e.g. `create_todo`. */
  reducerName: string;
  /** Accessor on the module namespace object, e.g. `createTodo`. */
  accessorName: string;
  /** BSATN-encoded full argument product (user args + intentId + clientTs). */
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
const STATUS_CODE: Record<Exclude<IntentStatus, 'pending'>, number> = {
  acked: 1,
  failed: 2,
  cancelled: 3,
};

export const idKey = (id: Uuid): string => id.toString();

function encodeIntent(rec: IntentRecord): Uint8Array {
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

function encodeMark(id: Uuid, status: Exclude<IntentStatus, 'pending'>, message: string): Uint8Array {
  const w = new BinaryWriter(64 + message.length);
  w.writeU8(KIND_MARK);
  w.writeU128(id.asBigInt());
  w.writeU8(STATUS_CODE[status]);
  w.writeString(message);
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
  | { kind: 'header' | 'commit'; generation: bigint };

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
      rec: { intentId, reducerName, accessorName, argsBsatn, clientTsMicros, predicted, readSet, writeSet },
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
  records: number;
  torn: boolean;
  validLength: number;
}

/**
 * Append-only, checksummed intent log with two slots.
 *
 * A slot file is `HEADER(gen) INTENT* COMMIT(gen) (INTENT|MARK)*`. Compaction
 * writes a fresh slot (pending intents only) to the *other* file and switches
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
      for (const [k, v] of chosen.pending) log.pending.set(k, v);
      log.#slot = slot;
      log.#generation = chosen.generation;
      log.#clean = !chosen.torn;
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
    const head = decodeRecord(frames[0]);
    if (!head || head.kind !== 'header') return null;
    const pending = new Map<string, IntentRecord>();
    let committed = false;
    for (const f of frames.slice(1)) {
      const d = decodeRecord(f);
      if (!d) continue;
      if (d.kind === 'commit') {
        if (d.generation === head.generation) committed = true;
      } else if (d.kind === 'intent') pending.set(idKey(d.rec.intentId), d.rec);
      else if (d.kind === 'mark') pending.delete(idKey(d.id));
    }
    if (!committed) return null;
    return { generation: head.generation, pending, records: frames.length, torn, validLength };
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
    this.pending.set(idKey(rec.intentId), rec);
    return this.#enqueue(() => this.#appendFrame(encodeFrame(encodeIntent(rec))));
  }

  mark(id: Uuid, status: Exclude<IntentStatus, 'pending'>, message = ''): Promise<void> {
    this.pending.delete(idKey(id));
    this.#marksSinceCompact++;
    return this.#enqueue(() => this.#appendFrame(encodeFrame(encodeMark(id, status, message))));
  }

  async #appendFrame(frame: Uint8Array): Promise<void> {
    if (!this.#clean) await this.#compactNow();
    try {
      await this.#storage.append(this.#file(this.#slot), frame);
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
    const target: 'a' | 'b' = this.#clean || this.#generation > 0n ? (this.#slot === 'a' ? 'b' : 'a') : 'a';
    const parts = [encodeFrame(encodeGen(KIND_HEADER, generation))];
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
    this.#marksSinceCompact = 0;
    if (old !== target) {
      await this.#storage.remove(this.#file(old)).catch(() => undefined);
    }
  }

  /** Wait for every queued write to settle (test helper). */
  flush(): Promise<void> {
    return this.#queue.then(() => undefined, () => undefined);
  }
}
