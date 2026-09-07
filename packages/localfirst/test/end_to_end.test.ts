import { Identity, Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { LocalFirst } from '../src/client/local_first';
import { SeededRng } from '../src/client/rng';
import { bindingsFromModule } from '../src/testing/bindings';
import { FakeLink, LAN } from '../src/testing/fake_network';
import { FakeServer } from '../src/testing/fake_server';
import { FaultyStorage } from '../src/testing/faulty_storage';
import * as mod from '../src/testing/sample_module';
import * as localfirst from '../src/server/index';
import { VirtualScheduler } from '../src/testing/scheduler';

const bindings = bindingsFromModule(mod as any);

function world(seed = 1) {
  const rng = new SeededRng(seed);
  const sched = new VirtualScheduler();
  sched.timeMicros = 1_700_000_000_000_000n;
  const clock = () => sched.timeMicros;
  const server = new FakeServer(
    mod as any,
    bindings,
    { lf: localfirst },
    clock,
    new SeededRng(seed + 1)
  );
  const identity = new Identity(42n);
  const storage = new FaultyStorage(new SeededRng(seed + 2));
  const open = async (st = storage) =>
    LocalFirst.open({
      module: mod as any,
      reducers: bindings,
      storage: st,
      workingSet: { queries: ['SELECT * FROM todos', 'SELECT * FROM counters'] },
      identity,
      clock,
      rng: new SeededRng(seed + 3),
      snapshotDebounceMs: null,
    });
  const link = (plan = LAN) => new FakeLink(server, sched, new SeededRng(seed + 4), plan, identity);
  return { rng, sched, server, storage, open, link, identity };
}

describe('end to end against the fake server', () => {
  it('predicts offline, syncs on connect, converges with the server', async () => {
    const w = world();
    const lf = await w.open();
    const id = new Uuid(1n);
    const h = lf.call(mod.createTodo, { id, title: 'buy milk' });
    expect(h.predicted).toBe(true);
    expect(lf.db.todos.id.find(id)?.title).toBe('buy milk');
    await h.durable;
    lf.call(mod.toggleTodo, { id });
    expect(lf.db.todos.id.find(id)?.done).toBe(true);
    expect(lf.pending().length).toBe(2);

    const link = w.link();
    link.connect();
    lf.connect(link);
    await w.sched.runUntilIdle();
    expect(await h.settled).toBe('acked');
    expect(lf.pending().length).toBe(0);
    expect(w.server.snapshot().get('todos')![0]!.done).toBe(true);
    expect(lf.db.todos.id.find(id)?.done).toBe(true);
    expect(lf.store.hasOverlay()).toBe(false);
    await lf.close();
  });

  it('survives a restart: pending intents replay from the log, then deliver once', async () => {
    const w = world(7);
    let lf = await w.open();
    const id = new Uuid(5n);
    await lf.call(mod.createTodo, { id, title: 'persisted' }).durable;
    await lf.call(mod.bump, { name: 'a', by: 2n }).durable;
    await lf.close();

    const disk = w.storage.crash();
    lf = await w.open(disk);
    expect(lf.pending().length).toBe(2);
    expect(lf.db.todos.id.find(id)?.title).toBe('persisted');
    expect(lf.db.counters.name.find('a')?.value).toBe(2n);

    const link = w.link();
    link.connect();
    lf.connect(link);
    await w.sched.runUntilIdle();
    expect(lf.pending().length).toBe(0);
    expect(w.server.snapshot().get('counters')![0]!.value).toBe(2n);
    expect(w.server.effectRuns.size).toBe(2);
    await lf.close();
  });

  it('resends after a lost ack and the server applies the intent exactly once', async () => {
    const w = world(11);
    const lf = await w.open();
    const id = new Uuid(9n);
    const h = lf.call(mod.createTodo, { id, title: 'once' });
    await h.durable;
    const flaky = w.link({ ...LAN, dropAck: 1 });
    flaky.connect();
    lf.connect(flaky);
    await w.sched.runUntilIdle();
    expect(w.server.snapshot().get('todos')!.length).toBe(1);
    expect(lf.pending().length).toBe(1); // still waiting: ack never came
    lf.disconnect();
    flaky.disconnect();
    const good = w.link();
    good.connect();
    lf.connect(good);
    await w.sched.runUntilIdle();
    expect(await h.settled).toBe('acked');
    expect(w.server.executions.filter(e => e.reducer === 'create_todo').length).toBe(2);
    expect(w.server.executions.filter(e => e.duplicate).length).toBe(1);
    expect([...w.server.effectRuns.values()]).toEqual([1]);
    expect(w.server.snapshot().get('todos')!.length).toBe(1);
    await lf.close();
  });

  it('rejects on the server, cancels dependents, and rebases the rest', async () => {
    const w = world(13);
    const lf = await w.open();
    const id = new Uuid(21n);
    // Someone else creates the todo first, so our create will fail on the server.
    const other = await w.open(new FaultyStorage(new SeededRng(99)));
    const ol = w.link();
    ol.connect();
    other.connect(ol);
    await other.call(mod.createTodo, { id, title: 'theirs' }).durable;
    await w.sched.runUntilIdle();
    await other.close();

    const create = lf.call(mod.createTodo, { id, title: 'mine' });
    const toggle = lf.call(mod.toggleTodo, { id });
    const bump = lf.call(mod.bump, { name: 'z', by: 1n });
    await bump.durable;
    const events: string[] = [];
    lf.onIntent(ev => events.push(ev.type));

    const link = w.link();
    link.connect();
    lf.connect(link);
    await w.sched.runUntilIdle();
    expect(await create.settled).toBe('failed');
    expect(await toggle.settled).toBe('cancelled');
    expect(await bump.settled).toBe('acked');
    expect(lf.db.todos.id.find(id)?.title).toBe('theirs');
    expect(lf.db.counters.name.find('z')?.value).toBe(1n);
    expect(events).toContain('failed');
    expect(events).toContain('cancelled');
    await lf.close();
  });

  it('rejects locally what the server would reject', async () => {
    const w = world(17);
    const lf = await w.open();
    expect(() => lf.call(mod.createTodo, { id: new Uuid(1n), title: '' })).toThrow(
      'title must not be empty'
    );
    expect(() => lf.call(mod.toggleTodo, { id: new Uuid(404n) })).toThrow('no such todo');
    expect(lf.pending().length).toBe(0);
    await lf.close();
  });

  it('queues without prediction when a partially covered table misses', async () => {
    const w = world(19);
    const lf = await LocalFirst.open({
      module: mod as any,
      reducers: bindings,
      storage: w.storage,
      workingSet: {
        queries: ['SELECT * FROM todos WHERE done = false'],
        coverage: { todos: 'partial' },
      },
      identity: w.identity,
      clock: () => w.sched.timeMicros,
      snapshotDebounceMs: null,
    });
    const h = lf.call(mod.toggleTodo, { id: new Uuid(77n) });
    expect(h.predicted).toBe(false);
    expect(lf.pending().length).toBe(1);
    await lf.close();
  });

  it('snapshots base only and boots offline from it', async () => {
    const w = world(23);
    const lf = await w.open();
    const link = w.link();
    link.connect();
    lf.connect(link);
    await lf.call(mod.createTodo, { id: new Uuid(3n), title: 'server-side' }).durable;
    await w.sched.runUntilIdle();
    await lf.call(mod.createTodo, { id: new Uuid(4n), title: 'still pending' }).durable;
    lf.disconnect();
    await lf.snapshotNow();
    await lf.close();

    const again = await w.open(w.storage.crash());
    expect(again.db.todos.id.find(new Uuid(3n))?.title).toBe('server-side');
    expect(again.db.todos.id.find(new Uuid(4n))?.title).toBe('still pending');
    expect(again.db.todos.count()).toBe(2n);
    expect(again.pending().length).toBe(1);
    await again.close();
  });
});

describe('options', () => {
  it('strict calls throw instead of queueing unpredicted', async () => {
    const w = world(29);
    const lf = await LocalFirst.open({
      module: mod as any,
      reducers: bindings,
      storage: w.storage,
      workingSet: { queries: ['SELECT * FROM todos'], coverage: { todos: 'partial' } },
      identity: w.identity,
      clock: () => w.sched.timeMicros,
      snapshotDebounceMs: null,
    });
    expect(() => lf.call(mod.toggleTodo, { id: new Uuid(1n) }, { strict: true })).toThrow(
      /cache miss/
    );
    expect(lf.pending().length).toBe(0);
    await lf.close();
  });

  it('beforeDrain gates sending until it resolves', async () => {
    const w = world(31);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let calls = 0;
    const lf = await LocalFirst.open({
      module: mod as any,
      reducers: bindings,
      storage: w.storage,
      workingSet: { queries: ['SELECT * FROM todos', 'SELECT * FROM counters'] },
      identity: w.identity,
      clock: () => w.sched.timeMicros,
      snapshotDebounceMs: null,
      beforeDrain: async () => {
        calls++;
        await gate;
      },
    });
    const h = lf.call(mod.bump, { name: 'g', by: 1n });
    const link = w.link();
    link.connect();
    lf.connect(link);
    await w.sched.runUntilIdle();
    expect(calls).toBe(1);
    expect(link.calls).toBe(0);
    release();
    await w.sched.runUntilIdle();
    expect(await h.settled).toBe('acked');
    await lf.close();
  });

  it('stores expose merged rows and pending state reactively', async () => {
    const { tableStore, pendingStore } = await import('../src/client/stores');
    const w = world(37);
    const lf = await w.open();
    const seen: number[] = [];
    const unsub = tableStore(lf, 'todos').subscribe(rows => seen.push(rows.length));
    const p = pendingStore(lf);
    lf.call(mod.createTodo, { id: new Uuid(1n), title: 'a' });
    expect(seen).toEqual([0, 1]);
    expect(p.getSnapshot().count).toBe(1);
    unsub();
    await lf.close();
  });
});
