/**
 * Scenario (e): differential test of the fake `ctx.db` against the real host.
 *
 * Every random operation is applied to (i) the real database through the SDK
 * and (ii) an authoritative `LocalStore` running the *same wrapped reducer
 * export* through `executeReducer`. After each op the outcome (ok/fail), the
 * error text on failure, and the full `todos`/`counters` row sets must match.
 * Any divergence is a semantic gap in the local `ctx.db` emulation.
 */
import { BinaryWriter, ProductType, Timestamp, Uuid } from 'spacetimedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalStore,
  SeededRng,
  executeReducer,
  tableSpecsFromSchema,
} from '@kamadadze/worldline/client';
import * as worldline from '@kamadadze/worldline/server';
import { LiveServer } from '../src/fixture';
import { beginRawSession, canon, connect, mod, reducers, uuid } from '../src/client';

let server: LiveServer;

beforeAll(async () => {
  server = await LiveServer.start();
  server.publish();
});

afterAll(async () => {
  await server?.stop();
});

const OPS = Number(process.env.DIFF_OPS ?? 300);

describe('fake ctx.db vs real host', () => {
  it(`${OPS} random operations produce identical outcomes and tables`, async () => {
    const rng = new SeededRng(20260907);
    const c = await connect({ wsUrl: server.wsUrl, db: 'todo-wl' });
    const conn = c.conn;
    // The client must see everything to compare full tables.
    await new Promise<void>(resolve => {
      conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .subscribe(['SELECT * FROM todos', 'SELECT * FROM counters']);
    });

    const specs = [
      ...tableSpecsFromSchema((mod as any).default),
      ...tableSpecsFromSchema((worldline as any).default, 'wl'),
    ];
    const local = new LocalStore(specs, { authoritative: true });
    // Both sides open the same session: the host through the handshake reducer,
    // the local store through the same body the fake server runs.
    const session = await beginRawSession(conn);
    const opened = executeReducer(
      local,
      (ctx, args) => worldline.beginSessionBody(ctx.db.wl, ctx, args as any),
      { clientId: session.wlClient, epoch: session.wlEpoch },
      { sender: c.identity, timestamp: Timestamp.now(), connectionId: null, rng: new SeededRng(0) }
    );
    expect(opened.status).toBe('predicted');
    if (opened.status === 'predicted') local.commitToBase(opened.writes);
    const bindings = reducers as any;
    const serializers: Record<string, (w: BinaryWriter, v: any) => void> = {};
    const deserializers: Record<string, any> = {};
    for (const [key, b] of Object.entries<any>(bindings)) {
      if (b.paramsType === undefined) continue; // the `wl` group of submodule reducers
      serializers[key] = ProductType.makeSerializer(b.paramsType);
      deserializers[key] = ProductType.makeDeserializer(b.paramsType);
    }

    const known: Uuid[] = [];
    const divergences: string[] = [];
    let failures = 0;

    for (let i = 0; i < OPS; i++) {
      const kind = rng.pick(['create', 'create', 'toggle', 'delete', 'bump', 'bump'] as const);
      let accessor: string;
      let args: Record<string, any>;
      if (kind === 'create') {
        const id = rng.chance(0.15) && known.length ? rng.pick(known) : uuid();
        known.push(id);
        accessor = 'createTodo';
        args = { id, title: rng.chance(0.08) ? '' : `t${rng.u32() % 100}` };
      } else if (kind === 'bump') {
        accessor = 'bump';
        args = { name: rng.pick(['x', 'y', 'z']), by: BigInt(rng.int(-4, 4)) };
      } else {
        const id = known.length && !rng.chance(0.2) ? rng.pick(known) : uuid();
        accessor = kind === 'toggle' ? 'toggleTodo' : 'deleteTodo';
        args = { id };
      }
      const full = { ...args, intentId: uuid(), clientTs: Timestamp.now(), ...session };

      // (ii) local, authoritative, same wrapped export.
      const localExec = executeReducer(local, (mod as any)[accessor], full, {
        sender: c.identity,
        timestamp: Timestamp.now(),
        connectionId: null,
        rng: new SeededRng(i),
      });
      let localOk = localExec.status === 'predicted';
      let localError = '';
      if (localExec.status === 'predicted') local.commitToBase(localExec.writes);
      else if (localExec.status === 'failed')
        localError = String((localExec.error as any)?.message ?? localExec.error);
      else {
        localOk = false;
        localError = `unpredicted: ${localExec.reason}`;
      }

      // (i) real host.
      const w = new BinaryWriter(256);
      serializers[accessor](w, full);
      let remoteOk = true;
      let remoteError = '';
      try {
        await conn.callReducer(bindings[accessor].name, w.getBuffer());
      } catch (e) {
        remoteOk = false;
        remoteError = String((e as Error).message ?? e);
        failures++;
      }

      if (localOk !== remoteOk) {
        divergences.push(
          `op ${i} ${accessor} ${JSON.stringify(args, bigintReplacer)}: ` +
            `local ok=${localOk} (${localError}) remote ok=${remoteOk} (${remoteError})`
        );
        continue;
      }
      if (!localOk && !remoteError.includes(localError.replace(/^.*?: /, '').slice(0, 20))) {
        // Messages are compared loosely: the host wraps the thrown message.
        divergences.push(
          `op ${i} ${accessor}: error text differs: local='${localError}' remote='${remoteError}'`
        );
      }
      const remoteTodos = canon(conn.db.todos.iter());
      const localTodos = canon(local.baseRows('todos'));
      const remoteCounters = canon(conn.db.counters.iter());
      const localCounters = canon(local.baseRows('counters'));
      if (JSON.stringify(remoteTodos) !== JSON.stringify(localTodos)) {
        divergences.push(
          `op ${i} ${accessor}: todos differ ` +
            `(${localTodos.length} local vs ${remoteTodos.length} remote)`
        );
      }
      if (JSON.stringify(remoteCounters) !== JSON.stringify(localCounters)) {
        divergences.push(
          `op ${i} ${accessor}: counters differ: ` +
            `local=${localCounters.join('|')} remote=${remoteCounters.join('|')}`
        );
      }
      if (divergences.length > 10) break;
    }
    console.log(
      `differential: ${OPS} ops, ${failures} rejected by the host, ` +
        `${divergences.length} divergences`
    );
    for (const d of divergences) console.log('  ' + d);
    expect(divergences).toEqual([]);
    expect(failures).toBeGreaterThan(0);
    conn.disconnect();
  });
});

function bigintReplacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v instanceof Uuid ? v.toString() : v;
}
