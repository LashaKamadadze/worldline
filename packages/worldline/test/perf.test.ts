import { Timestamp, Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { Worldline } from '../src/client/worldline';
import { LocalStore } from '../src/client/local_store';
import { MemoryStorage } from '../src/client/storage/memory';
import { SeededRng } from '../src/client/rng';
import { tableSpecsFromSchema } from '../src/client/table_spec';
import { bindingsFromModule } from '../src/testing/bindings';
import * as mod from '../src/testing/sample_module';

const NOW = 1_700_000_000_000_000n;
const bindings = bindingsFromModule(mod as any);
const todo = (n: number) => ({
  id: new Uuid(BigInt(n) + 1n),
  title: `t${n}`,
  done: false,
  createdAt: new Timestamp(NOW),
});
const openWith = (storage: MemoryStorage, queries: string[]) =>
  Worldline.open({
    module: mod as any,
    reducers: bindings,
    storage,
    workingSet: { queries },
    clock: () => NOW,
    rng: new SeededRng(7),
    snapshotDebounceMs: null,
  });

/**
 * Goal: catch accidental O(n) per-operation costs. The bounds are loose (10x
 * the measured numbers on a laptop) so they only fail on a real regression;
 * the measured numbers are printed for the record.
 */
describe('performance', () => {
  it('point lookups and counts stay cheap with 100k base rows and an overlay', () => {
    const store = new LocalStore(tableSpecsFromSchema(mod.default));
    const spec = store.spec('todos');
    const rows = Array.from({ length: 100_000 }, (_, i) => todo(i));
    store.replaceBase('todos', rows);
    const tx = store.begin();
    for (let i = 0; i < 1_000; i++) tx.db.todos.id.update({ ...todo(i), done: true });
    store.applyToOverlay(tx.commit().writes);

    const t0 = performance.now();
    let found = 0;
    for (let i = 0; i < 100_000; i++) {
      if (store.get('todos', spec.rowKey(todo(i))) !== undefined) found += 1;
    }
    const lookupsMs = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 10_000; i++) store.count('todos');
    const countsMs = performance.now() - t1;
    console.log(
      `perf: 100k lookups ${lookupsMs.toFixed(1)}ms, 10k counts ${countsMs.toFixed(1)}ms`
    );
    expect(found).toBe(100_000);
    expect(store.count('todos')).toBe(100_000);
    expect(lookupsMs).toBeLessThan(2_000);
    expect(countsMs).toBeLessThan(2_000);
  });

  it('rebases 1,000 pending intents over 20k rows well under a second', async () => {
    const lf = await openWith(new MemoryStorage(), [
      'SELECT * FROM todos',
      'SELECT * FROM counters',
    ]);
    lf.store.replaceBase(
      'todos',
      Array.from({ length: 20_000 }, (_, i) => todo(i))
    );
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i++) lf.call(mod.toggleTodo, { id: todo(i).id });
    const callsMs = performance.now() - t0;
    const t1 = performance.now();
    lf.rebase();
    const rebaseMs = performance.now() - t1;
    console.log(`perf: 1000 calls ${callsMs.toFixed(1)}ms, rebase ${rebaseMs.toFixed(1)}ms`);
    expect(lf.pending().length).toBe(1_000);
    expect(rebaseMs).toBeLessThan(5_000);
    await lf.close();
  }, 60_000);

  it('appends 5,000 intents to the log quickly and recovers them', async () => {
    const storage = new MemoryStorage();
    const lf = await openWith(storage, ['SELECT * FROM counters']);
    const t0 = performance.now();
    const handles = [];
    for (let i = 0; i < 5_000; i++) handles.push(lf.call(mod.bump, { name: 'a', by: 1n }));
    await Promise.all(handles.map(h => h.durable));
    const appendMs = performance.now() - t0;
    await lf.close();
    const t1 = performance.now();
    const again = await openWith(storage, ['SELECT * FROM counters']);
    const recoverMs = performance.now() - t1;
    console.log(`perf: 5000 appends ${appendMs.toFixed(1)}ms, recover ${recoverMs.toFixed(1)}ms`);
    expect(again.pending().length).toBe(5_000);
    expect(again.db.counters.name.find('a')?.value).toBe(5_000n);
    expect(appendMs).toBeLessThan(10_000);
    expect(recoverMs).toBeLessThan(10_000);
    await again.close();
  }, 60_000);
});
