import { BinaryWriter, Identity, ProductType, Timestamp, Uuid, deepEqual } from 'spacetimedb';
import { LocalFirst, type CallHandle, type IntentEvent } from '../client/local_first';
import { idKey } from '../client/intent_log';
import { SeededRng } from '../client/rng';
import { bindingsFromModule } from './bindings';
import { FakeServer } from './fake_server';
import { FakeLink, LAN, type NetworkPlan } from './fake_network';
import { FaultyStorage, NO_FAULTS, type FaultPlan } from './faulty_storage';
import { VirtualScheduler } from './scheduler';
import * as sampleModule from './sample_module';
import * as localfirst from '../server/index';

export interface SimOptions {
  seed: number;
  steps?: number;
  clients?: number;
  faults?: Partial<FaultPlan>;
  network?: Partial<NetworkPlan>;
  /** Probabilities per step. */
  weights?: Partial<Record<Action, number>>;
  trace?: boolean;
}

type Action = 'call' | 'toggleLink' | 'crash' | 'foreign' | 'snapshot' | 'tick' | 'restartServerlessTick';

export interface SimReport {
  seed: number;
  steps: number;
  calls: number;
  localRejects: number;
  acked: number;
  failed: number;
  cancelled: number;
  volatile: number;
  crashes: number;
  tornRecoveries: number;
  faults: FaultyStorage['stats'];
  serverExecutions: number;
  serverDuplicates: number;
  violations: string[];
}

interface Ledger {
  durable: 'pending' | 'ok' | 'rejected';
  status?: 'acked' | 'failed' | 'cancelled';
  predicted: boolean;
}

class SimClient {
  lf!: LocalFirst;
  link!: FakeLink;
  storage: FaultyStorage;
  identity: Identity;
  ledger = new Map<string, Ledger>();
  known: Uuid[] = [];
  crashes = 0;
  tornRecoveries = 0;
  wantConnected = false;
  unsubEvents: (() => void) | null = null;

  constructor(storage: FaultyStorage, identity: Identity) {
    this.storage = storage;
    this.identity = identity;
  }
}

const DEFAULT_WEIGHTS: Record<Action, number> = {
  call: 45,
  toggleLink: 10,
  crash: 5,
  foreign: 12,
  snapshot: 4,
  tick: 28,
  restartServerlessTick: 0,
};

export async function runSimulation(opts: SimOptions): Promise<SimReport> {
  const rng = new SeededRng(opts.seed);
  const sched = new VirtualScheduler();
  sched.timeMicros = 1_700_000_000_000_000n;
  const clock = () => sched.timeMicros;
  const faults: FaultPlan = { ...NO_FAULTS, ...opts.faults };
  const network: NetworkPlan = { ...LAN, ...opts.network };
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const steps = opts.steps ?? 200;
  const nClients = opts.clients ?? 1;
  const violations: string[] = [];
  const trace = (msg: string) => {
    if (opts.trace) console.log(`[t=${sched.timeMicros}] ${msg}`);
  };

  const mod = sampleModule as Record<string, any>;
  const bindings = bindingsFromModule(mod);
  const server = new FakeServer(mod, bindings, { lf: localfirst }, clock, new SeededRng(opts.seed ^ 0x5eed));
  // Foreign writers (other users) share the server but have no local-first client.
  const foreignIdentity = new Identity(0xf0f0f0n);

  const clients: SimClient[] = [];
  const stats = { calls: 0, localRejects: 0, acked: 0, failed: 0, cancelled: 0 };

  const attachEvents = (c: SimClient) => {
    c.unsubEvents?.();
    c.unsubEvents = c.lf.onIntent((ev: IntentEvent) => {
      if (ev.type === 'acked' || ev.type === 'failed' || ev.type === 'cancelled') {
        const key = idKey(ev.intent.intentId);
        const l = c.ledger.get(key);
        if (l) {
          if (l.status && l.status !== ev.type) violations.push(`intent ${key} settled twice: ${l.status} then ${ev.type}`);
          l.status = ev.type;
        }
        stats[ev.type]++;
      }
    });
  };

  const openClient = async (c: SimClient) => {
    c.lf = await LocalFirst.open({
      module: mod,
      reducers: bindings,
      storage: c.storage,
      workingSet: { queries: ['SELECT * FROM todos', 'SELECT * FROM counters'] },
      identity: c.identity,
      clock,
      rng: new SeededRng(rng.u32()),
      inflightWindow: rng.pick([1, 1, 1, 2, 4]),
      snapshotDebounceMs: null,
      compactEvery: rng.pick([1, 4, 64]),
    });
    if (c.lf.log.recovery.torn) c.tornRecoveries++;
    attachEvents(c);
    c.link = new FakeLink(server, sched, new SeededRng(rng.u32()), network, c.identity);
    if (c.wantConnected) {
      c.link.connect();
      c.lf.connect(c.link);
    }
  };

  for (let i = 0; i < nClients; i++) {
    const c = new SimClient(new FaultyStorage(new SeededRng(rng.u32()), faults), new Identity(BigInt(1000 + i)));
    c.wantConnected = rng.chance(0.5);
    await openClient(c);
    clients.push(c);
  }

  const pickAction = (): Action => {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = rng.float() * total;
    for (const [a, w] of Object.entries(weights) as [Action, number][]) {
      if ((r -= w) < 0) return a;
    }
    return 'tick';
  };

  const doCall = (c: SimClient) => {
    const kind = rng.pick(['create', 'create', 'toggle', 'delete', 'bump'] as const);
    let reducer: Function;
    let args: Record<string, any>;
    if (kind === 'create') {
      const id = Uuid.fromRandomBytesV4(rng.fill(new Uint8Array(16)));
      reducer = mod.createTodo;
      args = { id, title: rng.chance(0.05) ? '' : `todo-${rng.u32() % 1000}` };
      c.known.push(id);
    } else if (kind === 'bump') {
      reducer = mod.bump;
      args = { name: rng.pick(['a', 'b', 'c']), by: BigInt(rng.int(-3, 5)) };
    } else {
      const id = c.known.length && !rng.chance(0.1) ? rng.pick(c.known) : Uuid.fromRandomBytesV4(rng.fill(new Uint8Array(16)));
      reducer = kind === 'toggle' ? mod.toggleTodo : mod.deleteTodo;
      args = { id };
    }
    let handle: CallHandle;
    try {
      handle = c.lf.call(reducer, args);
    } catch (e) {
      stats.localRejects++;
      trace(`client ${c.identity} local reject ${kind}: ${(e as Error).message}`);
      return;
    }
    stats.calls++;
    const key = idKey(handle.intentId);
    const l: Ledger = { durable: 'pending', predicted: handle.predicted };
    c.ledger.set(key, l);
    handle.durable.then(
      () => {
        l.durable = 'ok';
      },
      () => {
        l.durable = 'rejected';
      }
    );
    trace(`client ${c.identity} call ${kind} -> ${key} predicted=${handle.predicted}`);
  };

  const doCrash = async (c: SimClient) => {
    // What survives: only what the storage adapter reported durable.
    const durableUnsettled = new Set<string>();
    for (const [k, l] of c.ledger) if (l.durable === 'ok' && !l.status) durableUnsettled.add(k);
    const inLogBefore = new Set(c.lf.pending().map(r => idKey(r.intentId)));
    await c.lf.close();
    c.link.dispose();
    c.storage = c.storage.crash();
    c.crashes++;
    trace(`client ${c.identity} CRASH`);
    await openClient(c);
    const after = new Set(c.lf.pending().map(r => idKey(r.intentId)));
    for (const k of durableUnsettled) {
      if (!after.has(k)) violations.push(`intent ${k} was reported durable but vanished after crash`);
    }
    for (const k of after) {
      const l = c.ledger.get(k);
      if (!l) {
        violations.push(`intent ${k} appeared after crash but was never issued`);
        continue;
      }
      if (l.status) {
        // Its mark append failed before the crash; it will be resent and dedup'd on the server.
        l.status = undefined;
      }
    }
    void inLogBefore;
    // Volatile intents (durable rejected) are gone by contract.
    for (const [k, l] of c.ledger) if (l.durable === 'rejected' && !l.status && !after.has(k)) l.status = undefined;
  };

  const doForeign = () => {
    const kind = rng.pick(['create', 'toggle', 'delete', 'bump'] as const);
    const tables = server.snapshot();
    const todos = tables.get('todos') ?? [];
    const args: Record<string, any> = {};
    let accessor: string;
    if (kind === 'create' || !todos.length) {
      accessor = 'createTodo';
      args.id = Uuid.fromRandomBytesV4(rng.fill(new Uint8Array(16)));
      args.title = `foreign-${rng.u32() % 1000}`;
    } else if (kind === 'bump') {
      accessor = 'bump';
      args.name = rng.pick(['a', 'b', 'c']);
      args.by = BigInt(rng.int(1, 3));
    } else {
      accessor = kind === 'toggle' ? 'toggleTodo' : 'deleteTodo';
      args.id = rng.pick(todos).id;
    }
    const b = bindings[accessor];
    const w = new BinaryWriter(256);
    ProductType.makeSerializer(b.paramsType)(w, {
      ...args,
      intentId: Uuid.fromRandomBytesV4(rng.fill(new Uint8Array(16))),
      clientTs: new Timestamp(clock()),
    });
    const res = server.call(b.name, w.getBuffer(), foreignIdentity);
    trace(`foreign ${accessor} ok=${res.ok}`);
  };

  for (let step = 0; step < steps; step++) {
    const c = rng.pick(clients);
    const action = pickAction();
    switch (action) {
      case 'call':
        doCall(c);
        break;
      case 'toggleLink':
        if (c.link.connected) {
          c.lf.disconnect();
          c.link.disconnect();
          c.wantConnected = false;
          trace(`client ${c.identity} offline`);
        } else {
          c.link.connect();
          c.lf.connect(c.link);
          c.wantConnected = true;
          trace(`client ${c.identity} online`);
        }
        break;
      case 'crash':
        await doCrash(c);
        break;
      case 'foreign':
        doForeign();
        break;
      case 'snapshot':
        await c.lf.snapshotNow().catch(() => undefined);
        break;
      case 'tick':
      default:
        await sched.runFor(BigInt(rng.int(1, 50)) * 1_000n);
        break;
    }
    if (violations.length > 20) break;
  }

  // ---- Quiescence: everyone online, no faults, drain everything ----
  for (const c of clients) c.storage.plan = NO_FAULTS;
  const quietNetwork: NetworkPlan = { ...network, dropAck: 0, dropCall: 0 };
  for (const c of clients) {
    if (c.link.connected) {
      c.lf.disconnect();
      c.link.disconnect();
    }
    c.link = new FakeLink(server, sched, new SeededRng(rng.u32()), quietNetwork, c.identity);
    c.link.connect();
    c.lf.connect(c.link);
    c.wantConnected = true;
  }
  for (let i = 0; i < 200; i++) {
    await sched.runUntilIdle();
    if (clients.every(c => c.lf.pending().length === 0)) break;
    await sched.runFor(100_000n);
  }
  await sched.runFor(1_000_000n);

  // ---- Invariants ----
  for (const c of clients) {
    if (c.lf.pending().length) violations.push(`client ${c.identity} still has ${c.lf.pending().length} pending after quiescence`);
    for (const [k, l] of c.ledger) {
      if (l.durable === 'ok' && !l.status) violations.push(`durable intent ${k} never settled`);
      if (l.status === 'acked' && !server.isApplied(new Uuid(BigInt('0x' + k.replace(/-/g, ''))))) {
        violations.push(`intent ${k} acked on client but not applied on server`);
      }
      if (l.status === 'failed' && server.effectRuns.get(k)) {
        violations.push(`intent ${k} failed on client but had effects on server`);
      }
    }
    const view = new Map<string, Map<string, any>>();
    for (const [acc, rows] of server.snapshot()) {
      const spec = c.lf.store.spec(acc);
      view.set(acc, new Map(rows.map(r => [String(spec.rowKey(r)), r])));
      const local = new Map([...c.lf.db[acc].iter()].map((r: any) => [String(spec.rowKey(r)), r]));
      if (local.size !== rows.length) {
        violations.push(`client ${c.identity} ${acc}: ${local.size} rows locally vs ${rows.length} on server`);
        continue;
      }
      for (const [k, r] of local) {
        const s = view.get(acc)!.get(k);
        if (!s || !deepEqual(s, r)) violations.push(`client ${c.identity} ${acc} row ${k} differs from server`);
      }
    }
  }
  for (const [k, n] of server.effectRuns) {
    if (n > 1) violations.push(`intent ${k} had effects ${n} times on server`);
  }

  const report: SimReport = {
    seed: opts.seed,
    steps,
    ...stats,
    volatile: clients.reduce((n, c) => n + [...c.ledger.values()].filter(l => l.durable === 'rejected').length, 0),
    crashes: clients.reduce((n, c) => n + c.crashes, 0),
    tornRecoveries: clients.reduce((n, c) => n + c.tornRecoveries, 0),
    faults: clients.reduce(
      (acc, c) => {
        for (const k of Object.keys(acc) as (keyof FaultyStorage['stats'])[]) acc[k] += c.storage.stats[k];
        return acc;
      },
      { appendFail: 0, appendTorn: 0, writeFail: 0, writeTorn: 0, readFail: 0 }
    ),
    serverExecutions: server.executions.length,
    serverDuplicates: server.executions.filter(e => e.duplicate).length,
    violations,
  };
  for (const c of clients) {
    c.unsubEvents?.();
    await c.lf.close();
  }
  return report;
}
