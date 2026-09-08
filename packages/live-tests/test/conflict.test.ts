/**
 * Scenario (a): two clients with conflicting offline edits.
 *
 * 1. Both create the same primary key offline; B syncs first. A's create must be
 *    rejected by the real host (unique violation), A's dependent toggle must be
 *    cancelled before it is sent, and A must converge to what the server has.
 * 2. A caches a todo, goes offline, B deletes it, A toggles it offline (predicted
 *    fine on the stale cache). On reconnect the host rejects the toggle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveServer, waitFor } from '../src/fixture';
import {
  attach,
  connect,
  drained,
  localView,
  mod,
  openLocal,
  serverView,
  sleep,
  uuid,
} from '../src/client';

let server: LiveServer;

beforeAll(async () => {
  server = await LiveServer.start();
  server.publish();
});

afterAll(async () => {
  await server?.stop();
});

describe('conflicting offline edits', () => {
  const title = 'same key from two clients: loser fails, dependents cancel, both converge';
  it(title, async () => {
    const a = await openLocal();
    const b = await openLocal();
    const id = uuid();

    const bCreate = b.lf.call(mod.createTodo, { id, title: 'B was first' });
    const aCreate = a.lf.call(mod.createTodo, { id, title: 'A was second' });
    const aToggle = a.lf.call(mod.toggleTodo, { id });
    const aBump = a.lf.call(mod.bump, { name: 'independent', by: 5n });
    await Promise.all([bCreate.durable, aCreate.durable, aToggle.durable, aBump.durable]);
    expect(a.lf.pending().length).toBe(3);

    const cb = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-wl',
      onDisconnect: () => b.lf.disconnect(),
    });
    attach(b.lf, cb.conn);
    expect(await bCreate.settled).toBe('acked');
    await drained(b.lf);

    const ca = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-wl',
      onDisconnect: () => a.lf.disconnect(),
    });
    attach(a.lf, ca.conn);
    expect(await aCreate.settled).toBe('failed');
    expect(await aToggle.settled).toBe('cancelled');
    expect(await aBump.settled).toBe('acked');
    await drained(a.lf);
    await sleep(200);

    const failed = a.events.find(e => e.type === 'failed') as any;
    expect(failed).toBeDefined();
    // The host only forwards `SenderError` messages; anything else arrives as
    // "The instance encountered a fatal error." (see README "Errors").
    expect(String(failed.error?.message ?? failed.error)).toMatch(/already exists/i);
    expect(failed.cancelled.length).toBe(1);

    expect(localView(a.lf)).toEqual(serverView(ca.conn));
    expect(localView(b.lf)).toEqual(serverView(cb.conn));
    expect([...a.lf.db.todos.iter()].map((t: any) => t.title)).toEqual(['B was first']);
    expect(a.lf.db.counters.name.find('independent').value).toBe(5n);
    expect(await server.sqlCount('wl.applied_intents')).toBe(2);

    ca.conn.disconnect();
    cb.conn.disconnect();
    await a.cleanup();
    await b.cleanup();
  });

  it('toggling a todo another client deleted is rejected by the host on reconnect', async () => {
    const a = await openLocal();
    const b = await openLocal();
    const id = uuid();

    const cb = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-wl',
      onDisconnect: () => b.lf.disconnect(),
    });
    attach(b.lf, cb.conn);
    await b.lf.call(mod.createTodo, { id, title: 'doomed' }).settled;
    await drained(b.lf);

    // A comes online, caches the todo, then goes offline.
    let ca = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-wl',
      onDisconnect: () => a.lf.disconnect(),
    });
    attach(a.lf, ca.conn);
    await drained(a.lf);
    // `drained` only covers the outbound queue; the initial subscription state is inbound.
    await waitFor(() => a.lf.db.todos.id.find(id) !== null, { what: 'initial state on A' });
    ca.conn.disconnect();
    await ca.closed;
    expect(a.lf.connected).toBe(false);

    await b.lf.call(mod.deleteTodo, { id }).settled;

    const toggle = a.lf.call(mod.toggleTodo, { id });
    expect(toggle.predicted).toBe(true);
    expect(a.lf.db.todos.id.find(id).done).toBe(true);

    ca = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-wl',
      token: ca.token,
      onDisconnect: () => a.lf.disconnect(),
    });
    attach(a.lf, ca.conn);
    expect(await toggle.settled).toBe('failed');
    await drained(a.lf);
    await sleep(200);
    expect(a.lf.db.todos.id.find(id)).toBeNull();
    expect(localView(a.lf)).toEqual(serverView(ca.conn));

    ca.conn.disconnect();
    cb.conn.disconnect();
    await a.cleanup();
    await b.cleanup();
  });
});
