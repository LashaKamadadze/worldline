/**
 * Smoke: the fixture works end to end. Start a server, publish, connect one
 * Worldline client, make an offline call, sync, and compare with the server.
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

describe('smoke', () => {
  it('offline call, then sync, then equal views', async () => {
    const c = await openLocal();
    const id = uuid();
    const h = c.lf.call(mod.createTodo, { id, title: 'smoke' });
    await h.durable;
    expect(c.lf.pending().length).toBe(1);

    const { conn } = await connect({
      wsUrl: server.wsUrl,
      db: 'todo-wl',
      onDisconnect: () => c.lf.disconnect(),
    });
    attach(c.lf, conn);
    expect(await h.settled).toBe('acked');
    await drained(c.lf);
    expect(localView(c.lf)).toEqual(serverView(conn));
    expect(await server.sqlCount('wl.applied_intents')).toBe(1);
    conn.disconnect();
    await c.cleanup();
  });
});
