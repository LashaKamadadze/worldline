import { ConnectionId, Identity, Timestamp, Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { executeReducer } from '../src/client/executor';
import { LocalStore } from '../src/client/local_store';
import { SeededRng } from '../src/client/rng';
import { tableSpecsFromSchema } from '../src/client/table_spec';
import { LF_INNER, LF_WRAPPED } from '../src/shared/symbols';
import * as localfirst from '../src/server/index';
import { beginSessionBody } from '../src/server/index';
import * as mod from '../src/testing/sample_module';

// A realistic wall-clock instant: the executor asserts timestamps fall in 2000..2200.
const NOW_MICROS = 1_700_000_000_000_123n;
const info = () => ({
  sender: new Identity(7n),
  timestamp: new Timestamp(NOW_MICROS),
  connectionId: null as ConnectionId | null,
  rng: new SeededRng(1),
});

describe('executor', () => {
  it('runs the inner body of an offline reducer against the store', () => {
    const store = new LocalStore(tableSpecsFromSchema(mod.default));
    const inner = (mod.createTodo as any)[LF_INNER];
    expect((mod.createTodo as any)[LF_WRAPPED]).toBe(true);
    const out = executeReducer(store, inner, { id: new Uuid(1n), title: 'x' }, info());
    expect(out.status).toBe('predicted');
    if (out.status === 'predicted') {
      const layer = out.writes.get('todos')!;
      expect(layer.size).toBe(1);
      const row: any = [...layer.values()][0];
      expect(row.createdAt.microsSinceUnixEpoch).toBe(NOW_MICROS); // clientTimestamp
    }
  });

  it('reports a reducer throw as failed and leaves nothing staged', () => {
    const store = new LocalStore(tableSpecsFromSchema(mod.default));
    const out = executeReducer(
      store,
      (mod.createTodo as any)[LF_INNER],
      { id: new Uuid(1n), title: '' },
      info()
    );
    expect(out.status).toBe('failed');
    expect(store.count('todos')).toBe(0);
  });

  it('runs the wrapped export with dedup against namespaced submodule tables', () => {
    const store = authoritativeStore();
    const clientId = new Uuid(500n);
    openSession(store, clientId, 1n);
    const args = {
      id: new Uuid(1n),
      title: 'x',
      intentId: new Uuid(99n),
      clientTs: new Timestamp(NOW_MICROS),
      lfClient: clientId,
      lfEpoch: 1n,
    };
    const first = executeReducer(store, mod.createTodo as any, args, info());
    expect(first.status).toBe('predicted');
    if (first.status !== 'predicted') return;
    store.commitToBase(first.writes);
    expect(store.count('todos')).toBe(1);
    expect(store.count('lf.appliedIntents')).toBe(1);
    // Same intent again: silent no-op.
    const second = executeReducer(store, mod.createTodo as any, args, info());
    expect(second.status).toBe('predicted');
    if (second.status === 'predicted') {
      let n = 0;
      for (const l of second.writes.values()) n += l.size;
      expect(n).toBe(0);
    }
  });

  it('rejects an intent whose session is unknown, stale, or ahead of the server', () => {
    const store = authoritativeStore();
    const clientId = new Uuid(501n);
    openSession(store, clientId, 2n);
    const call = (epoch: bigint, lfClient = clientId, intentId = new Uuid(7n)) =>
      executeReducer(
        store,
        mod.bump as any,
        {
          name: 'a',
          by: 1n,
          intentId,
          clientTs: new Timestamp(NOW_MICROS),
          lfClient,
          lfEpoch: epoch,
        },
        info()
      );
    for (const outcome of [call(1n), call(3n), call(2n, new Uuid(502n))]) {
      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect((outcome.error as Error).message).toBe('stale session');
      }
    }
    expect(store.count('counters')).toBe(0);
    const current = call(2n);
    expect(current.status).toBe('predicted');
    if (current.status === 'predicted') store.commitToBase(current.writes);
    expect(store.count('counters')).toBe(1);
    // Dedup comes first: an applied intent redelivered with an old epoch is a silent no-op.
    const replay = call(1n);
    expect(replay.status).toBe('predicted');
    if (replay.status === 'predicted') {
      let n = 0;
      for (const l of replay.writes.values()) n += l.size;
      expect(n).toBe(0);
    }
  });

  it('begin_session moves epochs forward and binds a client id to its first identity', () => {
    const store = authoritativeStore();
    const clientId = new Uuid(503n);
    const attempt = (epoch: bigint, sender = new Identity(7n)) =>
      executeReducer(
        store,
        (ctx, args) => beginSessionBody(ctx.db.lf, ctx, args as any),
        { clientId, epoch },
        { ...info(), sender }
      );
    expect(attempt(0n).status).toBe('failed');
    openSession(store, clientId, 3n);
    const stale = attempt(3n);
    expect(stale.status).toBe('failed');
    if (stale.status === 'failed') {
      expect((stale.error as Error).message).toBe('stale session epoch');
    }
    const foreign = attempt(4n, new Identity(8n));
    expect(foreign.status).toBe('failed');
    if (foreign.status === 'failed')
      expect((foreign.error as Error).message).toBe('client id belongs to another identity');
    const next = attempt(4n);
    expect(next.status).toBe('predicted');
    if (next.status === 'predicted') store.commitToBase(next.writes);
    expect(store.count('lf.sessions')).toBe(1);
  });
});

function authoritativeStore(): LocalStore {
  const specs = [
    ...tableSpecsFromSchema(mod.default),
    ...tableSpecsFromSchema(localfirst.default, 'lf'),
  ];
  return new LocalStore(specs, { authoritative: true });
}

/** Run the handshake against the store exactly as the fake server does. */
function openSession(store: LocalStore, clientId: Uuid, epoch: bigint): void {
  const out = executeReducer(
    store,
    (ctx, args) => beginSessionBody(ctx.db.lf, ctx, args as any),
    { clientId, epoch },
    info()
  );
  expect(out.status).toBe('predicted');
  if (out.status === 'predicted') store.commitToBase(out.writes);
}
