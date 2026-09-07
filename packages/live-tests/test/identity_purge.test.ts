/**
 * Scenarios (f) and (g): purge schedule row, applied_intents bookkeeping, and
 * identity propagation from the SDK connection into predictions and server rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveServer } from '../src/fixture';
import { attach, connect, drained, mod, openLocal, sleep, uuid } from '../src/client';

let server: LiveServer;

beforeAll(async () => {
  server = await LiveServer.start();
  server.publish();
});

afterAll(async () => {
  await server?.stop();
});

describe('purge schedule and applied_intents', () => {
  it('init installed exactly one purge schedule row with the default retention', async () => {
    const rows = await server.sqlRows('SELECT * FROM lf.purge_schedule');
    expect(rows.length).toBe(1);
    const [, scheduledAt, retention] = rows[0] as any[];
    // SATS JSON encodes a sum as [variant_index, payload]; Interval is variant 0
    // and its payload is the duration in microseconds.
    expect(scheduledAt[0]).toBe(0);
    expect(BigInt(scheduledAt[1][0])).toBe(60n * 60n * 1_000_000n);
    expect(BigInt(retention)).toBe(30n * 24n * 60n * 60n * 1_000_000n);
  });

  it('acked intents leave one applied_intents row each, stamped with the sender', async () => {
    const c = await openLocal();
    const conn = await connect({ wsUrl: server.wsUrl, db: 'todo-lf', onDisconnect: () => c.lf.disconnect() });
    attach(c.lf, conn.conn);
    const handles = [1, 2, 3].map(i => c.lf.call(mod.bump, { name: 'p', by: BigInt(i) }));
    for (const h of handles) expect(await h.settled).toBe('acked');
    await drained(c.lf);
    const rows = await server.sqlRows('SELECT * FROM lf.applied_intents');
    expect(rows.length).toBe(3);
    console.log('applied_intents row shape:', JSON.stringify(rows[0]));
    const ids = new Set(handles.map(h => h.intentId.asBigInt().toString()));
    for (const row of rows as any[]) {
      // SATS JSON: uuid is its u128 as a number/string, identity is hex.
      expect(ids.has(uuidJsonToBigint(row[0]).toString())).toBe(true);
      const identityJson = Array.isArray(row[1]) ? row[1][0] : row[1];
      expect(String(identityJson).replace(/^0x/, '').toLowerCase()).toBe(conn.identity.toHexString());
    }
    conn.conn.disconnect();
    await c.cleanup();
  });
});

/**
 * SATS JSON encodes the uuid product as `[<u128>]` and identity as `["0x..."]`.
 * The fixture quotes long integers so the u128 survives JSON.parse.
 */
function uuidJsonToBigint(v: unknown): bigint {
  if (Array.isArray(v) && v.length === 1) return uuidJsonToBigint(v[0]);
  if (typeof v === 'number' || typeof v === 'bigint') return BigInt(v);
  const s = String(v);
  if (/^[0-9a-f-]{36}$/i.test(s)) return BigInt('0x' + s.replace(/-/g, ''));
  if (/^0x/i.test(s)) return BigInt(s);
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  if (/^[0-9a-f]{32}$/i.test(s)) return BigInt('0x' + s);
  throw new Error(`unrecognised uuid JSON: ${JSON.stringify(v)}`);
}

describe('identity', () => {
  it('lf.identity follows the connection, and ctx.sender on the host is that identity', async () => {
    const c = await openLocal();
    const offline = c.lf.identity.toHexString();
    const conn = await connect({ wsUrl: server.wsUrl, db: 'todo-lf', onDisconnect: () => c.lf.disconnect() });
    attach(c.lf, conn.conn);
    expect(c.lf.identity.toHexString()).toBe(conn.identity.toHexString());
    expect(c.lf.identity.toHexString()).not.toBe(offline);

    const id = uuid();
    const h = c.lf.call(mod.createTodo, { id, title: 'mine' });
    // Predicted owner is already the real identity.
    expect((c.lf.db.todos.id.find(id) as any).owner.toHexString()).toBe(conn.identity.toHexString());
    expect(await h.settled).toBe('acked');
    await drained(c.lf);
    await sleep(100);
    const serverRow = conn.conn.db.todos.id.find(id) as any;
    expect(serverRow.owner.toHexString()).toBe(conn.identity.toHexString());

    // A second connection with the saved token is the same principal.
    conn.conn.disconnect();
    await conn.closed;
    const again = await connect({ wsUrl: server.wsUrl, db: 'todo-lf', token: conn.token });
    expect(again.identity.toHexString()).toBe(conn.identity.toHexString());
    again.conn.disconnect();
    await c.cleanup();
  });
});
