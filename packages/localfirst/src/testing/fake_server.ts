import { BinaryReader, Identity, ProductType, Timestamp, Uuid } from 'spacetimedb';
import { executeReducer } from '../client/executor';
import { LocalStore, specKey, type Delta } from '../client/local_store';
import { SeededRng } from '../client/rng';
import { tableSpecsFromSchema, type Row, type TableSpec } from '../client/table_spec';
import type { ReducerBinding } from '../client/local_first';
import { INTENT_ID_PARAM } from '../shared/symbols';

export interface ServerCallResult {
  ok: boolean;
  error?: string;
  duplicate: boolean;
  deltas: Map<string, Delta>;
}

export interface ExecutionRecord {
  intentId: string | null;
  reducer: string;
  ok: boolean;
  duplicate: boolean;
  effects: number;
}

/**
 * An in-process stand-in for the SpacetimeDB host: authoritative tables, the
 * mounted localfirst submodule tables, and the *real* wrapped reducer exports
 * (dedup preamble included). Deltas are computed from committed writes.
 */
export class FakeServer {
  readonly store: LocalStore;
  readonly executions: ExecutionRecord[] = [];
  readonly effectRuns = new Map<string, number>();
  readonly rootAccessors: string[];
  #entries = new Map<
    string,
    {
      accessor: string;
      fn: (ctx: any, args: Row) => unknown;
      deserialize: (r: BinaryReader) => Row;
    }
  >();
  #clock: () => bigint;
  #rng: SeededRng;
  #subscribers = new Set<(accessor: string, delta: Delta) => void>();

  constructor(
    mod: Record<string, any>,
    bindings: Record<string, ReducerBinding>,
    submodules: Record<string, any>,
    clock: () => bigint,
    rng: SeededRng
  ) {
    const specs: TableSpec[] = tableSpecsFromSchema(mod.default);
    this.rootAccessors = specs.map(s => s.accessorName);
    for (const [alias, sub] of Object.entries(submodules)) {
      specs.push(...tableSpecsFromSchema(sub.default, alias));
    }
    this.store = new LocalStore(specs, { authoritative: true });
    this.#clock = clock;
    this.#rng = rng;
    for (const [accessor, b] of Object.entries(bindings)) {
      const fn = mod[accessor];
      if (typeof fn !== 'function') continue;
      this.#entries.set(b.name, {
        accessor,
        fn,
        deserialize: ProductType.makeDeserializer(b.paramsType),
      });
    }
  }

  onDelta(cb: (accessor: string, delta: Delta) => void): () => void {
    this.#subscribers.add(cb);
    return () => this.#subscribers.delete(cb);
  }

  /** Current rows of every root (public) table. */
  snapshot(): Map<string, Row[]> {
    const out = new Map<string, Row[]>();
    for (const acc of this.rootAccessors) out.set(acc, this.store.baseRows(acc));
    return out;
  }

  isApplied(intentId: Uuid): boolean {
    const key = specKey(this.store.spec('lf.appliedIntents'));
    return this.store.get(key, this.store.spec(key).rowKey({ intentId })) !== undefined;
  }

  call(reducerName: string, argsBsatn: Uint8Array, sender: Identity): ServerCallResult {
    const entry = this.#entries.get(reducerName);
    if (!entry)
      return {
        ok: false,
        error: `no such reducer ${reducerName}`,
        duplicate: false,
        deltas: new Map(),
      };
    const args = entry.deserialize(new BinaryReader(argsBsatn));
    const intentId: Uuid | undefined = args[INTENT_ID_PARAM];
    const duplicate = intentId ? this.isApplied(intentId) : false;
    const exec = executeReducer(this.store, entry.fn, args, {
      sender,
      timestamp: new Timestamp(this.#clock()),
      connectionId: null,
      rng: this.#rng,
    });
    if (exec.status !== 'predicted') {
      const error =
        exec.status === 'failed' ? String((exec.error as any)?.message ?? exec.error) : exec.reason;
      this.executions.push({
        intentId: intentId?.toString() ?? null,
        reducer: reducerName,
        ok: false,
        duplicate,
        effects: 0,
      });
      return { ok: false, error, duplicate, deltas: new Map() };
    }
    let effects = 0;
    for (const layer of exec.writes.values()) effects += layer.size;
    if (duplicate && effects !== 0) {
      throw new Error(`INVARIANT: duplicate delivery of ${intentId} produced ${effects} writes`);
    }
    if (intentId && !duplicate) {
      const k = intentId.toString();
      this.effectRuns.set(k, (this.effectRuns.get(k) ?? 0) + 1);
    }
    const deltas = this.store.commitToBase(exec.writes);
    this.executions.push({
      intentId: intentId?.toString() ?? null,
      reducer: reducerName,
      ok: true,
      duplicate,
      effects,
    });
    for (const [key, delta] of deltas) {
      if (!this.rootAccessors.includes(key)) continue; // submodule tables are private
      for (const cb of this.#subscribers) cb(key, delta);
    }
    return { ok: true, duplicate, deltas };
  }
}
