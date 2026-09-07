import type { Delta } from './local_store';
import type { Row } from './table_spec';
import type { Link, ServerEvents, Transport } from './transport';

export type Coverage = 'full' | 'partial';

export interface WorkingSet {
  /**
   * The subscription set kept alive for the whole connection. Either SQL
   * strings or the SDK's typed query builder callback
   * (`tables => [tables.todos.build(), ...]`).
   */
  queries: string[] | ((tables: any) => any);
  /**
   * Per-table coverage. `full` (default) means the working set contains every
   * row of the table the server would let this client see, so a cache miss is
   * a true miss. `partial` means a miss is unknown and prediction must stop.
   */
  coverage?: Record<string, Coverage>;
}

/**
 * Bind a real SDK `DbConnection` to the library: subscribes to the working set,
 * mirrors table events into base-layer deltas, and routes reducer calls.
 *
 * Create it inside your builder's `onConnect` and hand it to `lf.connect(link)`;
 * call `lf.disconnect()` from `onDisconnect`.
 */
export function createSdkLink(
  conn: any,
  opts: { workingSet: WorkingSet; accessors: string[] }
): Link {
  const initialCbs = new Set<(tables: Map<string, Row[]>) => void>();
  const deltaCbs = new Set<(accessor: string, delta: Delta) => void>();
  const unsubs: (() => void)[] = [];

  const emitDelta = (accessor: string, delta: Delta) => {
    for (const cb of deltaCbs) cb(accessor, delta);
  };

  for (const acc of opts.accessors) {
    const table = conn.db?.[acc];
    if (!table) continue;
    const onIns = (_ctx: unknown, row: Row) => emitDelta(acc, { inserts: [row], deletes: [] });
    const onDel = (_ctx: unknown, row: Row) => emitDelta(acc, { inserts: [], deletes: [row] });
    const onUpd = (_ctx: unknown, oldRow: Row, newRow: Row) =>
      emitDelta(acc, { inserts: [newRow], deletes: [oldRow] });
    table.onInsert(onIns);
    table.onDelete(onDel);
    unsubs.push(
      () => table.removeOnInsert(onIns),
      () => table.removeOnDelete(onDel)
    );
    if (typeof table.onUpdate === 'function') {
      try {
        table.onUpdate(onUpd);
        unsubs.push(() => table.removeOnUpdate(onUpd));
      } catch {
        // tables without a primary key have no update events
      }
    }
  }

  const builder = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const tables = new Map<string, Row[]>();
      for (const acc of opts.accessors) {
        const table = conn.db?.[acc];
        if (table) tables.set(acc, [...table.iter()]);
      }
      for (const cb of initialCbs) cb(tables);
    })
    .onError((ctx: any) => {
      console.error('stdb-localfirst: subscription error', ctx?.event ?? ctx);
    });
  const handle = builder.subscribe(opts.workingSet.queries as any);

  const transport: Transport = {
    callReducer: (name, args) => conn.callReducer(name, args),
  };
  const events: ServerEvents = {
    onInitialState(cb) {
      initialCbs.add(cb);
      return () => initialCbs.delete(cb);
    },
    onDelta(cb) {
      deltaCbs.add(cb);
      return () => deltaCbs.delete(cb);
    },
  };

  return {
    transport,
    events,
    identity: conn.identity,
    dispose() {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore */
        }
      }
      try {
        handle?.unsubscribe?.();
      } catch {
        /* connection may already be gone */
      }
    },
  };
}
