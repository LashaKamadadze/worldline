import { Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { LocalFirst } from '../src/client/local_first';
import { LocalFirstError } from '../src/client/errors';
import { MemoryStorage } from '../src/client/storage/memory';
import { SeededRng } from '../src/client/rng';
import { INTENTS_PENDING_MAX, INTENT_ARGS_BYTES_MAX } from '../src/shared/limits';
import { bindingsFromModule } from '../src/testing/bindings';
import * as mod from '../src/testing/sample_module';
import { AssertionError } from '../src/shared/assert';

const bindings = bindingsFromModule(mod as any);
const NOW = 1_700_000_000_000_000n;

const open = (storage: MemoryStorage, extra: Record<string, unknown> = {}) =>
  LocalFirst.open({
    module: mod as any,
    reducers: bindings,
    storage,
    workingSet: { queries: ['SELECT * FROM todos', 'SELECT * FROM counters'] },
    clock: () => NOW,
    rng: new SeededRng(1),
    snapshotDebounceMs: null,
    ...extra,
  });

/**
 * Goal: every documented limit is enforced, and the behaviour at the boundary
 * (valid data becoming invalid) is a clean error, never a corrupt state.
 */
describe('limits', () => {
  it('refuses the intent past INTENTS_PENDING_MAX and stays consistent', async () => {
    const lf = await open(new MemoryStorage());
    for (let i = 0; i < INTENTS_PENDING_MAX; i++) lf.call(mod.bump, { name: 'a', by: 1n });
    expect(lf.pending().length).toBe(INTENTS_PENDING_MAX);
    expect(() => lf.call(mod.bump, { name: 'a', by: 1n })).toThrow(LocalFirstError);
    expect(lf.pending().length).toBe(INTENTS_PENDING_MAX);
    expect(lf.db.counters.name.find('a')?.value).toBe(BigInt(INTENTS_PENDING_MAX));
    await lf.close();
  }, 60_000);

  it('refuses arguments larger than INTENT_ARGS_BYTES_MAX', async () => {
    const lf = await open(new MemoryStorage());
    const title = 'x'.repeat(INTENT_ARGS_BYTES_MAX + 1);
    expect(() => lf.call(mod.createTodo, { id: new Uuid(1n), title })).toThrow(LocalFirstError);
    expect(lf.pending().length).toBe(0);
    await lf.close();
  });

  it('rejects an inflight window outside 1..INFLIGHT_WINDOW_MAX', async () => {
    await expect(open(new MemoryStorage(), { inflightWindow: 0 })).rejects.toThrow(AssertionError);
    await expect(open(new MemoryStorage(), { inflightWindow: 1000 })).rejects.toThrow(
      AssertionError
    );
  });

  it('a second instance on the same storage is refused, and allowed after close', async () => {
    const storage = new MemoryStorage();
    const first = await open(storage);
    await expect(open(storage)).rejects.toThrow(/locked/);
    await first.close();
    const second = await open(storage);
    await second.close();
  });

  it('validates storage names in every adapter', async () => {
    const storage = new MemoryStorage();
    await expect(storage.read('../etc/passwd')).rejects.toThrow(AssertionError);
    await expect(storage.write('a/b', new Uint8Array())).rejects.toThrow(AssertionError);
    await expect(storage.append('', new Uint8Array())).rejects.toThrow(AssertionError);
  });

  it('refuses calls after close', async () => {
    const lf = await open(new MemoryStorage());
    await lf.close();
    expect(() => lf.call(mod.bump, { name: 'a', by: 1n })).toThrow(AssertionError);
  });
});
