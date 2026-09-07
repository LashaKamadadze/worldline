import { errors } from 'spacetimedb/server';
import { deepEqual, matchRange } from './compare';
import { CacheMissError, UnpredictableError } from './errors';
import type { Key, Row, TableSpec } from './table_spec';

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
export const specKey = (s: TableSpec): string =>
  s.namespace ? `${s.namespace}.${s.accessorName}` : s.accessorName;

export const keyString = (accessor: string, key: Key): string =>
  `${accessor}:${typeof key === 'bigint' ? key.toString() + 'n' : String(key)}`;

/**
 * Two layers of rows per table:
 *  - base: exactly what the server last told us (or the loaded snapshot),
 *  - overlay: rows produced by unacknowledged local intents.
 *
 * Reads see overlay over base. Server updates go to base; the overlay is thrown
 * away and rebuilt by replaying pending intents (rebase). A transaction (`begin`)
 * stages writes on top of both and only lands in the overlay on commit.
 */
export class LocalStore {
  readonly specs = new Map<string, TableSpec>();
  #base = new Map<string, Map<Key, Row>>();
  #overlay = new Map<string, Layer>();
  #listeners = new Set<StoreListener>();
  #coverage: (accessor: string) => Coverage;
  #authoritative: boolean;
  version = 0;

  constructor(specs: Iterable<TableSpec>, opts: LocalStoreOptions = {}) {
    for (const s of specs) {
      const k = specKey(s);
      if (this.specs.has(k)) throw new Error(`duplicate table ${k}`);
      this.specs.set(k, s);
      this.#base.set(k, new Map());
      this.#overlay.set(k, new Map());
    }
    this.#coverage = opts.coverage ?? (() => 'full');
    this.#authoritative = opts.authoritative ?? false;
  }

  spec(accessor: string): TableSpec {
    const s = this.specs.get(accessor);
    if (!s) throw new Error(`unknown table ${accessor}`);
    return s;
  }

  get tableNames(): string[] {
    return [...this.specs.keys()];
  }

  // ---------------------------------------------------------------- reads

  /** Merged lookup: overlay wins over base. `undefined` = not present. */
  get(accessor: string, key: Key): Row | undefined {
    const o = this.#overlay.get(accessor)!.get(key);
    if (o !== undefined) return o === TOMBSTONE ? undefined : o;
    return this.#base.get(accessor)!.get(key);
  }

  /** Merged view as a fresh map (overlay applied over base). */
  merged(accessor: string): Map<Key, Row> {
    const out = new Map(this.#base.get(accessor)!);
    for (const [k, v] of this.#overlay.get(accessor)!) {
      if (v === TOMBSTONE) out.delete(k);
      else out.set(k, v);
    }
    return out;
  }

  *iter(accessor: string): IterableIterator<Row> {
    yield* this.merged(accessor).values();
  }

  count(accessor: string): number {
    return this.merged(accessor).size;
  }

  baseRows(accessor: string): Row[] {
    return [...this.#base.get(accessor)!.values()];
  }

  hasOverlay(): boolean {
    for (const l of this.#overlay.values()) if (l.size > 0) return true;
    return false;
  }

  // --------------------------------------------------------- base updates

  replaceBase(accessor: string, rows: Iterable<Row>): void {
    const spec = this.spec(accessor);
    const m = new Map<Key, Row>();
    for (const r of rows) m.set(spec.rowKey(r), r);
    this.#base.set(accessor, m);
    this.#bump([accessor]);
  }

  applyDelta(accessor: string, delta: Delta): void {
    const spec = this.spec(accessor);
    const m = this.#base.get(accessor)!;
    for (const r of delta.deletes) m.delete(spec.rowKey(r));
    for (const r of delta.inserts) m.set(spec.rowKey(r), r);
    this.#bump([accessor]);
  }

  /**
   * Authoritative commit: apply staged writes straight to base and return the
   * resulting per-table delta. Used by the server side of the test harness.
   */
  commitToBase(writes: StagedWrites): Map<string, Delta> {
    const deltas = new Map<string, Delta>();
    for (const [accessor, layer] of writes) {
      const m = this.#base.get(accessor)!;
      const d: Delta = { inserts: [], deletes: [] };
      for (const [k, v] of layer) {
        const old = m.get(k);
        if (v === TOMBSTONE) {
          if (old !== undefined) {
            d.deletes.push(old);
            m.delete(k);
          }
        } else {
          if (old !== undefined) d.deletes.push(old);
          d.inserts.push(v);
          m.set(k, v);
        }
      }
      if (d.inserts.length || d.deletes.length) deltas.set(accessor, d);
    }
    this.#bump([...deltas.keys()]);
    return deltas;
  }

  // ------------------------------------------------------ overlay updates

  clearOverlay(): string[] {
    const changed: string[] = [];
    for (const [acc, layer] of this.#overlay) {
      if (layer.size) {
        layer.clear();
        changed.push(acc);
      }
    }
    return changed;
  }

  applyToOverlay(writes: StagedWrites): string[] {
    const changed: string[] = [];
    for (const [accessor, layer] of writes) {
      const o = this.#overlay.get(accessor)!;
      for (const [k, v] of layer) o.set(k, v);
      if (layer.size) changed.push(accessor);
    }
    return changed;
  }

  // ------------------------------------------------------------- events

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(changed: Iterable<string>): void {
    const set = new Set(changed);
    if (!set.size) return;
    this.version++;
    for (const l of this.#listeners) l(set);
  }

  #bump(changed: string[]) {
    this.notify(changed);
  }

  // -------------------------------------------------------- transactions

  begin(): Transaction {
    return new Transaction(this, this.#coverage, this.#authoritative);
  }
}

/**
 * A staged transaction. Provides the `ctx.db` object a reducer body sees. Reads
 * resolve staged -> overlay -> base; writes are staged until `commit()`.
 */
export class Transaction {
  readonly staged: StagedWrites = new Map();
  readonly readSet = new Set<string>();
  readonly writeSet = new Set<string>();
  readonly db: Record<string, any>;
  #store: LocalStore;
  #coverage: (accessor: string) => Coverage;
  #authoritative: boolean;
  #open = true;

  constructor(
    store: LocalStore,
    coverage: (accessor: string) => Coverage,
    authoritative: boolean
  ) {
    this.#store = store;
    this.#coverage = coverage;
    this.#authoritative = authoritative;
    const db: Record<string, any> = Object.create(null);
    const namespaces = new Map<string, Record<string, any>>();
    for (const spec of store.specs.values()) {
      const view = this.#tableView(spec);
      if (spec.namespace) {
        let ns = namespaces.get(spec.namespace);
        if (!ns) {
          ns = Object.create(null) as Record<string, any>;
          namespaces.set(spec.namespace, ns);
        }
        Object.defineProperty(ns, spec.accessorName, { enumerable: true, value: view });
      } else {
        Object.defineProperty(db, spec.accessorName, { enumerable: true, value: view });
      }
    }
    for (const [alias, ns] of namespaces) {
      Object.defineProperty(db, alias, { enumerable: true, value: Object.freeze(ns) });
    }
    this.db = Object.freeze(db);
  }

  #assertOpen() {
    if (!this.#open) throw new Error('transaction is closed');
  }

  #layer(accessor: string): Layer {
    let l = this.staged.get(accessor);
    if (!l) {
      l = new Map();
      this.staged.set(accessor, l);
    }
    return l;
  }

  /** staged -> overlay -> base */
  lookup(accessor: string, key: Key): Row | undefined {
    const s = this.staged.get(accessor)?.get(key);
    if (s !== undefined) return s === TOMBSTONE ? undefined : s;
    return this.#store.get(accessor, key);
  }

  view(accessor: string): Map<Key, Row> {
    const out = this.#store.merged(accessor);
    const s = this.staged.get(accessor);
    if (s) {
      for (const [k, v] of s) {
        if (v === TOMBSTONE) out.delete(k);
        else out.set(k, v);
      }
    }
    return out;
  }

  commit(): TxResult {
    this.#assertOpen();
    this.#open = false;
    return { writes: this.staged, readSet: this.readSet, writeSet: this.writeSet };
  }

  rollback(): void {
    this.#open = false;
  }

  // ---- the ctx.db table object ----

  #tableView(spec: TableSpec): any {
    const acc = specKey(spec);
    const tx = this;

    const checkUnique = (row: Row, ignoreKey?: Key) => {
      const view = tx.view(acc);
      for (const cols of spec.uniqueColumnSets) {
        for (const [k, existing] of view) {
          if (ignoreKey !== undefined && k === ignoreKey) continue;
          if (cols.every(c => deepEqual(existing[c], row[c]))) {
            throw new errors.UniqueAlreadyExists(
              `unique constraint violation on ${spec.sourceName}(${cols.join(',')})`
            );
          }
        }
      }
    };

    const insert = (row: Row): Row => {
      tx.#assertOpen();
      for (const ai of spec.autoInc) {
        if (row[ai.column] === ai.sentinel) {
          if (!tx.#authoritative) {
            throw new UnpredictableError(
              'auto-increment',
              `${spec.sourceName}.${ai.column} relies on a server-assigned auto-increment id; ` +
                `offline-capable rows must carry a client-chosen key`
            );
          }
          // Authoritative (test-server) mode: assign the next id.
          let max: bigint = 0n;
          for (const r of tx.view(acc).values()) {
            const v = BigInt(r[ai.column]);
            if (v > max) max = v;
          }
          row = { ...row, [ai.column]: typeof ai.sentinel === 'bigint' ? max + 1n : Number(max + 1n) };
        }
      }
      checkUnique(row);
      const key = spec.rowKey(row);
      tx.#layer(acc).set(key, row);
      tx.writeSet.add(keyString(acc, key));
      return { ...row };
    };

    const deleteRow = (row: Row): boolean => {
      tx.#assertOpen();
      const key = spec.rowKey(row);
      const existing = tx.lookup(acc, key);
      tx.readSet.add(keyString(acc, key));
      if (existing === undefined || !deepEqual(existing, row)) return false;
      tx.#layer(acc).set(key, TOMBSTONE);
      tx.writeSet.add(keyString(acc, key));
      return true;
    };

    const clear = (): bigint => {
      tx.#assertOpen();
      if (!tx.#authoritative) {
        throw new UnpredictableError('clear', `${spec.sourceName}.clear() cannot be predicted over a partial cache`);
      }
      const view = tx.view(acc);
      for (const k of view.keys()) {
        tx.#layer(acc).set(k, TOMBSTONE);
        tx.writeSet.add(keyString(acc, k));
      }
      return BigInt(view.size);
    };

    const iter = function* (): IterableIterator<Row> {
      tx.readSet.add(`${acc}:*`);
      yield* [...tx.view(acc).values()];
    };

    const table: Record<string, any> = {
      insert,
      delete: deleteRow,
      clear,
      count: () => {
        tx.readSet.add(`${acc}:*`);
        return BigInt(tx.view(acc).size);
      },
      iter,
      [Symbol.iterator]: iter,
    };

    for (const idx of spec.indexes) {
      table[idx.name] = this.#indexView(spec, idx, insert, checkUnique);
    }
    return Object.freeze(table);
  }

  #indexView(
    spec: TableSpec,
    idx: any,
    _insert: (row: Row) => Row,
    checkUnique: (row: Row, ignoreKey?: Key) => void
  ): any {
    const acc = specKey(spec);
    const tx = this;
    const getKey = (row: Row) => idx.columns.map((c: string) => row[c]);
    const partial = () => tx.#coverage(acc) === 'partial';

    if (idx.unique) {
      const find = (colVal: any): Row | null => {
        const expected = Array.isArray(colVal) ? colVal : [colVal];
        if (idx.isPrimaryKey) {
          const key = spec.rowKey({ [spec.primaryKey!]: expected[0] });
          tx.readSet.add(keyString(acc, key));
          const row = tx.lookup(acc, key);
          if (row === undefined) {
            if (partial()) throw new CacheMissError(spec.sourceName, keyString(acc, key));
            return null;
          }
          return row;
        }
        tx.readSet.add(`${acc}:*`);
        for (const row of tx.view(acc).values()) {
          if (deepEqual(getKey(row), expected)) return row;
        }
        if (partial()) throw new CacheMissError(spec.sourceName, `${idx.name}=${String(expected)}`);
        return null;
      };
      const del = (colVal: any): boolean => {
        tx.#assertOpen();
        let row: Row | null;
        try {
          row = find(colVal);
        } catch (e) {
          if (e instanceof CacheMissError) return false;
          throw e;
        }
        if (!row) return false;
        const key = spec.rowKey(row);
        tx.#layer(acc).set(key, TOMBSTONE);
        tx.writeSet.add(keyString(acc, key));
        return true;
      };
      const view: Record<string, any> = { find, delete: del };
      if (idx.isPrimaryKey) {
        view.update = (row: Row): Row => {
          tx.#assertOpen();
          const key = spec.rowKey(row);
          tx.readSet.add(keyString(acc, key));
          const existing = tx.lookup(acc, key);
          if (existing === undefined) {
            if (partial()) throw new CacheMissError(spec.sourceName, keyString(acc, key));
            throw new errors.NoSuchRow(`update: no row with primary key ${String(row[spec.primaryKey!])} in ${spec.sourceName}`);
          }
          checkUnique(row, key);
          tx.#layer(acc).set(key, row);
          tx.writeSet.add(keyString(acc, key));
          return { ...row };
        };
      }
      return Object.freeze(view);
    }

    const filter = function* (range: any): IterableIterator<Row> {
      tx.readSet.add(`${acc}:*`);
      for (const row of [...tx.view(acc).values()]) {
        if (matchRange(getKey(row), range)) yield row;
      }
    };
    const del = (range: any): number => {
      tx.#assertOpen();
      let n = 0;
      for (const row of [...filter(range)]) {
        const key = spec.rowKey(row);
        tx.#layer(acc).set(key, TOMBSTONE);
        tx.writeSet.add(keyString(acc, key));
        n++;
      }
      return n;
    };
    return Object.freeze({ filter, delete: del });
  }
}
