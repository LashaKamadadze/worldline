import { Identity, ProductType, Timestamp, Uuid, BinaryReader, BinaryWriter } from 'spacetimedb';
import { CLIENT_TS_PARAM, INTENT_ID_PARAM, LF_INNER, LF_WRAPPED } from '../shared/symbols';
import { dependentsOf } from './deps';
import { LocalFirstError } from './errors';
import { executeReducer } from './executor';
import { idKey, IntentLog, type IntentRecord, type IntentStatus } from './intent_log';
import { LocalStore, type Coverage } from './local_store';
import { matchRange, deepEqual } from './compare';
import { CryptoRng, uuidV7, type Rng } from './rng';
import { SnapshotStore, type SnapshotMeta } from './snapshot';
import type { StorageAdapter } from './storage/adapter';
import { tableSpecsFromSchema, type Row, type TableSpec } from './table_spec';
import type { Link } from './transport';
import type { WorkingSet } from './sdk_link';

export interface ReducerBinding {
  name: string;
  accessorName: string;
  paramsType: any;
}

export interface LocalFirstOptions {
  /** The SpacetimeDB module namespace object: `import * as mod from './module'`. */
  module: Record<string, any>;
  /** Generated client bindings' `reducers` accessor map (wire names + param types). */
  reducers: Record<string, ReducerBinding>;
  storage: StorageAdapter;
  workingSet: WorkingSet;
  /** This client's identity; `ctx.sender` during prediction. Updated on connect. */
  identity?: Identity;
  /** Microseconds since Unix epoch. Injectable for simulation. */
  clock?: () => bigint;
  rng?: Rng;
  /** How many intents may be awaiting an ack at once. Default 1 (exact cancellation). */
  inflightWindow?: number;
  /** Debounce for automatic base snapshots; `null` disables them. */
  snapshotDebounceMs?: number | null;
  /** Compact the log after this many marks once nothing is pending. */
  compactEvery?: number;
  /** Override table specs (default: derived from `module.default.schemaType`). */
  tables?: TableSpec[];
  /** Timer hooks, injectable for simulation. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Runs once per `connect()` before the first intent is sent. Use it to
   * refresh an auth token that may have expired during a long offline period;
   * if it rejects, nothing is sent until the next `connect()`.
   */
  beforeDrain?: (lf: LocalFirst) => Promise<void> | void;
}

export interface CallOptions {
  /**
   * If true, a call that cannot be predicted (cache miss on a partial table,
   * auto-increment, clear) throws instead of being queued unpredicted.
   */
  strict?: boolean;
}

export interface CallHandle {
  intentId: Uuid;
  /** Whether the local prediction was applied. */
  predicted: boolean;
  /** Resolves once the intent is on disk. Rejects if storage failed (intent kept in memory only). */
  durable: Promise<void>;
  /** Resolves with the final status once the server has decided. */
  settled: Promise<Exclude<IntentStatus, 'pending'>>;
}

export type IntentEvent =
  | { type: 'queued'; intent: IntentRecord; predicted: boolean }
  | { type: 'sent'; intent: IntentRecord }
  | { type: 'acked'; intent: IntentRecord }
  | { type: 'failed'; intent: IntentRecord; error: unknown; cancelled: IntentRecord[] }
  | { type: 'cancelled'; intent: IntentRecord; because: IntentRecord }
  | { type: 'rebase'; predicted: number; unpredicted: number };

interface ReducerEntry {
  accessorName: string;
  name: string;
  wrapped: boolean;
  innerFn: (ctx: any, args: Row) => unknown;
  serialize: (w: BinaryWriter, v: Row) => void;
  deserialize: (r: BinaryReader) => Row;
}

const hashString = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
};

/**
 * The client-side engine: predicted overlay + durable intent log + syncer.
 *
 * Lifecycle: `open()` loads the snapshot and log and rebuilds predictions;
 * `call()` runs a reducer locally and queues it; `connect()` attaches a live
 * server link, drains the queue and rebases on every server update.
 */
export class LocalFirst {
  readonly store: LocalStore;
  readonly log: IntentLog;
  readonly db: Record<string, any>;
  #snap: SnapshotStore;
  #opts: LocalFirstOptions;
  #entries = new Map<Function, ReducerEntry>();
  #byAccessor = new Map<string, ReducerEntry>();
  #identity: Identity;
  #clock: () => bigint;
  #rng: Rng;
  #uuidCounter = { value: 0 };
  #link: Link | null = null;
  #linkGen = 0;
  #drainReady = false;
  #linkUnsubs: (() => void)[] = [];
  #inflight = new Set<string>();
  #window: number;
  #settlers = new Map<string, (s: Exclude<IntentStatus, 'pending'>) => void>();
  #listeners = new Set<(ev: IntentEvent) => void>();
  #userArgs = new Map<string, Row>();
  #predictedNow = new Map<string, boolean>();
  #rebaseScheduled = false;
  #snapshotTimer: unknown = undefined;
  #lastServerTs = 0n;
  #closed = false;
  #workingSetHash: string;
  #accessors: string[];

  private constructor(opts: LocalFirstOptions, store: LocalStore, log: IntentLog, snap: SnapshotStore) {
    this.#opts = opts;
    this.store = store;
    this.log = log;
    this.#snap = snap;
    this.#identity = opts.identity ?? Identity.zero();
    this.#clock = opts.clock ?? (() => BigInt(Date.now()) * 1000n);
    this.#rng = opts.rng ?? new CryptoRng();
    this.#window = Math.max(1, opts.inflightWindow ?? 1);
    this.#accessors = store.tableNames.filter(a => !store.spec(a).namespace);
    this.#workingSetHash = hashString(
      typeof opts.workingSet.queries === 'function'
        ? opts.workingSet.queries.toString()
        : opts.workingSet.queries.join('\n')
    );

    for (const [key, val] of Object.entries(opts.module)) {
      if (key === 'default' || typeof val !== 'function') continue;
      const binding = opts.reducers[key];
      if (!binding) continue;
      const wrapped = (val as any)[LF_WRAPPED] === true;
      const elements: { name: string }[] = binding.paramsType?.elements ?? [];
      if (wrapped && !elements.some(e => e.name === INTENT_ID_PARAM)) {
        throw new LocalFirstError(
          `reducer '${binding.name}' is wrapped with offlineReducer() but the generated bindings ` +
            `have no '${INTENT_ID_PARAM}' parameter; regenerate module bindings`
        );
      }
      const entry: ReducerEntry = {
        accessorName: key,
        name: binding.name,
        wrapped,
        innerFn: wrapped ? (val as any)[LF_INNER] : (val as any),
        serialize: ProductType.makeSerializer(binding.paramsType),
        deserialize: ProductType.makeDeserializer(binding.paramsType),
      };
      this.#entries.set(val as Function, entry);
      this.#byAccessor.set(key, entry);
    }

    this.db = this.#buildReadView();
  }

  static async open(opts: LocalFirstOptions): Promise<LocalFirst> {
    const specs = opts.tables ?? tableSpecsFromSchema(opts.module.default);
    if (!specs.length) throw new LocalFirstError('no tables found; pass `tables` or a module with a default schema export');
    const coverage = (acc: string): Coverage => opts.workingSet.coverage?.[acc] ?? 'full';
    const store = new LocalStore(specs, { coverage });
    const log = await IntentLog.open(opts.storage);
    const snap = new SnapshotStore(opts.storage, store.specs);
    const loaded = await snap.load();
    const lf = new LocalFirst(opts, store, log, snap);
    if (loaded) {
      lf.#lastServerTs = loaded.meta.serverTsMicros;
      for (const [acc, rows] of loaded.tables) {
        if (store.specs.has(acc)) store.replaceBase(acc, rows);
      }
    }
    lf.rebase();
    return lf;
  }

  // ------------------------------------------------------------------ info

  get identity(): Identity {
    return this.#identity;
  }

  setIdentity(identity: Identity): void {
    this.#identity = identity;
  }

  get connected(): boolean {
    return this.#link !== null;
  }

  get lastServerTimestamp(): Timestamp {
    return new Timestamp(this.#lastServerTs);
  }

  pending(): IntentRecord[] {
    return [...this.log.pending.values()];
  }

  isPredicted(intentId: Uuid): boolean {
    return this.#predictedNow.get(idKey(intentId)) ?? false;
  }

  onIntent(cb: (ev: IntentEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** Fires when the merged view of any table changed. */
  subscribe(cb: (changed: ReadonlySet<string>) => void): () => void {
    return this.store.subscribe(cb);
  }

  #emit(ev: IntentEvent) {
    for (const l of this.#listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error('stdb-localfirst listener threw', e);
      }
    }
  }

  // ------------------------------------------------------------------ calls

  /**
   * Run `reducer` locally now and queue it for the server.
   * Throws synchronously if the reducer rejects the call locally.
   */
  call(reducer: Function, args: Row = {}, options: CallOptions = {}): CallHandle {
    if (this.#closed) throw new LocalFirstError('LocalFirst is closed');
    const entry = this.#entries.get(reducer);
    if (!entry) {
      throw new LocalFirstError(
        'unknown reducer: pass an export of the module namespace object that also exists in the generated `reducers` map'
      );
    }
    const now = this.#clock();
    const intentId = uuidV7(this.#rng, this.#uuidCounter, now);
    const clientTs = new Timestamp(now);
    const fullArgs = entry.wrapped
      ? { ...args, [INTENT_ID_PARAM]: intentId, [CLIENT_TS_PARAM]: clientTs }
      : args;
    const w = new BinaryWriter(256);
    entry.serialize(w, fullArgs);
    const argsBsatn = w.getBuffer();

    const exec = executeReducer(this.store, entry.innerFn, args, {
      sender: this.#identity,
      timestamp: clientTs,
      clientTimestamp: clientTs,
      connectionId: null,
      rng: this.#rng,
    });
    if (exec.status === 'failed') throw exec.error;
    if (exec.status === 'unpredicted' && options.strict) throw exec.error;

    const predicted = exec.status === 'predicted';
    const rec: IntentRecord = {
      intentId,
      reducerName: entry.name,
      accessorName: entry.accessorName,
      argsBsatn,
      clientTsMicros: now,
      predicted,
      readSet: predicted ? [...exec.readSet] : [],
      writeSet: predicted ? [...exec.writeSet] : [],
    };
    const key = idKey(intentId);
    this.#userArgs.set(key, args);
    this.#predictedNow.set(key, predicted);
    if (predicted) {
      const changed = this.store.applyToOverlay(exec.writes);
      this.store.notify(changed);
    }

    const settled = new Promise<Exclude<IntentStatus, 'pending'>>(resolve => this.#settlers.set(key, resolve));
    const durable = this.log.append(rec);
    durable.catch(() => {
      /* surfaced to the caller through the handle; intent stays in memory */
    });
    this.#emit({ type: 'queued', intent: rec, predicted });
    this.#drain();
    return { intentId, predicted, durable, settled };
  }

  // -------------------------------------------------------------- linking

  connect(link: Link): void {
    if (this.#closed) throw new LocalFirstError('LocalFirst is closed');
    if (this.#link) this.disconnect();
    this.#link = link;
    this.#linkGen++;
    if (link.identity) this.#identity = link.identity;
    this.#drainReady = !this.#opts.beforeDrain;
    if (this.#opts.beforeDrain) {
      const gen = this.#linkGen;
      Promise.resolve()
        .then(() => this.#opts.beforeDrain!(this))
        .then(
          () => {
            if (gen !== this.#linkGen) return;
            this.#drainReady = true;
            this.#drain();
          },
          err => console.warn('stdb-localfirst: beforeDrain failed; not sending until next connect', err)
        );
    }
    this.#linkUnsubs.push(
      link.events.onInitialState(tables => {
        for (const [acc, rows] of tables) {
          if (this.store.specs.has(acc)) this.store.replaceBase(acc, rows);
        }
        this.#lastServerTs = this.#clock();
        this.#scheduleRebase();
        this.#scheduleSnapshot();
        this.#drain();
      }),
      link.events.onDelta((acc, delta) => {
        if (!this.store.specs.has(acc)) return;
        this.store.applyDelta(acc, delta);
        this.#lastServerTs = this.#clock();
        this.#scheduleRebase();
        this.#scheduleSnapshot();
      })
    );
    this.#drain();
  }

  disconnect(): void {
    const link = this.#link;
    if (!link) return;
    this.#link = null;
    this.#linkGen++;
    // Anything in flight is now unknown: it will be resent, and the server's
    // applied_intents table makes the resend a no-op if it already ran.
    this.#inflight.clear();
    for (const u of this.#linkUnsubs) u();
    this.#linkUnsubs = [];
    link.dispose();
  }

  // ------------------------------------------------------------- syncing

  #drain(): void {
    const link = this.#link;
    if (!link || this.#closed || !this.#drainReady) return;
    for (const rec of this.log.pending.values()) {
      if (this.#inflight.size >= this.#window) break;
      const key = idKey(rec.intentId);
      if (this.#inflight.has(key)) continue;
      this.#inflight.add(key);
      const gen = this.#linkGen;
      this.#emit({ type: 'sent', intent: rec });
      link.transport.callReducer(rec.reducerName, rec.argsBsatn).then(
        () => {
          if (gen !== this.#linkGen) return;
          this.#onAcked(rec);
        },
        err => {
          if (gen !== this.#linkGen) return;
          this.#onFailed(rec, err);
        }
      );
    }
  }

  #settle(rec: IntentRecord, status: Exclude<IntentStatus, 'pending'>) {
    const key = idKey(rec.intentId);
    this.#inflight.delete(key);
    this.#userArgs.delete(key);
    this.#predictedNow.delete(key);
    const s = this.#settlers.get(key);
    if (s) {
      this.#settlers.delete(key);
      s(status);
    }
  }

  #onAcked(rec: IntentRecord) {
    if (!this.log.pending.has(idKey(rec.intentId))) return;
    this.log.mark(rec.intentId, 'acked').catch(e => console.warn('stdb-localfirst: could not persist ack', e));
    this.#settle(rec, 'acked');
    this.#emit({ type: 'acked', intent: rec });
    this.#scheduleRebase();
    this.#maybeCompact();
    this.#drain();
  }

  #onFailed(rec: IntentRecord, err: unknown) {
    if (!this.log.pending.has(idKey(rec.intentId))) return;
    const ordered = [...this.log.pending.values()];
    // Dependents already sent are the server's call now; only unsent ones are cancelled.
    const deps = dependentsOf(rec, ordered).filter(d => !this.#inflight.has(idKey(d.intentId)));
    const message = err instanceof Error ? err.message : String(err);
    this.log.mark(rec.intentId, 'failed', message).catch(() => undefined);
    this.#settle(rec, 'failed');
    for (const d of deps) {
      this.log.mark(d.intentId, 'cancelled', `depends on failed intent ${rec.intentId}`).catch(() => undefined);
      this.#settle(d, 'cancelled');
      this.#emit({ type: 'cancelled', intent: d, because: rec });
    }
    this.#emit({ type: 'failed', intent: rec, error: err, cancelled: deps });
    this.#scheduleRebase();
    this.#maybeCompact();
    this.#drain();
  }

  #maybeCompact() {
    const every = this.#opts.compactEvery ?? 64;
    if (this.log.pending.size === 0 && this.log.marksSinceCompact >= every) {
      this.log.compact().catch(e => console.warn('stdb-localfirst: compaction failed', e));
    }
  }

  // -------------------------------------------------------------- rebase

  #scheduleRebase() {
    if (this.#rebaseScheduled || this.#closed) return;
    this.#rebaseScheduled = true;
    queueMicrotask(() => {
      this.#rebaseScheduled = false;
      if (!this.#closed) this.rebase();
    });
  }

  #argsFor(rec: IntentRecord, entry: ReducerEntry): Row {
    const key = idKey(rec.intentId);
    let args = this.#userArgs.get(key);
    if (!args) {
      const full = entry.deserialize(new BinaryReader(rec.argsBsatn));
      if (entry.wrapped) {
        const { [INTENT_ID_PARAM]: _i, [CLIENT_TS_PARAM]: _c, ...rest } = full;
        args = rest;
      } else {
        args = full;
      }
      this.#userArgs.set(key, args);
    }
    return args;
  }

  /**
   * Throw the overlay away and replay every pending intent on top of base.
   * A replay that now throws is kept pending but unpredicted: the server
   * decides, the client just stops guessing.
   */
  rebase(): void {
    const changed = new Set(this.store.clearOverlay());
    let predicted = 0;
    let unpredicted = 0;
    for (const rec of this.log.pending.values()) {
      const key = idKey(rec.intentId);
      const entry = this.#byAccessor.get(rec.accessorName);
      if (!entry) {
        this.#predictedNow.set(key, false);
        unpredicted++;
        continue;
      }
      const ts = new Timestamp(rec.clientTsMicros);
      const exec = executeReducer(this.store, entry.innerFn, this.#argsFor(rec, entry), {
        sender: this.#identity,
        timestamp: ts,
        clientTimestamp: ts,
        connectionId: null,
        rng: this.#rng,
      });
      if (exec.status === 'predicted') {
        for (const acc of this.store.applyToOverlay(exec.writes)) changed.add(acc);
        this.#predictedNow.set(key, true);
        predicted++;
      } else {
        this.#predictedNow.set(key, false);
        unpredicted++;
      }
    }
    this.store.notify(changed);
    this.#emit({ type: 'rebase', predicted, unpredicted });
  }

  // ------------------------------------------------------------ snapshot

  #scheduleSnapshot() {
    const ms = this.#opts.snapshotDebounceMs;
    if (ms === null || ms === undefined && false) return;
    const delay = ms ?? 2000;
    const set = this.#opts.setTimer ?? ((fn, m) => setTimeout(fn, m));
    const clear = this.#opts.clearTimer ?? (h => clearTimeout(h as any));
    if (this.#snapshotTimer !== undefined) clear(this.#snapshotTimer);
    this.#snapshotTimer = set(() => {
      this.#snapshotTimer = undefined;
      this.snapshotNow().catch(e => console.warn('stdb-localfirst: snapshot failed', e));
    }, delay);
  }

  /** Write the base layer to disk now. */
  async snapshotNow(): Promise<SnapshotMeta> {
    const tables = new Map<string, Iterable<Row>>();
    for (const acc of this.#accessors) tables.set(acc, this.store.baseRows(acc));
    return this.#snap.save(tables, {
      serverTsMicros: this.#lastServerTs,
      workingSetHash: this.#workingSetHash,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const clear = this.#opts.clearTimer ?? (h => clearTimeout(h as any));
    if (this.#snapshotTimer !== undefined) clear(this.#snapshotTimer);
    this.disconnect();
    await this.log.flush();
  }

  // ----------------------------------------------------------- read view

  #buildReadView(): Record<string, any> {
    const view: Record<string, any> = Object.create(null);
    for (const acc of this.#accessors) {
      const spec = this.store.spec(acc);
      const store = this.store;
      const table: Record<string, any> = {
        iter: () => store.iter(acc),
        [Symbol.iterator]: () => store.iter(acc),
        count: () => BigInt(store.count(acc)),
      };
      for (const idx of spec.indexes) {
        const getKey = (row: Row) => idx.columns.map(c => row[c]);
        if (idx.unique) {
          table[idx.name] = Object.freeze({
            find: (colVal: any): Row | null => {
              const expected = Array.isArray(colVal) ? colVal : [colVal];
              if (idx.isPrimaryKey) {
                return store.get(acc, spec.rowKey({ [spec.primaryKey!]: expected[0] })) ?? null;
              }
              for (const row of store.iter(acc)) if (deepEqual(getKey(row), expected)) return row;
              return null;
            },
          });
        } else {
          table[idx.name] = Object.freeze({
            *filter(range: any): IterableIterator<Row> {
              for (const row of store.iter(acc)) if (matchRange(getKey(row), range)) yield row;
            },
          });
        }
      }
      view[acc] = Object.freeze(table);
    }
    return Object.freeze(view);
  }
}
