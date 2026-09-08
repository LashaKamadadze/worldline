import { Uuid } from 'spacetimedb';
import {
  Worldline,
  MemoryStorage,
  OpfsStorage,
  createSdkLink,
  type AnyReducer,
  type IntentEvent,
  type StorageAdapter,
  type WorkingSet,
} from '@kamadadze/worldline/client';
import * as mod from 'todo-module';
import { DbConnection, reducers } from '../generated/module_bindings';
import { sortedRows } from './serialize';

/**
 * Page entry for the full-stack tests. Everything the Node test needs is
 * exposed on `window.lfTest` with plain (serializable) inputs and outputs.
 */
const workingSet: WorkingSet = { queries: ['SELECT * FROM todos', 'SELECT * FROM counters'] };
const accessors = ['todos', 'counters'];
const TOKEN_KEY = 'worldline-test-token';

let lf: Worldline | null = null;
let conn: DbConnection | null = null;
const events: string[] = [];
const settledIds = new Set<string>();

function reducerNamed(name: string): AnyReducer {
  const reducer = REDUCERS[name];
  if (reducer === undefined) throw new Error(`unknown reducer ${name}`);
  return reducer;
}

const REDUCERS: Record<string, AnyReducer> = {
  createTodo: mod.createTodo,
  toggleTodo: mod.toggleTodo,
  deleteTodo: mod.deleteTodo,
  bump: mod.bump,
};

function decodeArgs(name: string, args: Record<string, string>): Record<string, unknown> {
  switch (name) {
    case 'createTodo':
      return { id: Uuid.parse(args.id), title: args.title };
    case 'toggleTodo':
    case 'deleteTodo':
      return { id: Uuid.parse(args.id) };
    case 'bump':
      return { name: args.name, by: BigInt(args.by) };
    default:
      throw new Error(`unknown reducer ${name}`);
  }
}

// Browsers without OPFS (Playwright's Linux WebKit) get a memory adapter: the
// sync path still works, only reload persistence is lost. Tests check this flag.
const persistence: 'opfs' | 'memory' = OpfsStorage.isSupported() ? 'opfs' : 'memory';
const memoryStores = new Map<string, StorageAdapter>();
function storageFor(dir: string): StorageAdapter {
  if (persistence === 'opfs') return new OpfsStorage(dir);
  let s = memoryStores.get(dir);
  if (!s) memoryStores.set(dir, (s = new MemoryStorage()));
  return s;
}

(window as any).lfTest = {
  persistence: () => persistence,
  async open(
    dir: string,
    opts: { snapshotDebounceMs?: number | null; inflightWindow?: number } = {}
  ) {
    if (lf) throw new Error('already open');
    lf = await Worldline.open({
      module: mod as any,
      reducers,
      storage: storageFor(dir),
      workingSet,
      snapshotDebounceMs: opts.snapshotDebounceMs ?? 50,
      inflightWindow: opts.inflightWindow,
    });
    lf.onIntent((ev: IntentEvent) => {
      events.push(ev.type === 'rebase' ? `rebase(${ev.predicted}/${ev.unpredicted})` : ev.type);
      if (ev.type === 'acked' || ev.type === 'failed' || ev.type === 'cancelled') {
        settledIds.add(`${ev.type}:${ev.intent.intentId.toString()}`);
      }
    });
    return {
      pending: lf.pending().length,
      recovery: { ...lf.log.recovery, generation: lf.log.recovery.generation.toString() },
    };
  },

  async call(name: string, args: Record<string, string>) {
    if (!lf) throw new Error('not open');
    const handle = lf.call(reducerNamed(name), decodeArgs(name, args));
    let durable: 'ok' | 'rejected' = 'ok';
    await handle.durable.catch(() => (durable = 'rejected'));
    return { intentId: handle.intentId.toString(), predicted: handle.predicted, durable };
  },

  callExpectThrow(name: string, args: Record<string, string>) {
    if (!lf) throw new Error('not open');
    try {
      lf.call(reducerNamed(name), decodeArgs(name, args));
      return null;
    } catch (e) {
      return (e as Error).name + ': ' + (e as Error).message;
    }
  },

  pending: () => lf!.pending().map(p => p.intentId.toString()),
  rows: (table: string) => sortedRows(lf!.db[table].iter()),
  serverRows: (table: string) => sortedRows((conn as any).db[table].iter()),
  hasOverlay: () => lf!.store.hasOverlay(),
  events: () => events.slice(),
  settled: () => [...settledIds],
  connected: () => lf!.connected,

  connect(wsUrl: string, db: string): Promise<string> {
    if (!lf) throw new Error('not open');
    return new Promise((resolve, reject) => {
      // A real app keeps its token so the identity survives reloads and new tabs.
      const savedToken = localStorage.getItem(TOKEN_KEY) ?? undefined;
      conn = DbConnection.builder()
        .withUri(wsUrl)
        .withDatabaseName(db)
        .withToken(savedToken)
        .onConnect((c, _identity, token) => {
          localStorage.setItem(TOKEN_KEY, token);
          lf!.connect(createSdkLink(c, { workingSet, accessors }));
          resolve(c.identity?.toHexString() ?? '');
        })
        .onConnectError((_ctx, err) => reject(err))
        .onDisconnect(() => lf?.disconnect())
        .build();
    });
  },

  disconnect() {
    lf?.disconnect();
    conn?.disconnect();
    conn = null;
  },

  /** Resolve once nothing is pending (and a rebase has run), or reject on timeout. */
  waitDrained(timeoutMs: number): Promise<number> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!lf) return reject(new Error('closed'));
        if (lf.pending().length === 0) return setTimeout(() => resolve(Date.now() - start), 150);
        if (Date.now() - start > timeoutMs)
          return reject(new Error(`still pending: ${lf.pending().length}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  },

  async snapshotNow() {
    await lf!.snapshotNow();
  },

  async close() {
    await lf?.close();
    conn?.disconnect();
    lf = null;
    conn = null;
  },
};
(window as any).lfReady = true;
