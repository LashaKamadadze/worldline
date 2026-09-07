import { BinaryReader, BinaryWriter, Identity, ProductType, Timestamp, Uuid } from 'spacetimedb';
import { assert, assertDefined } from '../shared/assert';
import {
  COMPACT_EVERY_MARKS_DEFAULT,
  INFLIGHT_WINDOW_MAX,
  INTENT_ARGS_BYTES_MAX,
  INTENTS_PENDING_MAX,
  LISTENERS_MAX,
  REBASE_INTENTS_MAX,
  SNAPSHOT_DEBOUNCE_MS_DEFAULT,
  SNAPSHOT_DEBOUNCE_MS_MAX,
} from '../shared/limits';
import { CLIENT_TS_PARAM, INTENT_ID_PARAM, LF_INNER, LF_WRAPPED } from '../shared/symbols';
import { deepEqual, matchRange } from './compare';
import { dependentsOf } from './deps';
import { LocalFirstError } from './errors';
import { executeReducer, type ExecOutcome } from './executor';
import { idKey, IntentLog, type IntentRecord, type IntentStatus } from './intent_log';
import { LocalStore, type Coverage } from './local_store';
import { CryptoRng, uuidV7, type Rng } from './rng';
import type { WorkingSet } from './sdk_link';
import { SnapshotStore, type SnapshotMeta } from './snapshot';
import type { StorageAdapter } from './storage/adapter';
import { tableSpecsFromSchema, type Row, type TableSpec } from './table_spec';
import type { Link } from './transport';

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
  /** Skip the single-writer storage lock (tests only). */
  skipLock?: boolean;
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
  /** Resolves once the intent is on disk. Rejects if storage failed (kept in memory only). */
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

type SettledStatus = Exclude<IntentStatus, 'pending'>;

interface ReducerEntry {
  accessorName: string;
  name: string;
  wrapped: boolean;
  innerFn: (ctx: any, args: Row) => unknown;
  serialize: (writer: BinaryWriter, value: Row) => void;
  deserialize: (reader: BinaryReader) => Row;
}

const hashString = (text: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
};

/**
 * The client-side engine: predicted overlay + durable intent log + syncer.
 *
 * Lifecycle: `open()` loads the snapshot and log and rebuilds predictions;
 * `call()` runs a reducer locally and queues it; `connect()` attaches a live
 * server link, drains the queue and rebases on every server update.
 *
 * Every queue here is bounded by `shared/limits.ts`; `call()` refuses work
 * rather than growing without bound.
 */
/** Any reducer export from the module (wrapped or plain); used as a map key. */
export type AnyReducer = (...args: any[]) => unknown;

export class LocalFirst {
  readonly store: LocalStore;
  readonly log: IntentLog;
  readonly db: Record<string, any>;
  #snapshot: SnapshotStore;
  #options: LocalFirstOptions;
  #entries = new Map<AnyReducer, ReducerEntry>();
  #entriesByAccessor = new Map<string, ReducerEntry>();
  #identity: Identity;
  #clock: () => bigint;
  #rng: Rng;
  #uuidCounter = { value: 0 };
  #link: Link | null = null;
  #linkGeneration = 0;
  #linkUnsubscribes: (() => void)[] = [];
  #drainReady = false;
  #inflight = new Set<string>();
  #window: number;
  #settlers = new Map<string, (status: SettledStatus) => void>();
  #listeners = new Set<(event: IntentEvent) => void>();
  #userArgs = new Map<string, Row>();
  #predictedNow = new Map<string, boolean>();
  #rebaseScheduled = false;
  #snapshotTimer: unknown = undefined;
  #serverTsMicrosLast = 0n;
  #closed = false;
  #workingSetHash: string;
  #accessors: string[];
  #releaseLock: (() => Promise<void>) | null = null;

  private constructor(
    options: LocalFirstOptions,
    store: LocalStore,
    log: IntentLog,
    snapshot: SnapshotStore,
    releaseLock: (() => Promise<void>) | null
  ) {
    this.#options = options;
    this.store = store;
    this.log = log;
    this.#snapshot = snapshot;
    this.#releaseLock = releaseLock;
    this.#identity = options.identity ?? Identity.zero();
    this.#clock = options.clock ?? (() => BigInt(Date.now()) * 1000n);
    this.#rng = options.rng ?? new CryptoRng();
    this.#window = options.inflightWindow ?? 1;
    assert(this.#window >= 1, 'inflightWindow must be at least 1');
    assert(this.#window <= INFLIGHT_WINDOW_MAX, `inflightWindow above ${INFLIGHT_WINDOW_MAX}`);
    const debounce = options.snapshotDebounceMs;
    if (typeof debounce === 'number')
      assert(
        debounce >= 0 && debounce <= SNAPSHOT_DEBOUNCE_MS_MAX,
        'snapshotDebounceMs out of range'
      );
    this.#accessors = store.tableNames.filter(name => store.spec(name).namespace === undefined);
    assert(this.#accessors.length > 0, 'no root tables');
    this.#workingSetHash = hashString(workingSetText(options.workingSet));
    this.#registerReducers(options);
    this.db = buildReadView(store, this.#accessors);
  }

  #registerReducers(options: LocalFirstOptions): void {
    for (const [key, value] of Object.entries(options.module)) {
      if (key === 'default') continue;
      if (typeof value !== 'function') continue;
      const binding = options.reducers[key];
      if (binding === undefined) continue;
      const wrapped = value[LF_WRAPPED] === true;
      const elements: { name: string }[] = binding.paramsType?.elements ?? [];
      const hasIntentId = elements.some(element => element.name === INTENT_ID_PARAM);
      if (wrapped)
        assert(
          hasIntentId,
          `bindings for '${binding.name}' lack '${INTENT_ID_PARAM}'; regenerate them`
        );
      if (!wrapped)
        assert(
          !hasIntentId,
          `bindings for '${binding.name}' have '${INTENT_ID_PARAM}' but the export is not wrapped`
        );
      const entry: ReducerEntry = {
        accessorName: key,
        name: binding.name,
        wrapped,
        innerFn: wrapped ? value[LF_INNER] : value,
        serialize: ProductType.makeSerializer(binding.paramsType),
        deserialize: ProductType.makeDeserializer(binding.paramsType),
      };
      assert(typeof entry.innerFn === 'function', `reducer '${key}' has no callable body`);
      this.#entries.set(value as AnyReducer, entry);
      this.#entriesByAccessor.set(key, entry);
    }
    assert(this.#entries.size > 0, 'no reducers matched between the module and the bindings');
  }

  static async open(options: LocalFirstOptions): Promise<LocalFirst> {
    const specs = options.tables ?? tableSpecsFromSchema(options.module.default);
    if (specs.length === 0)
      throw new LocalFirstError(
        'no tables found; pass `tables` or a module with a default schema export'
      );
    const coverage = (accessor: string): Coverage =>
      options.workingSet.coverage?.[accessor] ?? 'full';
    const store = new LocalStore(specs, { coverage });

    const releaseLock = options.skipLock ? null : await acquireLock(options.storage);

    let log: IntentLog;
    let snapshot: SnapshotStore;
    let loaded;
    try {
      log = await IntentLog.open(options.storage);
      snapshot = new SnapshotStore(options.storage, store.specs);
      loaded = await snapshot.load();
    } catch (error) {
      await releaseLock?.();
      throw error;
    }

    const lf = new LocalFirst(options, store, log, snapshot, releaseLock);
    if (loaded !== null) {
      lf.#serverTsMicrosLast = loaded.meta.serverTsMicros;
      for (const [accessor, rows] of loaded.tables) {
        if (store.specs.has(accessor)) store.replaceBase(accessor, rows);
      }
    }
    lf.rebase();
    assert(lf.log.pending.size <= INTENTS_PENDING_MAX, 'recovered more intents than the bound');
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

  get closed(): boolean {
    return this.#closed;
  }

  get lastServerTimestamp(): Timestamp {
    return new Timestamp(this.#serverTsMicrosLast);
  }

  pending(): IntentRecord[] {
    return [...this.log.pending.values()];
  }

  isPredicted(intentId: Uuid): boolean {
    return this.#predictedNow.get(idKey(intentId)) ?? false;
  }

  onIntent(listener: (event: IntentEvent) => void): () => void {
    assert(this.#listeners.size < LISTENERS_MAX, `more than ${LISTENERS_MAX} intent listeners`);
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Fires when the merged view of any table changed. */
  subscribe(listener: (changed: ReadonlySet<string>) => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Listener exceptions are isolated so the engine keeps running. */
  #emit(event: IntentEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('stdb-localfirst: intent listener threw', error);
      }
    }
  }

  // ------------------------------------------------------------------ calls

  /**
   * Run `reducer` locally now and queue it for the server.
   * Throws synchronously if the reducer rejects the call locally, if the
   * pending queue is full, or (with `strict`) if the effect cannot be predicted.
   */
  call(reducer: AnyReducer, args: Row = {}, options: CallOptions = {}): CallHandle {
    assert(!this.#closed, 'call() on a closed LocalFirst');
    assert(typeof args === 'object' && args !== null, 'args must be an object');
    const entry = this.#entries.get(reducer);
    if (entry === undefined) {
      throw new LocalFirstError(
        'unknown reducer: pass a module export that also exists in the generated `reducers` map'
      );
    }
    if (this.log.pending.size >= INTENTS_PENDING_MAX) {
      throw new LocalFirstError(
        `too many pending intents (${INTENTS_PENDING_MAX}); connect and drain first`
      );
    }
    const nowMicros = this.#clock();
    const intentId = uuidV7(this.#rng, this.#uuidCounter, nowMicros);
    const clientTs = new Timestamp(nowMicros);
    const argsBsatn = this.#encodeArgs(entry, args, intentId, clientTs);

    const outcome = executeReducer(this.store, entry.innerFn, args, {
      sender: this.#identity,
      timestamp: clientTs,
      clientTimestamp: clientTs,
      connectionId: null,
      rng: this.#rng,
    });
    if (outcome.status === 'failed') throw outcome.error;
    if (outcome.status === 'unpredicted' && options.strict === true) throw outcome.error;

    const record = intentRecordFrom(entry, intentId, argsBsatn, nowMicros, outcome);
    return this.#enqueue(record, args, outcome);
  }

  #encodeArgs(entry: ReducerEntry, args: Row, intentId: Uuid, clientTs: Timestamp): Uint8Array {
    const fullArgs = entry.wrapped
      ? { ...args, [INTENT_ID_PARAM]: intentId, [CLIENT_TS_PARAM]: clientTs }
      : args;
    const writer = new BinaryWriter(256);
    entry.serialize(writer, fullArgs);
    const bytes = writer.getBuffer();
    if (bytes.length > INTENT_ARGS_BYTES_MAX) {
      throw new LocalFirstError(`reducer arguments exceed ${INTENT_ARGS_BYTES_MAX} bytes`);
    }
    return bytes;
  }

  #enqueue(record: IntentRecord, args: Row, outcome: ExecOutcome): CallHandle {
    const key = idKey(record.intentId);
    assert(!this.log.pending.has(key), 'duplicate intent id');
    this.#userArgs.set(key, args);
    this.#predictedNow.set(key, record.predicted);
    if (outcome.status === 'predicted') {
      const changed = this.store.applyToOverlay(outcome.writes);
      this.store.notify(changed);
    }
    const settled = new Promise<SettledStatus>(resolve => this.#settlers.set(key, resolve));
    const durable = this.log.append(record);
    durable.catch(() => undefined); // Surfaced through the handle; the intent stays in memory.
    this.#emit({ type: 'queued', intent: record, predicted: record.predicted });
    this.#drain();
    return { intentId: record.intentId, predicted: record.predicted, durable, settled };
  }

  // -------------------------------------------------------------- linking

  connect(link: Link): void {
    assert(!this.#closed, 'connect() on a closed LocalFirst');
    if (this.#link !== null) this.disconnect();
    this.#link = link;
    this.#linkGeneration += 1;
    if (link.identity !== undefined) this.#identity = link.identity;
    this.#linkUnsubscribes.push(
      link.events.onInitialState(tables => this.#onInitialState(tables)),
      link.events.onDelta((accessor, delta) => {
        if (!this.store.specs.has(accessor)) return;
        this.store.applyDelta(accessor, delta);
        this.#serverTsMicrosLast = this.#clock();
        this.#scheduleRebase();
        this.#scheduleSnapshot();
      })
    );
    this.#drainReady = this.#options.beforeDrain === undefined;
    if (this.#options.beforeDrain !== undefined) this.#runBeforeDrain(this.#options.beforeDrain);
    this.#drain();
  }

  #onInitialState(tables: Map<string, Row[]>): void {
    for (const [accessor, rows] of tables) {
      if (this.store.specs.has(accessor)) this.store.replaceBase(accessor, rows);
    }
    this.#serverTsMicrosLast = this.#clock();
    this.#scheduleRebase();
    this.#scheduleSnapshot();
    this.#drain();
  }

  #runBeforeDrain(hook: NonNullable<LocalFirstOptions['beforeDrain']>): void {
    const generation = this.#linkGeneration;
    Promise.resolve()
      .then(() => hook(this))
      .then(
        () => {
          if (generation !== this.#linkGeneration) return;
          this.#drainReady = true;
          this.#drain();
        },
        error =>
          console.warn('stdb-localfirst: beforeDrain failed; not sending until next connect', error)
      );
  }

  disconnect(): void {
    const link = this.#link;
    if (link === null) return;
    this.#link = null;
    this.#linkGeneration += 1;
    this.#drainReady = false;
    // Anything in flight is now unknown: it will be resent, and the server's
    // applied_intents table makes the resend a no-op if it already ran.
    this.#inflight.clear();
    for (const unsubscribe of this.#linkUnsubscribes) unsubscribe();
    this.#linkUnsubscribes = [];
    link.dispose();
    assert(this.#inflight.size === 0, 'inflight must be empty after disconnect');
  }

  // ------------------------------------------------------------- syncing

  /** Send pending intents in log order, at most `window` at a time. Bounded by pending count. */
  #drain(): void {
    const link = this.#link;
    if (link === null) return;
    if (this.#closed) return;
    if (!this.#drainReady) return;
    for (const record of this.log.pending.values()) {
      if (this.#inflight.size >= this.#window) break;
      const key = idKey(record.intentId);
      if (this.#inflight.has(key)) continue;
      this.#send(link, record);
    }
    assert(this.#inflight.size <= this.#window, 'inflight exceeds window');
  }

  #send(link: Link, record: IntentRecord): void {
    const key = idKey(record.intentId);
    this.#inflight.add(key);
    const generation = this.#linkGeneration;
    this.#emit({ type: 'sent', intent: record });
    link.transport.callReducer(record.reducerName, record.argsBsatn).then(
      () => {
        if (generation !== this.#linkGeneration) return;
        this.#onAcked(record);
      },
      error => {
        if (generation !== this.#linkGeneration) return;
        this.#onFailed(record, error);
      }
    );
  }

  #settle(record: IntentRecord, status: SettledStatus): void {
    const key = idKey(record.intentId);
    assert(!this.log.pending.has(key), 'settling an intent that is still pending');
    this.#inflight.delete(key);
    this.#userArgs.delete(key);
    this.#predictedNow.delete(key);
    const settler = this.#settlers.get(key);
    if (settler !== undefined) {
      this.#settlers.delete(key);
      settler(status);
    }
  }

  #onAcked(record: IntentRecord): void {
    if (!this.log.pending.has(idKey(record.intentId))) return;
    this.log
      .mark(record.intentId, 'acked')
      .catch(error => console.warn('stdb-localfirst: could not persist ack', error));
    this.#settle(record, 'acked');
    this.#emit({ type: 'acked', intent: record });
    this.#afterSettled();
  }

  #onFailed(record: IntentRecord, error: unknown): void {
    if (!this.log.pending.has(idKey(record.intentId))) return;
    const ordered = [...this.log.pending.values()];
    // Dependents already sent are the server's call now; only unsent ones are cancelled.
    const dependents = dependentsOf(record, ordered).filter(
      d => !this.#inflight.has(idKey(d.intentId))
    );
    const message = error instanceof Error ? error.message : String(error);
    this.log.mark(record.intentId, 'failed', message).catch(() => undefined);
    this.#settle(record, 'failed');
    for (const dependent of dependents) {
      this.log
        .mark(dependent.intentId, 'cancelled', `depends on failed intent ${record.intentId}`)
        .catch(() => undefined);
      this.#settle(dependent, 'cancelled');
      this.#emit({ type: 'cancelled', intent: dependent, because: record });
    }
    this.#emit({ type: 'failed', intent: record, error, cancelled: dependents });
    this.#afterSettled();
  }

  #afterSettled(): void {
    this.#scheduleRebase();
    const every = this.#options.compactEvery ?? COMPACT_EVERY_MARKS_DEFAULT;
    if (this.log.pending.size === 0 && this.log.marksSinceCompact >= every) {
      this.log.compact().catch(error => console.warn('stdb-localfirst: compaction failed', error));
    }
    this.#drain();
  }

  // -------------------------------------------------------------- rebase

  #scheduleRebase(): void {
    if (this.#rebaseScheduled) return;
    if (this.#closed) return;
    this.#rebaseScheduled = true;
    queueMicrotask(() => {
      this.#rebaseScheduled = false;
      if (!this.#closed) this.rebase();
    });
  }

  #argsFor(record: IntentRecord, entry: ReducerEntry): Row {
    const key = idKey(record.intentId);
    const cached = this.#userArgs.get(key);
    if (cached !== undefined) return cached;
    const full = entry.deserialize(new BinaryReader(record.argsBsatn));
    const { [INTENT_ID_PARAM]: _intentId, [CLIENT_TS_PARAM]: _clientTs, ...rest } = full;
    const args = entry.wrapped ? rest : full;
    this.#userArgs.set(key, args);
    return args;
  }

  /**
   * Throw the overlay away and replay every pending intent on top of base.
   * A replay that now throws is kept pending but unpredicted: the server
   * decides, the client just stops guessing.
   */
  rebase(): void {
    assert(this.log.pending.size <= REBASE_INTENTS_MAX, 'rebase over more intents than the bound');
    const changed = new Set(this.store.clearOverlay());
    let predicted = 0;
    let unpredicted = 0;
    for (const record of this.log.pending.values()) {
      const key = idKey(record.intentId);
      const entry = this.#entriesByAccessor.get(record.accessorName);
      const outcome = entry === undefined ? null : this.#replay(record, entry);
      if (outcome !== null && outcome.status === 'predicted') {
        for (const accessor of this.store.applyToOverlay(outcome.writes)) changed.add(accessor);
        this.#predictedNow.set(key, true);
        predicted += 1;
      } else {
        this.#predictedNow.set(key, false);
        unpredicted += 1;
      }
    }
    assert(
      predicted + unpredicted === this.log.pending.size,
      'rebase must visit every pending intent'
    );
    this.store.notify(changed);
    this.#emit({ type: 'rebase', predicted, unpredicted });
  }

  #replay(record: IntentRecord, entry: ReducerEntry): ExecOutcome {
    const timestamp = new Timestamp(record.clientTsMicros);
    return executeReducer(this.store, entry.innerFn, this.#argsFor(record, entry), {
      sender: this.#identity,
      timestamp,
      clientTimestamp: timestamp,
      connectionId: null,
      rng: this.#rng,
    });
  }

  // ------------------------------------------------------------ snapshot

  #scheduleSnapshot(): void {
    const debounce = this.#options.snapshotDebounceMs;
    if (debounce === null) return;
    const delayMs = debounce ?? SNAPSHOT_DEBOUNCE_MS_DEFAULT;
    const setTimer = this.#options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = this.#options.clearTimer ?? (handle => clearTimeout(handle as any));
    if (this.#snapshotTimer !== undefined) clearTimer(this.#snapshotTimer);
    this.#snapshotTimer = setTimer(() => {
      this.#snapshotTimer = undefined;
      this.snapshotNow().catch(error => console.warn('stdb-localfirst: snapshot failed', error));
    }, delayMs);
  }

  /** Write the base layer to disk now. */
  async snapshotNow(): Promise<SnapshotMeta> {
    assert(!this.#closed, 'snapshotNow() on a closed LocalFirst');
    const tables = new Map<string, Iterable<Row>>();
    for (const accessor of this.#accessors) tables.set(accessor, this.store.baseRows(accessor));
    return this.#snapshot.save(tables, {
      serverTsMicros: this.#serverTsMicrosLast,
      workingSetHash: this.#workingSetHash,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const clearTimer = this.#options.clearTimer ?? (handle => clearTimeout(handle as any));
    if (this.#snapshotTimer !== undefined) clearTimer(this.#snapshotTimer);
    this.disconnect();
    await this.log.flush();
    const release = this.#releaseLock;
    this.#releaseLock = null;
    if (release !== null) await release();
    assert(this.#link === null, 'link must be gone after close');
  }
}

// ------------------------------------------------------------------ helpers

function workingSetText(workingSet: WorkingSet): string {
  if (typeof workingSet.queries === 'function') return workingSet.queries.toString();
  return workingSet.queries.join('\n');
}

async function acquireLock(storage: StorageAdapter): Promise<(() => Promise<void>) | null> {
  if (storage.lock === undefined) return null;
  const release = await storage.lock();
  if (release === null) {
    throw new LocalFirstError(
      'storage is locked by another LocalFirst instance (another tab or process)'
    );
  }
  return release;
}

function intentRecordFrom(
  entry: ReducerEntry,
  intentId: Uuid,
  argsBsatn: Uint8Array,
  clientTsMicros: bigint,
  outcome: ExecOutcome
): IntentRecord {
  assert(outcome.status !== 'failed', 'failed outcomes never become intents');
  const predicted = outcome.status === 'predicted';
  return {
    intentId,
    reducerName: entry.name,
    accessorName: entry.accessorName,
    argsBsatn,
    clientTsMicros,
    predicted,
    readSet: predicted ? [...outcome.readSet] : [],
    writeSet: predicted ? [...outcome.writeSet] : [],
  };
}

/** Read-only merged view (`lf.db`): iter/count plus find/filter per index. */
function buildReadView(store: LocalStore, accessors: string[]): Record<string, any> {
  const view: Record<string, any> = Object.create(null);
  for (const accessor of accessors) {
    const spec = store.spec(accessor);
    const table: Record<string, any> = {
      iter: () => store.iter(accessor),
      [Symbol.iterator]: () => store.iter(accessor),
      count: () => BigInt(store.count(accessor)),
    };
    for (const index of spec.indexes) {
      const indexKey = (row: Row): unknown[] => index.columns.map(column => row[column]);
      if (index.unique) {
        table[index.name] = Object.freeze({
          find: (columnValue: unknown): Row | null => {
            const expected = Array.isArray(columnValue) ? columnValue : [columnValue];
            if (index.isPrimaryKey) {
              const pk = assertDefined(spec.primaryKey, 'pk index without pk');
              return store.get(accessor, spec.rowKey({ [pk]: expected[0] })) ?? null;
            }
            for (const row of store.iter(accessor))
              if (deepEqual(indexKey(row), expected)) return row;
            return null;
          },
        });
      } else {
        table[index.name] = Object.freeze({
          *filter(range: unknown): IterableIterator<Row> {
            for (const row of store.iter(accessor)) if (matchRange(indexKey(row), range)) yield row;
          },
        });
      }
    }
    view[accessor] = Object.freeze(table);
  }
  return Object.freeze(view);
}
