import type { LocalFirst } from './local_first';
import type { Row } from './table_spec';

/**
 * Framework-agnostic reactive views over the merged (base + predicted) tables.
 *
 * - `subscribe(run)` follows the Svelte store contract (calls `run` immediately).
 * - `getSnapshot()` + `subscribe(cb)` fit React's `useSyncExternalStore`.
 * Snapshots are only rebuilt when the table actually changed.
 */
export interface TableStore<T = Row> {
  subscribe(run: (rows: readonly T[]) => void): () => void;
  getSnapshot(): readonly T[];
}

export function tableStore<T = Row>(lf: LocalFirst, accessor: string): TableStore<T> {
  let version = -1;
  let snapshot: readonly T[] = [];
  const refresh = () => {
    if (version === lf.store.version) return snapshot;
    version = lf.store.version;
    snapshot = Object.freeze([...lf.db[accessor].iter()]) as readonly T[];
    return snapshot;
  };
  return {
    getSnapshot: refresh,
    subscribe(run) {
      run(refresh());
      return lf.subscribe(changed => {
        if (changed.has(accessor)) run(refresh());
      });
    },
  };
}

export interface PendingStore {
  subscribe(run: (state: PendingState) => void): () => void;
  getSnapshot(): PendingState;
}

export interface PendingState {
  count: number;
  unpredicted: number;
  connected: boolean;
}

/** Reactive "what is still waiting for the server" indicator for a status bar. */
export function pendingStore(lf: LocalFirst): PendingStore {
  let key = '';
  let snapshot: PendingState = { count: 0, unpredicted: 0, connected: false };
  const compute = (): PendingState => {
    const pending = lf.pending();
    const unpredicted = pending.filter(p => !lf.isPredicted(p.intentId)).length;
    const k = `${pending.length}:${unpredicted}:${lf.connected}`;
    if (k !== key) {
      key = k;
      snapshot = Object.freeze({ count: pending.length, unpredicted, connected: lf.connected });
    }
    return snapshot;
  };
  return {
    getSnapshot: compute,
    subscribe(run) {
      run(compute());
      return lf.onIntent(() => run(compute()));
    },
  };
}

/**
 * React adapter without importing React: pass the hook in.
 *   const rows = useLocalTable(useSyncExternalStore, lf, 'todos');
 */
export function useLocalTable<T = Row>(
  useSyncExternalStore: (
    sub: (cb: () => void) => () => void,
    get: () => readonly T[]
  ) => readonly T[],
  lf: LocalFirst,
  accessor: string
): readonly T[] {
  const store = tableStore<T>(lf, accessor);
  return useSyncExternalStore(cb => store.subscribe(() => cb()), store.getSnapshot);
}
