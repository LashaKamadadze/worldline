/**
 * Scenario (c): what the SDK really does when the server goes away.
 *
 * Findings this test pins down (see README "Reconnecting"):
 *  - A raw `DbConnection` does NOT reconnect by itself. When the socket closes,
 *    `onDisconnect` fires once, `isActive` becomes false, and `onConnect` never
 *    fires again on that object. The SDK's auto-reconnect lives only in the
 *    framework `ConnectionManager` (React/Svelte/... providers), which rebuilds a
 *    *new* DbConnection from the builder and fires `onConnect` again.
 *  - Therefore the documented pattern (create the link in `onConnect`, call
 *    `lf.disconnect()` in `onDisconnect`) is correct for both: every new
 *    connection object gets a fresh link, and subscriptions are re-applied by
 *    the new connection, which replaces the base layer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveServer, waitFor } from '../src/fixture';
import { attach, connect, DbConnection, drained, localView, mod, openLocal, serverView, sleep, uuid } from '../src/client';

let server: LiveServer;

beforeAll(async () => {
  server = await LiveServer.start();
  server.publish();
});

afterAll(async () => {
  await server?.stop();
});

describe('server restart', () => {
  it('raw DbConnection: onDisconnect fires once, no automatic reconnect, onConnect count stays 1', async () => {
    let connects = 0;
    let disconnects = 0;
    const c = await openLocal();
    const first = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-lf',
      onConnect: () => connects++,
      onDisconnect: () => {
        disconnects++;
        c.lf.disconnect();
      },
    });
    attach(c.lf, first.conn);
    await drained(c.lf);
    expect(connects).toBe(1);

    await server.kill('SIGKILL');
    await first.closed;
    expect(first.conn.isActive).toBe(false);
    expect(disconnects).toBe(1);
    expect(c.lf.connected).toBe(false);

    await server.restart();
    await sleep(2500); // longer than the SDK's base reconnect delay, in case it did reconnect
    expect(connects).toBe(1);
    expect(first.conn.isActive).toBe(false);
    await c.cleanup();
  });

  it('application-driven reconnect with the saved token: intents made during the outage are delivered and views converge', async () => {
    const c = await openLocal();
    let token: string | undefined;
    let current: DbConnection | null = null;
    let reconnects = 0;

    // The pattern an app uses: rebuild on disconnect with backoff, reusing the token.
    const link = async (): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await connect({
            wsUrl: server.wsUrl,
            db: 'todo-lf',
            token,
            onDisconnect: () => {
              c.lf.disconnect();
              current = null;
              void link();
            },
          });
          token = r.token;
          current = r.conn;
          reconnects++;
          attach(c.lf, r.conn);
          return;
        } catch {
          await sleep(Math.min(200 * 2 ** attempt, 2000));
        }
      }
    };

    await link();
    const before = uuid();
    await c.lf.call(mod.createTodo, { id: before, title: 'before outage' }).settled;
    await drained(c.lf);
    const identity = c.lf.identity.toHexString();

    await server.kill('SIGKILL');
    await waitFor(() => current === null, { what: 'disconnect callback' });
    // Offline work during the outage.
    const during = uuid();
    const h1 = c.lf.call(mod.createTodo, { id: during, title: 'during outage' });
    const h2 = c.lf.call(mod.toggleTodo, { id: before });
    expect(h1.predicted).toBe(true);
    expect(h2.predicted).toBe(true);

    await server.restart();
    await waitFor(() => current !== null, { timeoutMs: 60_000, what: 'reconnect' });
    expect(await h1.settled).toBe('acked');
    expect(await h2.settled).toBe('acked');
    await drained(c.lf);
    await sleep(200);
    expect(c.lf.identity.toHexString()).toBe(identity); // same principal after reconnect
    expect(reconnects).toBeGreaterThanOrEqual(2);
    expect(localView(c.lf)).toEqual(serverView(current!));
    expect((c.lf.db.todos.id.find(before) as any).done).toBe(true);
    expect(await server.sqlCount('lf.applied_intents')).toBe(3);

    // Stop the reconnect loop before cleanup.
    const last = current! as DbConnection;
    (last as any).__stop = true;
    await c.cleanup(); // lf.disconnect() inside close() disposes the link; the conn stays up
    last.disconnect();
  });
});
