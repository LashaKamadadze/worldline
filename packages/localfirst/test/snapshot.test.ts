import { Timestamp, Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { SnapshotStore } from '../src/client/snapshot';
import { MemoryStorage } from '../src/client/storage/memory';
import { tableSpecsFromSchema } from '../src/client/table_spec';
import * as mod from '../src/testing/sample_module';

const specs = () => new Map(tableSpecsFromSchema(mod.default).map(s => [s.accessorName, s]));
const todo = (n: number) => ({ id: new Uuid(BigInt(n)), title: `t${n}`, done: n % 2 === 0, createdAt: new Timestamp(BigInt(n)) });

describe('SnapshotStore', () => {
  it('round-trips rows and alternates slots with increasing generations', async () => {
    const storage = new MemoryStorage();
    const snap = new SnapshotStore(storage, specs());
    await snap.save(new Map([['todos', [todo(1), todo(2)]], ['counters', [{ name: 'a', value: 5n }]]]), { serverTsMicros: 10n, workingSetHash: 'h' });
    await snap.save(new Map([['todos', [todo(3)]], ['counters', []]]), { serverTsMicros: 20n, workingSetHash: 'h' });
    expect(storage.peek('snapshot.a')).toBeDefined();
    expect(storage.peek('snapshot.b')).toBeDefined();
    const loaded = await new SnapshotStore(storage, specs()).load();
    expect(loaded!.meta.generation).toBe(2n);
    expect(loaded!.meta.serverTsMicros).toBe(20n);
    expect(loaded!.tables.get('todos')!.map(r => r.title)).toEqual(['t3']);
  });

  it('falls back to the older slot when the newer one is torn', async () => {
    const storage = new MemoryStorage();
    const snap = new SnapshotStore(storage, specs());
    await snap.save(new Map([['todos', [todo(1)]], ['counters', []]]), { serverTsMicros: 1n, workingSetHash: 'h' });
    await snap.save(new Map([['todos', [todo(2)]], ['counters', []]]), { serverTsMicros: 2n, workingSetHash: 'h' });
    const b = storage.peek('snapshot.b')!;
    await storage.write('snapshot.b', b.subarray(0, b.length - 3));
    const loaded = await new SnapshotStore(storage, specs()).load();
    expect(loaded!.meta.generation).toBe(1n);
    expect(loaded!.tables.get('todos')![0].title).toBe('t1');
  });

  it('skips tables whose row type changed', async () => {
    const storage = new MemoryStorage();
    const snap = new SnapshotStore(storage, specs());
    await snap.save(new Map([['todos', [todo(1)]], ['counters', [{ name: 'a', value: 1n }]]]), { serverTsMicros: 1n, workingSetHash: 'h' });
    const changed = specs();
    changed.get('todos')!.fingerprint = 'different';
    const loaded = await new SnapshotStore(storage, changed).load();
    expect(loaded!.skipped).toEqual(['todos']);
    expect(loaded!.tables.has('counters')).toBe(true);
  });
});
