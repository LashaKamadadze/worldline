/**
 * Scenario (b): the socket dies while intents are in flight.
 *
 * Intents are sent, the connection is torn down before the acks arrive (from the
 * client side, and separately by SIGKILLing the server), then a new connection
 * resends whatever is still pending. The real host's `applied_intents` dedup
 * must make every intent take effect exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveServer } from '../src/fixture';
import {
  attach,
  connect,
  drained,
  localView,
  mod,
  openLocal,
  serverView,
  sleep,
} from '../src/client';

let server: LiveServer;

beforeAll(async () => {
  server = await LiveServer.start();
  server.publish();
});

afterAll(async () => {
  await server?.stop();
});

describe('socket killed mid-flight', () => {
  it('client-side disconnect right after sending: exactly-once on the server', async () => {
    const c = await openLocal({ inflightWindow: 8 });
    const rounds = 4;
    const perRound = 6;
    let token: string | undefined;
    for (let r = 0; r < rounds; r++) {
      const handles = [];
      for (let i = 0; i < perRound; i++) {
        handles.push(c.lf.call(mod.bump, { name: `k${i}`, by: 1n }));
      }
      await Promise.all(handles.map(h => h.durable));
      const conn = await connect({
        wsUrl: server.wsUrl,
        db: 'todo-lf',
        token,
        onDisconnect: () => c.lf.disconnect(),
      });
      token = conn.token;
      attach(c.lf, conn.conn);
      // Sends happen synchronously inside attach(); kill the socket before any ack.
      conn.conn.disconnect();
      await conn.closed;
      expect(c.lf.connected).toBe(false);
      expect(c.lf.pending().length).toBeGreaterThan(0);
      // Give the server time to process whatever got through the socket.
      await sleep(150);

      const again = await connect({
        wsUrl: server.wsUrl,
        db: 'todo-lf',
        token,
        onDisconnect: () => c.lf.disconnect(),
      });
      attach(c.lf, again.conn);
      await Promise.all(handles.map(h => h.settled));
      for (const h of handles) expect(await h.settled).toBe('acked');
      await drained(c.lf);
      await sleep(100);
      expect(localView(c.lf)).toEqual(serverView(again.conn));
      again.conn.disconnect();
      await again.closed;
    }
    // Every counter was bumped exactly `rounds` times.
    const rows = await server.sqlRows('SELECT * FROM counters');
    expect(rows.length).toBe(perRound);
    for (const row of rows) expect(Number(row[1])).toBe(rounds);
    expect(await server.sqlCount('lf.applied_intents')).toBe(rounds * perRound);
    await c.cleanup();
  });

  it('server SIGKILLed mid-flight and restarted: client converges after reconnect', async () => {
    const c = await openLocal({ inflightWindow: 4 });
    const handles = [1, 2, 3, 4].map(i => c.lf.call(mod.bump, { name: `crash${i}`, by: 10n }));
    await Promise.all(handles.map(h => h.durable));

    const first = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-lf',
      onDisconnect: () => c.lf.disconnect(),
    });
    attach(c.lf, first.conn);
    await server.kill('SIGKILL');
    await first.closed;
    expect(c.lf.connected).toBe(false);

    await server.restart();
    const again = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-lf',
      token: first.token,
      onDisconnect: () => c.lf.disconnect(),
    });
    attach(c.lf, again.conn);
    for (const h of handles) expect(await h.settled).toBe('acked');
    await drained(c.lf);
    await sleep(100);
    expect(localView(c.lf)).toEqual(serverView(again.conn));
    for (let i = 1; i <= 4; i++) {
      expect(c.lf.db.counters.name.find(`crash${i}`).value).toBe(10n);
    }
    again.conn.disconnect();
    await c.cleanup();
  });
});
