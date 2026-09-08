import { errors } from 'spacetimedb/server';
import { assert, assertDefined } from '../shared/assert';
import { READ_SET_ENTRIES_MAX, TABLES_MAX, WRITE_SET_ENTRIES_MAX } from '../shared/limits';
import { deepEqual, matchRange } from './compare';
import { CacheMissError, UnpredictableError } from './errors';

/** SDK host errors are Error subclasses at runtime; the declaration file hides that. */
function hostError(error: unknown): Error {
  assert(error instanceof Error, 'SDK host error is not an Error');
  return error;
}
import type { IndexSpec, Key, Row, TableSpec } from './table_spec';

export const TOMBSTONE: unique symbol = Symbol('tombstone');
export type Layer = Map<Key, Row | typeof TOMBSTONE>;
export type Coverage = 'full' | 'partial';
export type StagedWrites = Map<string, Layer>;

export interface TxResult {
  writes: StagedWrites;
  readSet: Set<string>;
  writeSet: Set<string>;
}

export interface Delta {
  inserts: Row[];
  deletes: Row[];
}

export type StoreListener = (changed: ReadonlySet<string>) => void;

export interface LocalStoreOptions {
  /** Coverage of a table by the working set. Defaults to `full`. */
  coverage?: (accessor: string) => Coverage;
  /** If true, `clear()` and auto-increment inserts are allowed (server mode). */
  authoritative?: boolean;
}

/** Store key for a spec: `<namespace>.<accessor>` for submodule tables, else the accessor. */
export const specKey = (spec: TableSpec): string =>
  spec.namespace ? `${spec.namespace}.${spec.accessorName}` : spec.accessorName;

/** Dependency-tracking key for one row of one table. */
export const keyString = (table: string, key: Key): string =>
  `${table}:${typeof key === 'bigint' ? key.toString() + 'n' : String(key)}`;

/** Dependency-tracking key for "any row of this table". */
export const scanKey = (table: string): string => `${table}:*`;

/**
 * Two layers of rows per table:
 *  - base: exactly what the server last told us (or the loaded snapshot),
 *  - overlay: rows produced by unacknowledged local intents.
 *
 * Reads see overlay over base. Server updates go to base; the overlay is thrown
 * away and rebuilt by replaying pending intents (rebase). A transaction (`begin`)
 * stages writes on top of both and only lands in the overlay on commit.
 *
 * Counts are maintained per layer so `count()` is O(overlay), never O(rows).
 */
export class LocalStore {
  readonly specs = new Map<string, TableSpec>();
  #base = new Map<string, Map<Key, Row>>();
  #overlay = new Map<string, Layer>();
  #listeners = new Set<StoreListener>();
  #coverage: (accessor: string) => Coverage;
  #authoritative: boolean;
  version = 0;

  constructor(specs: Iterable<TableSpec>, options: LocalStoreOptions = {}) {
    for (const spec of specs) {
      const key = specKey(spec);
      assert(!this.specs.has(key), `duplicate table ${key}`);
      assert(this.specs.size < TABLES_MAX, `more than ${TABLES_MAX} tables`);
      this.specs.set(key, spec);
      this.#base.set(key, new Map());
      this.#overlay.set(key, new Map());
    }
    assert(this.specs.size > 0, 'a store needs at least one table');
    this.#coverage = options.coverage ?? (() => 'full');
    this.#authoritative = options.authoritative ?? false;
  }

  spec(table: string): TableSpec {
    return assertDefined(this.specs.get(table), `unknown table ${table}`);
  }

  get tableNames(): string[] {
    return [...this.specs.keys()];
  }

  get authoritative(): boolean {
    return this.#authoritative;
  }

  coverage(table: string): Coverage {
    assert(this.specs.has(table), `coverage of unknown table ${table}`);
    return this.#coverage(table);
  }

  #baseOf(table: string): Map<Key, Row> {
    return assertDefined(this.#base.get(table), `no base layer for ${table}`);
  }

  #overlayOf(table: string): Layer {
    return assertDefined(this.#overlay.get(table), `no overlay layer for ${table}`);
  }

  // ---------------------------------------------------------------- reads

  /** Merged lookup: overlay wins over base. `undefined` = not present. */
  get(table: string, key: Key): Row | undefined {
    const overlaid = this.#overlayOf(table).get(key);
    if (overlaid !== undefined) return overlaid === TOMBSTONE ? undefined : overlaid;
    return this.#baseOf(table).get(key);
  }

  /** Merged rows without copying: base rows not shadowed, then overlay rows. */
  *iter(table: string): IterableIterator<Row> {
    const base = this.#baseOf(table);
    const overlay = this.#overlayOf(table);
    for (const [key, row] of base) {
      if (!overlay.has(key)) yield row;
    }
    for (const value of overlay.values()) {
      if (value !== TOMBSTONE) yield value;
    }
  }

  count(table: string): number {
    const base = this.#baseOf(table);
    let count = base.size;
    for (const [key, value] of this.#overlayOf(table)) {
      const inBase = base.has(key);
      if (value === TOMBSTONE) {
        if (inBase) count -= 1;
      } else if (!inBase) {
        count += 1;
      }
    }
    assert(count >= 0, 'negative row count');
    return count;
  }

  baseRows(table: string): Row[] {
    return [...this.#baseOf(table).values()];
  }

  hasOverlay(): boolean {
    for (const layer of this.#overlay.values()) if (layer.size > 0) return true;
    return false;
  }

  // --------------------------------------------------------- base updates

  replaceBase(table: string, rows: Iterable<Row>): void {
    const spec = this.spec(table);
    const next = new Map<Key, Row>();
    for (const row of rows) next.set(spec.rowKey(row), row);
    this.#base.set(table, next);
    this.notify([table]);
  }

  applyDelta(table: string, delta: Delta): void {
    const spec = this.spec(table);
    const base = this.#baseOf(table);
    for (const row of delta.deletes) base.delete(spec.rowKey(row));
    for (const row of delta.inserts) base.set(spec.rowKey(row), row);
    this.notify([table]);
  }

  /**
   * Authoritative commit: apply staged writes straight to base and return the
   * resulting per-table delta. Used by the server side of the test harness.
   */
  commitToBase(writes: StagedWrites): Map<string, Delta> {
    assert(this.#authoritative, 'commitToBase requires an authoritative store');
    const deltas = new Map<string, Delta>();
    for (const [table, layer] of writes) {
      const base = this.#baseOf(table);
      const delta: Delta = { inserts: [], deletes: [] };
      for (const [key, value] of layer) {
        const old = base.get(key);
        if (old !== undefined) delta.deletes.push(old);
        if (value === TOMBSTONE) {
          base.delete(key);
        } else {
          delta.inserts.push(value);
          base.set(key, value);
        }
      }
      if (delta.inserts.length > 0 || delta.deletes.length > 0) deltas.set(table, delta);
    }
    this.notify([...deltas.keys()]);
    return deltas;
  }

  // ------------------------------------------------------ overlay updates

  clearOverlay(): string[] {
    const changed: string[] = [];
    for (const [table, layer] of this.#overlay) {
      if (layer.size === 0) continue;
      layer.clear();
      changed.push(table);
    }
    return changed;
  }

  applyToOverlay(writes: StagedWrites): string[] {
    const changed: string[] = [];
    for (const [table, layer] of writes) {
      if (layer.size === 0) continue;
      const overlay = this.#overlayOf(table);
      for (const [key, value] of layer) overlay.set(key, value);
      changed.push(table);
    }
    return changed;
  }

  // ------------------------------------------------------------- events

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Listener exceptions are isolated: one bad UI subscriber must not stop the sync engine. */
  notify(changed: Iterable<string>): void {
    const set = new Set(changed);
    if (set.size === 0) return;
    this.version += 1;
    for (const listener of this.#listeners) {
      try {
        listener(set);
      } catch (error) {
        console.error('worldline: store listener threw', error);
      }
    }
  }

  // -------------------------------------------------------- transactions

  begin(): Transaction {
    return new Transaction(this);
  }
}

/**
 * A staged transaction. Provides the `ctx.db` object a reducer body sees. Reads
 * resolve staged -> overlay -> base; writes are staged until `commit()`.
 *
 * Read and write sets are bounded: past the bound a table's reads collapse to
 * a scan key, which is always a superset and therefore still safe for
 * dependency tracking.
 */
export class Transaction {
  readonly staged: StagedWrites = new Map();
  readonly readSet = new Set<string>();
  readonly writeSet = new Set<string>();
  readonly db: Record<string, any>;
  readonly store: LocalStore;
  #open = true;

  constructor(store: LocalStore) {
    this.store = store;
    this.db = buildDbView(this);
  }

  get open(): boolean {
    return this.#open;
  }

  assertOpen(): void {
    assert(this.#open, 'transaction is closed');
  }

  layer(table: string): Layer {
    let layer = this.staged.get(table);
    if (layer === undefined) {
      layer = new Map();
      this.staged.set(table, layer);
    }
    return layer;
  }

  recordRead(table: string, key: Key | null): void {
    if (key === null || this.readSet.size >= READ_SET_ENTRIES_MAX) {
      this.readSet.add(scanKey(table));
      return;
    }
    this.readSet.add(keyString(table, key));
  }

  recordWrite(table: string, key: Key): void {
    if (this.writeSet.size >= WRITE_SET_ENTRIES_MAX) {
      this.writeSet.add(scanKey(table));
      return;
    }
    this.writeSet.add(keyString(table, key));
  }

  /** staged -> overlay -> base */
  lookup(table: string, key: Key): Row | undefined {
    const stagedValue = this.staged.get(table)?.get(key);
    if (stagedValue !== undefined) return stagedValue === TOMBSTONE ? undefined : stagedValue;
    return this.store.get(table, key);
  }

  /** Rows visible to the transaction, without copying the layers. */
  *iterView(table: string): IterableIterator<Row> {
    const staged = this.staged.get(table);
    for (const row of this.store.iter(table)) {
      if (staged === undefined || !staged.has(this.store.spec(table).rowKey(row))) yield row;
    }
    if (staged === undefined) return;
    for (const value of staged.values()) {
      if (value !== TOMBSTONE) yield value;
    }
  }

  countView(table: string): number {
    let count = this.store.count(table);
    const staged = this.staged.get(table);
    if (staged === undefined) return count;
    for (const [key, value] of staged) {
      const visibleBelow = this.store.get(table, key) !== undefined;
      if (value === TOMBSTONE) {
        if (visibleBelow) count -= 1;
      } else if (!visibleBelow) {
        count += 1;
      }
    }
    assert(count >= 0, 'negative view count');
    return count;
  }

  commit(): TxResult {
    this.assertOpen();
    this.#open = false;
    return { writes: this.staged, readSet: this.readSet, writeSet: this.writeSet };
  }

  rollback(): void {
    this.assertOpen();
    this.#open = false;
  }
}

// ------------------------------------------------------------ ctx.db views

function buildDbView(tx: Transaction): Record<string, any> {
  const db: Record<string, any> = Object.create(null);
  const namespaces = new Map<string, Record<string, unknown>>();
  for (const spec of tx.store.specs.values()) {
    const view = buildTableView(tx, spec);
    if (spec.namespace === undefined) {
      Object.defineProperty(db, spec.accessorName, { enumerable: true, value: view });
      continue;
    }
    let namespace = namespaces.get(spec.namespace);
    if (namespace === undefined) {
      namespace = Object.create(null) as Record<string, unknown>;
      namespaces.set(spec.namespace, namespace);
    }
    Object.defineProperty(namespace, spec.accessorName, { enumerable: true, value: view });
  }
  for (const [alias, namespace] of namespaces) {
    Object.defineProperty(db, alias, { enumerable: true, value: Object.freeze(namespace) });
  }
  return Object.freeze(db);
}

function buildTableView(tx: Transaction, spec: TableSpec): Record<string, unknown> {
  const table = specKey(spec);
  const iter = function* (): IterableIterator<Row> {
    tx.recordRead(table, null);
    yield* [...tx.iterView(table)];
  };
  const view: Record<string, unknown> = {
    insert: (row: Row) => tableInsert(tx, spec, row),
    delete: (row: Row) => tableDelete(tx, spec, row),
    clear: () => tableClear(tx, spec),
    count: () => {
      tx.recordRead(table, null);
      return BigInt(tx.countView(table));
    },
    iter,
    [Symbol.iterator]: iter,
  };
  for (const index of spec.indexes) {
    view[index.name] = index.unique
      ? buildUniqueIndex(tx, spec, index)
      : buildRangedIndex(tx, spec, index);
  }
  return Object.freeze(view);
}

/** Throw the host's error class if `row` collides with an existing row on any unique column set. */
function assertUnique(
  tx: Transaction,
  spec: TableSpec,
  row: Row,
  ignoreKey: Key | undefined
): void {
  const table = specKey(spec);
  for (const columns of spec.uniqueColumnSets) {
    const isPrimaryKey = columns.length === 1 && columns[0] === spec.primaryKey;
    if (isPrimaryKey) {
      const key = spec.rowKey(row);
      if (key !== ignoreKey && tx.lookup(table, key) !== undefined) {
        throw hostError(new errors.UniqueAlreadyExists(uniqueMessage(spec, columns)));
      }
      continue;
    }
    for (const existing of tx.iterView(table)) {
      if (ignoreKey !== undefined && spec.rowKey(existing) === ignoreKey) continue;
      if (columns.every(column => deepEqual(existing[column], row[column]))) {
        throw hostError(new errors.UniqueAlreadyExists(uniqueMessage(spec, columns)));
      }
    }
  }
}

const uniqueMessage = (spec: TableSpec, columns: readonly string[]): string =>
  `unique constraint violation on ${spec.sourceName}(${columns.join(',')})`;

/** Auto-increment columns are server-assigned; only the authoritative store may fill them. */
function fillAutoIncrement(tx: Transaction, spec: TableSpec, row: Row): Row {
  let filled = row;
  for (const auto of spec.autoInc) {
    if (row[auto.column] !== auto.sentinel) continue;
    if (!tx.store.authoritative) {
      throw new UnpredictableError(
        'auto-increment',
        `${spec.sourceName}.${auto.column} relies on a server-assigned auto-increment id; ` +
          `offline-capable rows must carry a client-chosen key`
      );
    }
    let max = 0n;
    for (const existing of tx.iterView(specKey(spec))) {
      const value = BigInt(existing[auto.column]);
      if (value > max) max = value;
    }
    const next = max + 1n;
    filled = { ...filled, [auto.column]: typeof auto.sentinel === 'bigint' ? next : Number(next) };
  }
  return filled;
}

function tableInsert(tx: Transaction, spec: TableSpec, row: Row): Row {
  tx.assertOpen();
  assert(typeof row === 'object' && row !== null, 'insert expects a row object');
  const table = specKey(spec);
  const filled = fillAutoIncrement(tx, spec, row);
  assertUnique(tx, spec, filled, undefined);
  const key = spec.rowKey(filled);
  tx.layer(table).set(key, filled);
  tx.recordWrite(table, key);
  assert(tx.lookup(table, key) === filled, 'inserted row must be visible to the transaction');
  return { ...filled };
}

function tableDelete(tx: Transaction, spec: TableSpec, row: Row): boolean {
  tx.assertOpen();
  const table = specKey(spec);
  const key = spec.rowKey(row);
  const existing = tx.lookup(table, key);
  tx.recordRead(table, key);
  if (existing === undefined) return false;
  if (!deepEqual(existing, row)) return false;
  tx.layer(table).set(key, TOMBSTONE);
  tx.recordWrite(table, key);
  assert(tx.lookup(table, key) === undefined, 'deleted row must be invisible to the transaction');
  return true;
}

function tableClear(tx: Transaction, spec: TableSpec): bigint {
  tx.assertOpen();
  const table = specKey(spec);
  if (!tx.store.authoritative) {
    throw new UnpredictableError(
      'clear',
      `${spec.sourceName}.clear() cannot be predicted over a partial cache`
    );
  }
  const keys = [...tx.iterView(table)].map(row => spec.rowKey(row));
  for (const key of keys) {
    tx.layer(table).set(key, TOMBSTONE);
    tx.recordWrite(table, key);
  }
  assert(tx.countView(table) === 0, 'table must be empty after clear');
  return BigInt(keys.length);
}

/** Unique index: `find`, `delete`, and `update` when it is the primary key. */
function buildUniqueIndex(
  tx: Transaction,
  spec: TableSpec,
  index: IndexSpec
): Record<string, unknown> {
  const table = specKey(spec);
  const find = (columnValue: unknown): Row | null => uniqueFind(tx, spec, index, columnValue);
  const view: Record<string, unknown> = {
    find,
    delete: (columnValue: unknown): boolean => {
      tx.assertOpen();
      let row: Row | null;
      try {
        row = find(columnValue);
      } catch (error) {
        if (error instanceof CacheMissError) return false;
        throw error;
      }
      if (row === null) return false;
      const key = spec.rowKey(row);
      tx.layer(table).set(key, TOMBSTONE);
      tx.recordWrite(table, key);
      return true;
    },
  };
  if (index.isPrimaryKey) {
    view.update = (row: Row): Row => primaryKeyUpdate(tx, spec, row);
  }
  return Object.freeze(view);
}

function uniqueFind(
  tx: Transaction,
  spec: TableSpec,
  index: IndexSpec,
  columnValue: unknown
): Row | null {
  const table = specKey(spec);
  const expected = Array.isArray(columnValue) ? columnValue : [columnValue];
  assert(
    expected.length === index.columns.length,
    `index ${index.name} expects ${index.columns.length} values`
  );
  const partial = tx.store.coverage(table) === 'partial';
  if (index.isPrimaryKey) {
    const key = spec.rowKey({
      [assertDefined(spec.primaryKey, 'pk index without pk')]: expected[0],
    });
    tx.recordRead(table, key);
    const row = tx.lookup(table, key);
    if (row !== undefined) return row;
    if (partial) throw new CacheMissError(spec.sourceName, keyString(table, key));
    return null;
  }
  tx.recordRead(table, null);
  for (const row of tx.iterView(table)) {
    if (
      deepEqual(
        index.columns.map(column => row[column]),
        expected
      )
    )
      return row;
  }
  if (partial) throw new CacheMissError(spec.sourceName, `${index.name}=${String(expected)}`);
  return null;
}

function primaryKeyUpdate(tx: Transaction, spec: TableSpec, row: Row): Row {
  tx.assertOpen();
  const table = specKey(spec);
  const key = spec.rowKey(row);
  tx.recordRead(table, key);
  const existing = tx.lookup(table, key);
  if (existing === undefined) {
    if (tx.store.coverage(table) === 'partial')
      throw new CacheMissError(spec.sourceName, keyString(table, key));
    const pk = assertDefined(spec.primaryKey, 'update without primary key');
    throw hostError(
      new errors.NoSuchRow(
        `update: no row with primary key ${String(row[pk])} in ${spec.sourceName}`
      )
    );
  }
  assertUnique(tx, spec, row, key);
  tx.layer(table).set(key, row);
  tx.recordWrite(table, key);
  return { ...row };
}

/** Ranged (or point) index: `filter` and `delete` by range. */
function buildRangedIndex(
  tx: Transaction,
  spec: TableSpec,
  index: IndexSpec
): Record<string, unknown> {
  const table = specKey(spec);
  const indexKey = (row: Row): unknown[] => index.columns.map(column => row[column]);
  const filter = function* (range: unknown): IterableIterator<Row> {
    tx.recordRead(table, null);
    for (const row of [...tx.iterView(table)]) {
      if (matchRange(indexKey(row), range)) yield row;
    }
  };
  return Object.freeze({
    filter,
    delete: (range: unknown): number => {
      tx.assertOpen();
      const matched = [...filter(range)];
      for (const row of matched) {
        const key = spec.rowKey(row);
        tx.layer(table).set(key, TOMBSTONE);
        tx.recordWrite(table, key);
      }
      return matched.length;
    },
  });
}
