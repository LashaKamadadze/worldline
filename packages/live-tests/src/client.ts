/**
 * Client-side helpers: a real SDK `DbConnection` in Node, and a `LocalFirst`
 * backed by `NodeFsStorage` in a temp directory, wired with `createSdkLink`
 * the way the README tells applications to do it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identity, Uuid } from 'spacetimedb';
import {
  LocalFirst,
  createSdkLink,
  encodeSessionArgs,
  sessionReducerName,
  type IntentEvent,
  type LocalFirstOptions,
  type Session,
  type WorkingSet,
} from 'stdb-localfirst/client';
import { NodeFsStorage } from 'stdb-localfirst/client/node';
import * as mod from 'todo-module';
import { DbConnection, reducers } from '../generated/index';

export { mod, DbConnection, reducers };

export const WORKING_SET: WorkingSet = {
  queries: ['SELECT * FROM todos', 'SELECT * FROM counters'],
};
export const ACCESSORS = ['todos', 'counters'];

export const uuid = (): Uuid => Uuid.fromRandomBytesV4(crypto.getRandomValues(new Uint8Array(16)));

/**
 * Open a session for a raw SDK connection that calls wrapped reducers itself
 * (bypassing LocalFirst). Returns the fields such calls must carry.
 */
export async function beginRawSession(
  conn: DbConnection,
  session: Session = { clientId: uuid(), epoch: 1n }
): Promise<{ lfClient: Uuid; lfEpoch: bigint }> {
  await conn.callReducer(sessionReducerName('lf'), encodeSessionArgs(session));
  return { lfClient: session.clientId, lfEpoch: session.epoch };
}

export interface Connected {
  conn: DbConnection;
  identity: Identity;
  token: string;
  /** Resolves when the connection closes (after the initial connect). */
  closed: Promise<Error | undefined>;
}

/** Connect and resolve once the server has acknowledged us. */
export function connect(opts: {
  wsUrl: string;
  db: string;
  token?: string;
  onConnect?: (conn: DbConnection) => void;
  onDisconnect?: (err?: Error) => void;
}): Promise<Connected> {
  return new Promise((resolve, reject) => {
    let resolveClosed!: (e: Error | undefined) => void;
    const closed = new Promise<Error | undefined>(r => (resolveClosed = r));
    const builder = DbConnection.builder().withUri(opts.wsUrl).withDatabaseName(opts.db);
    if (opts.token) builder.withToken(opts.token);
    builder
      .onConnect((conn, identity, token) => {
        opts.onConnect?.(conn);
        resolve({ conn, identity, token, closed });
      })
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect((_ctx, err) => {
        opts.onDisconnect?.(err);
        resolveClosed(err);
      })
      .build();
  });
}

export interface LocalClient {
  lf: LocalFirst;
  dir: string;
  events: IntentEvent[];
  /** Reopen from the same directory (simulates an app restart). */
  reopen(): Promise<LocalClient>;
  cleanup(): Promise<void>;
}

export async function openLocal(
  opts: Partial<LocalFirstOptions> & { dir?: string } = {}
): Promise<LocalClient> {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), 'stdb-lf-client-')));
  const lf = await LocalFirst.open({
    module: mod as any,
    reducers: reducers,
    storage: new NodeFsStorage(dir),
    workingSet: WORKING_SET,
    snapshotDebounceMs: 100,
    ...opts,
  });
  const events: IntentEvent[] = [];
  lf.onIntent(ev => events.push(ev));
  return {
    lf,
    dir,
    events,
    reopen: () => openLocal({ ...opts, dir }),
    cleanup: async () => {
      await lf.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Attach a live connection to a LocalFirst exactly as the README documents. */
export function attach(lf: LocalFirst, conn: DbConnection): void {
  lf.connect(createSdkLink(conn, { workingSet: WORKING_SET, accessors: ACCESSORS }));
}

/** Wait until nothing is pending and the overlay is empty. */
export async function drained(lf: LocalFirst, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (lf.pending().length > 0 || lf.store.hasOverlay()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `not drained after ${timeoutMs}ms: ` +
          `pending=${lf.pending().length} overlay=${lf.store.hasOverlay()}`
      );
    }
    await new Promise(r => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Canonical, order-independent view of a table for equality checks. */
export function canon(rows: Iterable<any>): string[] {
  return [...rows]
    .map(r =>
      JSON.stringify(r, (_k, v) => {
        if (typeof v === 'bigint') return v.toString() + 'n';
        if (v instanceof Uuid) return v.toString();
        if (v instanceof Identity) return v.toHexString();
        if (v && typeof v === 'object' && 'microsSinceUnixEpoch' in v)
          return String(v.microsSinceUnixEpoch);
        return v;
      })
    )
    .sort();
}

export function serverView(conn: DbConnection): { todos: string[]; counters: string[] } {
  return { todos: canon(conn.db.todos.iter()), counters: canon(conn.db.counters.iter()) };
}

export function localView(lf: LocalFirst): { todos: string[]; counters: string[] } {
  return { todos: canon(lf.db.todos.iter()), counters: canon(lf.db.counters.iter()) };
}
