/**
 * Scenario (d): a large working set on the real host.
 *
 * 10,000 todos are created through the SDK, then a fresh LocalFirst client
 * subscribes. Measured: initial load into the base layer, boot from snapshot,
 * and a rebase with 200 pending intents on top of the 10k rows. Bounds are
 * deliberately loose; the point is to catch accidental O(n^2) behaviour and to
 * put real numbers in the report.
 */
import { performance } from 'node:perf_hooks';
import { Timestamp, Uuid } from 'spacetimedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveServer, waitFor } from '../src/fixture';
import { attach, connect, drained, localView, mod, openLocal, serverView, uuid } from '../src/client';

let server: LiveServer;
const N = 10_000;
const PENDING = 200;
const ids: Uuid[] = [];

beforeAll(async () => {
  server = await LiveServer.start();
  server.publish();
});

afterAll(async () => {
  await server?.stop();
});

describe(`working set of ${N} rows`, () => {
  it('seeds the server through the SDK', async () => {
    const seed = await connect({ wsUrl: server.wsUrl, db: 'todo-lf' });
    const t0 = performance.now();
    const batch = 500;
    for (let i = 0; i < N; i += batch) {
      const calls = [];
      for (let j = i; j < Math.min(N, i + batch); j++) {
        const id = uuid();
        ids.push(id);
        calls.push(
          seed.conn.reducers.createTodo({
            id,
            title: `row ${j}`,
            intentId: uuid(),
            clientTs: Timestamp.now(),
          })
        );
      }
      await Promise.all(calls);
    }
    const ms = performance.now() - t0;
    console.log(`seeded ${N} rows via reducer calls in ${ms.toFixed(0)}ms (${((N * 1000) / ms).toFixed(0)}/s)`);
    expect(await server.sqlCount('todos')).toBe(N);
    seed.conn.disconnect();
  });

  it('a fresh client loads the working set, snapshots it, boots from the snapshot, and rebases 200 intents', async () => {
    const c = await openLocal({ snapshotDebounceMs: null });
    const t0 = performance.now();
    const conn = await connect({ wsUrl: server.wsUrl, db: 'todo-lf', onDisconnect: () => c.lf.disconnect() });
    attach(c.lf, conn.conn);
    await waitFor(() => c.lf.db.todos.count() === BigInt(N), { timeoutMs: 120_000, what: 'initial state' });
    const loadMs = performance.now() - t0;
    console.log(`initial load of ${N} rows: ${loadMs.toFixed(0)}ms`);
    expect(loadMs).toBeLessThan(60_000);

    const t1 = performance.now();
    await c.lf.snapshotNow();
    const snapMs = performance.now() - t1;
    console.log(`snapshot of ${N} rows: ${snapMs.toFixed(0)}ms`);

    conn.conn.disconnect();
    await conn.closed;
    await c.lf.close();

    const t2 = performance.now();
    const again = await c.reopen();
    const bootMs = performance.now() - t2;
    console.log(`boot from snapshot (${N} rows): ${bootMs.toFixed(0)}ms`);
    expect(again.lf.db.todos.count()).toBe(BigInt(N));
    expect(bootMs).toBeLessThan(10_000);

    // 200 offline toggles on random rows (each reads + writes one row).
    const handles = [];
    const t3 = performance.now();
    for (let i = 0; i < PENDING; i++) {
      handles.push(again.lf.call(mod.toggleTodo, { id: ids[(i * 37) % N] }));
    }
    const callMs = performance.now() - t3;
    await Promise.all(handles.map(h => h.durable));
    const t4 = performance.now();
    again.lf.rebase();
    const rebaseMs = performance.now() - t4;
    console.log(`${PENDING} predicted calls: ${callMs.toFixed(0)}ms; rebase of ${PENDING} pending over ${N} rows: ${rebaseMs.toFixed(0)}ms`);
    expect(rebaseMs).toBeLessThan(5_000);
    expect(again.lf.pending().length).toBe(PENDING);

    // Instrument: how much of the drain is spent rebasing after every ack?
    let rebases = 0;
    let rebaseTotalMs = 0;
    const originalRebase = again.lf.rebase.bind(again.lf);
    again.lf.rebase = () => {
      const s = performance.now();
      originalRebase();
      rebaseTotalMs += performance.now() - s;
      rebases++;
    };

    const t5 = performance.now();
    const conn2 = await connect({ wsUrl: server.wsUrl, db: 'todo-lf', token: conn.token, onDisconnect: () => again.lf.disconnect() });
    attach(again.lf, conn2.conn);
    await drained(again.lf, 120_000);
    const drainMs = performance.now() - t5;
    console.log(
      `reconnect + drain ${PENDING} intents (window 1): ${drainMs.toFixed(0)}ms; ` +
        `${rebases} rebases totalling ${rebaseTotalMs.toFixed(0)}ms (${(rebaseTotalMs / Math.max(1, rebases)).toFixed(1)}ms avg)`
    );
    await new Promise(r => setTimeout(r, 300));
    expect(localView(again.lf)).toEqual(serverView(conn2.conn));
    expect(await server.sqlCount('lf.applied_intents')).toBe(N + PENDING);
    conn2.conn.disconnect();
    await again.cleanup();
  });

  it('drain throughput with a wider in-flight window (same 10k working set)', async () => {
    const c = await openLocal({ snapshotDebounceMs: null, inflightWindow: 16 });
    const conn = await connect({ wsUrl: server.wsUrl, db: 'todo-lf', onDisconnect: () => c.lf.disconnect() });
    attach(c.lf, conn.conn);
    await waitFor(() => c.lf.db.todos.count() === BigInt(N), { timeoutMs: 120_000, what: 'initial state' });
    conn.conn.disconnect();
    await conn.closed;

    const handles = [];
    for (let i = 0; i < PENDING; i++) {
      handles.push(c.lf.call(mod.bump, { name: `w${i % 20}`, by: 1n }));
    }
    await Promise.all(handles.map(h => h.durable));

    let rebases = 0;
    let rebaseTotalMs = 0;
    const originalRebase = c.lf.rebase.bind(c.lf);
    c.lf.rebase = () => {
      const s = performance.now();
      originalRebase();
      rebaseTotalMs += performance.now() - s;
      rebases++;
    };
    const t0 = performance.now();
    const conn2 = await connect({ wsUrl: server.wsUrl, db: 'todo-lf', token: conn.token, onDisconnect: () => c.lf.disconnect() });
    attach(c.lf, conn2.conn);
    await drained(c.lf, 120_000);
    const drainMs = performance.now() - t0;
    console.log(
      `reconnect + drain ${PENDING} bumps (window 16): ${drainMs.toFixed(0)}ms; ` +
        `${rebases} rebases totalling ${rebaseTotalMs.toFixed(0)}ms`
    );
    await new Promise(r => setTimeout(r, 300));
    expect(localView(c.lf)).toEqual(serverView(conn2.conn));
    conn2.conn.disconnect();
    await c.cleanup();
  });
});
