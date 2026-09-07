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
    reducers: reducers as any,
    storage: new NodeFsStorage(DATA_DIR),
    workingSet,
    snapshotDebounceMs: 200,
  });

const show = (label: string, lf: LocalFirst) => {
  const todos = [...lf.db.todos.iter()].map((t: any) => `${t.done ? '[x]' : '[ ]'} ${t.title}`);
  const counters = [...lf.db.counters.iter()].map((c: any) => `${c.name}=${c.value}`);
  console.log(`\n== ${label} ==\n  todos:    ${todos.join(', ') || '(none)'}\n  counters: ${counters.join(', ') || '(none)'}\n  pending:  ${lf.pending().length}`);
};

async function main() {
  await rm(DATA_DIR, { recursive: true, force: true });

  // 1. Offline session.
  let lf = await open();
  const a = Uuid.fromRandomBytesV4(crypto.getRandomValues(new Uint8Array(16)));
  const b = Uuid.fromRandomBytesV4(crypto.getRandomValues(new Uint8Array(16)));
  const h1 = lf.call(mod.createTodo, { id: a, title: 'write the library' });
  const h2 = lf.call(mod.createTodo, { id: b, title: 'test it offline' });
  const h3 = lf.call(mod.toggleTodo, { id: a });
  const h4 = lf.call(mod.bump, { name: 'demo', by: 3n });
  await Promise.all([h1.durable, h2.durable, h3.durable, h4.durable]);
  try {
    lf.call(mod.createTodo, { id: a, title: 'duplicate id' });
  } catch (e) {
    console.log(`local rejection works: ${(e as Error).name}`);
  }
  show('offline, before restart', lf);
  await lf.close();

  // 2. Restart from disk.
  lf = await open();
  show('after restart (replayed from log)', lf);
  if (lf.pending().length !== 4) throw new Error('expected 4 pending intents after restart');

  // 3. Go online.
  const settled = Promise.all(lf.pending().map(() => new Promise<void>(r => {
    const off = lf.onIntent(ev => {
      if (ev.type === 'acked' || ev.type === 'failed' || ev.type === 'cancelled') {
        off();
        r();
      }
    });
  })));
  const events: string[] = [];
  lf.onIntent(ev => events.push(ev.type === 'rebase' ? `rebase(${ev.predicted}/${ev.unpredicted})` : ev.type));

  const conn = await new Promise<DbConnection>((resolve, reject) => {
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

  await Promise.race([
    settled,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for acks')), 15_000)),
  ]);
  await new Promise(r => setTimeout(r, 300)); // let the last rebase/snapshot settle
  show('online, drained', lf);
  console.log(`  events:   ${events.join(' ')}`);

  // 4. Compare with the server's view of the same subscription.
  const serverTodos = [...conn.db.todos.iter()].map((t: any) => `${t.done ? '[x]' : '[ ]'} ${t.title}`).sort();
  const localTodos = [...lf.db.todos.iter()].map((t: any) => `${t.done ? '[x]' : '[ ]'} ${t.title}`).sort();
  const serverCounters = [...conn.db.counters.iter()].map((c: any) => `${c.name}=${c.value}`).sort();
  const localCounters = [...lf.db.counters.iter()].map((c: any) => `${c.name}=${c.value}`).sort();
  const same = JSON.stringify([serverTodos, serverCounters]) === JSON.stringify([localTodos, localCounters]);
  console.log(`\nlocal view == server view: ${same ? 'YES' : 'NO'}`);
  if (!same || lf.pending().length !== 0 || lf.store.hasOverlay()) {
    console.error('MISMATCH', { serverTodos, localTodos, serverCounters, localCounters });
    process.exit(1);
  }
  await lf.close();
  conn.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
