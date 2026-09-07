import { ConnectionId, Identity, Timestamp, Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { executeReducer } from '../src/client/executor';
import { LocalStore } from '../src/client/local_store';
import { SeededRng } from '../src/client/rng';
import { tableSpecsFromSchema } from '../src/client/table_spec';
import { LF_INNER, LF_WRAPPED } from '../src/shared/symbols';
import * as localfirst from '../src/server/index';
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
    const specs = [
      ...tableSpecsFromSchema(mod.default),
      ...tableSpecsFromSchema(localfirst.default, 'lf'),
    ];
    const store = new LocalStore(specs, { authoritative: true });
    const args = {
      id: new Uuid(1n),
      title: 'x',
      intentId: new Uuid(99n),
      clientTs: new Timestamp(NOW_MICROS),
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
});
