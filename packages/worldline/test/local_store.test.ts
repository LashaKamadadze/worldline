import { Timestamp, Uuid } from 'spacetimedb';
import { errors } from 'spacetimedb/server';
import { describe, expect, it } from 'vitest';
import { CacheMissError, UnpredictableError } from '../src/client/errors';
import { LocalStore, TOMBSTONE } from '../src/client/local_store';
import { tableSpecsFromSchema } from '../src/client/table_spec';
import * as mod from '../src/testing/sample_module';
import * as worldline from '../src/server/index';

const specs = () => tableSpecsFromSchema(mod.default);
const uuid = (n: number) => new Uuid(BigInt(n));

describe('LocalStore', () => {
  it('derives specs from the module schema', () => {
    const s = specs();
    const todos = s.find(t => t.accessorName === 'todos')!;
    expect(todos.sourceName).toBe('todos');
    expect(todos.primaryKey).toBe('id');
    expect(todos.indexes.map(i => i.name)).toContain('id');
    expect(todos.indexes.find(i => i.name === 'id')!.isPrimaryKey).toBe(true);
    const sub = tableSpecsFromSchema(worldline.default, 'wl');
    expect(sub.map(t => t.accessorName).sort()).toEqual([
      'appliedIntents',
      'purgeSchedule',
      'sessions',
    ]);
    expect(sub.find(t => t.accessorName === 'purgeSchedule')!.autoInc.length).toBe(1);
  });

  it('reads through overlay over base and stages writes until commit', () => {
    const store = new LocalStore(specs());
    store.replaceBase('todos', [
      { id: uuid(1), title: 'a', done: false, createdAt: new Timestamp(0n) },
    ]);
    const tx = store.begin();
    expect(tx.db.todos.count()).toBe(1n);
    tx.db.todos.insert({ id: uuid(2), title: 'b', done: false, createdAt: new Timestamp(0n) });
    expect(tx.db.todos.count()).toBe(2n);
    expect(store.count('todos')).toBe(1); // not committed yet
    const { writes, readSet, writeSet } = tx.commit();
    store.applyToOverlay(writes);
    expect(store.count('todos')).toBe(2);
    expect([...readSet]).toContain('todos:*');
    expect([...writeSet].some(w => w.startsWith('todos:'))).toBe(true);
    store.clearOverlay();
    expect(store.count('todos')).toBe(1);
  });

  it('enforces unique constraints across layers with the host error class', () => {
    const store = new LocalStore(specs());
    store.replaceBase('todos', [
      { id: uuid(1), title: 'a', done: false, createdAt: new Timestamp(0n) },
    ]);
    const tx = store.begin();
    expect(() =>
      tx.db.todos.insert({ id: uuid(1), title: 'dup', done: false, createdAt: new Timestamp(0n) })
    ).toThrow(errors.UniqueAlreadyExists);
  });

  it('refuses auto-increment sentinels and clear() when not authoritative', () => {
    const store = new LocalStore(tableSpecsFromSchema(worldline.default, 'wl'));
    const tx = store.begin();
    expect(() =>
      tx.db.wl.purgeSchedule.insert({
        scheduledId: 0n,
        scheduledAt: { tag: 'Interval', value: { __time_duration_micros__: 1n } },
        retentionMicros: 1n,
      })
    ).toThrow(UnpredictableError);
    expect(() => tx.db.wl.purgeSchedule.clear()).toThrow(UnpredictableError);
  });

  it('assigns auto-increment ids in authoritative mode', () => {
    const store = new LocalStore(tableSpecsFromSchema(worldline.default, 'wl'), {
      authoritative: true,
    });
    const tx = store.begin();
    const row = tx.db.wl.purgeSchedule.insert({
      scheduledId: 0n,
      scheduledAt: { tag: 'Interval', value: { __time_duration_micros__: 1n } },
      retentionMicros: 1n,
    });
    expect(row.scheduledId).toBe(1n);
  });

  it('treats a miss as unknown on partially covered tables', () => {
    const store = new LocalStore(specs(), {
      coverage: acc => (acc === 'todos' ? 'partial' : 'full'),
    });
    const tx = store.begin();
    expect(() => tx.db.todos.id.find(uuid(9))).toThrow(CacheMissError);
    expect(tx.db.counters.name.find('nope')).toBeNull();
  });

  it('delete by primary key and by row, tombstones win over base', () => {
    const store = new LocalStore(specs());
    const row = { id: uuid(1), title: 'a', done: false, createdAt: new Timestamp(0n) };
    store.replaceBase('todos', [row]);
    const tx = store.begin();
    expect(tx.db.todos.id.delete(uuid(1))).toBe(true);
    expect(tx.db.todos.id.find(uuid(1))).toBeNull();
    const { writes } = tx.commit();
    expect(writes.get('todos')!.get(store.spec('todos').rowKey(row))).toBe(TOMBSTONE);
    store.applyToOverlay(writes);
    expect(store.count('todos')).toBe(0);
    store.clearOverlay();
    expect(store.count('todos')).toBe(1);
  });

  it('computes deltas when committing to base', () => {
    const store = new LocalStore(specs(), { authoritative: true });
    const tx = store.begin();
    tx.db.counters.insert({ name: 'a', value: 1n });
    const deltas = store.commitToBase(tx.commit().writes);
    expect(deltas.get('counters')!.inserts.length).toBe(1);
    const tx2 = store.begin();
    tx2.db.counters.name.update({ name: 'a', value: 2n });
    const d2 = store.commitToBase(tx2.commit().writes);
    expect(d2.get('counters')!.deletes[0]!.value).toBe(1n);
    expect(d2.get('counters')!.inserts[0]!.value).toBe(2n);
  });
});
