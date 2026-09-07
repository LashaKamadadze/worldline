/**
 * End-to-end demo against a real local SpacetimeDB:
 *
 *  1. boot with no network, create todos, toggle one, bump a counter (all predicted locally)
 *  2. "restart" the app: reopen from disk, pending intents replay from the log
 *  3. connect to the server, drain the queue, receive truth, rebase
 *  4. compare the local merged view with the server's tables
 *
 * Run with the server up and the module published (see the justfile).
 */
import { rm } from 'node:fs/promises';
import { Uuid } from 'spacetimedb';
import { LocalFirst, NodeFsStorage, createSdkLink, type WorkingSet } from 'stdb-localfirst/client';
import * as mod from 'todo-module';
import { DbConnection, reducers } from './module_bindings';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.STDB_DB ?? 'todo-lf';
const DATA_DIR = new URL('../.lf-data/', import.meta.url).pathname;

const workingSet: WorkingSet = { queries: ['SELECT * FROM todos', 'SELECT * FROM counters'] };
const accessors = ['todos', 'counters'];

const open = () =>
  LocalFirst.open({
    module: mod,
    reducers: reducers,
    storage: new NodeFsStorage(DATA_DIR),
    workingSet,
    snapshotDebounceMs: 200,
  });

const show = (label: string, lf: LocalFirst) => {
  const todos = [...lf.db.todos.iter()].map((t: any) => `${t.done ? '[x]' : '[ ]'} ${t.title}`);
  const counters = [...lf.db.counters.iter()].map((c: any) => `${c.name}=${c.value}`);
  console.log(
    [
      `\n== ${label} ==`,
      `  todos:    ${todos.join(', ') || '(none)'}`,
      `  counters: ${counters.join(', ') || '(none)'}`,
      `  pending:  ${lf.pending().length}`,
    ].join('\n')
  );
};

/** Phase 1: everything happens with no network at all. */
async function offlineSession(): Promise<void> {
  const lf = await open();
  const a = Uuid.fromRandomBytesV4(crypto.getRandomValues(new Uint8Array(16)));
  const b = Uuid.fromRandomBytesV4(crypto.getRandomValues(new Uint8Array(16)));
  const handles = [
    lf.call(mod.createTodo, { id: a, title: 'write the library' }),
    lf.call(mod.createTodo, { id: b, title: 'test it offline' }),
    lf.call(mod.toggleTodo, { id: a }),
    lf.call(mod.bump, { name: 'demo', by: 3n }),
  ];
  await Promise.all(handles.map(h => h.durable));
  try {
    lf.call(mod.createTodo, { id: a, title: 'duplicate id' });
  } catch (e) {
    console.log(`local rejection works: ${(e as Error).name}`);
  }
  show('offline, before restart', lf);
  await lf.close();
}

/** Resolves when every currently pending intent has been acked, failed or cancelled. */
function allSettled(lf: LocalFirst): Promise<void[]> {
  return Promise.all(
    lf.pending().map(
      () =>
        new Promise<void>(resolve => {
          const off = lf.onIntent(ev => {
            if (ev.type !== 'acked' && ev.type !== 'failed' && ev.type !== 'cancelled') return;
            off();
            resolve();
          });
        })
    )
  );
}

function connect(lf: LocalFirst): Promise<DbConnection> {
  return new Promise<DbConnection>((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect(c => {
        console.log(`\nconnected as ${c.identity?.toHexString().slice(0, 12)}...`);
        lf.connect(createSdkLink(c, { workingSet, accessors }));
        resolve(c);
      })
      .onConnectError((_ctx, err) => reject(err))
      .onDisconnect(() => lf.disconnect())
      .build();
  });
}

const describeTodos = (rows: Iterable<any>): string[] =>
  [...rows].map(t => `${t.done ? '[x]' : '[ ]'} ${t.title}`).sort();
const describeCounters = (rows: Iterable<any>): string[] =>
  [...rows].map(c => `${c.name}=${c.value}`).sort();

/** Phase 4: the merged local view must equal the server's view of the same subscription. */
function compareWithServer(lf: LocalFirst, conn: DbConnection): boolean {
  const server = [describeTodos(conn.db.todos.iter()), describeCounters(conn.db.counters.iter())];
  const local = [describeTodos(lf.db.todos.iter()), describeCounters(lf.db.counters.iter())];
  const same = JSON.stringify(server) === JSON.stringify(local);
  console.log(`\nlocal view == server view: ${same ? 'YES' : 'NO'}`);
  if (!same) console.error('MISMATCH', { server, local });
  return same && lf.pending().length === 0 && !lf.store.hasOverlay();
}

async function main(): Promise<void> {
  await rm(DATA_DIR, { recursive: true, force: true });
  await offlineSession();

  // Phase 2: restart from disk.
  const lf = await open();
  show('after restart (replayed from log)', lf);
  if (lf.pending().length !== 4) throw new Error('expected 4 pending intents after restart');

  // Phase 3: go online and drain.
  const settled = allSettled(lf);
  const events: string[] = [];
  lf.onIntent(ev =>
    events.push(ev.type === 'rebase' ? `rebase(${ev.predicted}/${ev.unpredicted})` : ev.type)
  );
  const conn = await connect(lf);
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('timed out waiting for acks')), 15_000)
  );
  await Promise.race([settled, timeout]);
  await new Promise(r => setTimeout(r, 300)); // let the last rebase/snapshot settle
  show('online, drained', lf);
  console.log(`  events:   ${events.join(' ')}`);

  const ok = compareWithServer(lf, conn);
  await lf.close();
  conn.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
