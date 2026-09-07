import { BinaryWriter, Identity, ProductType, Timestamp, Uuid, deepEqual } from 'spacetimedb';
import { assert } from '../shared/assert';
import {
  LocalFirst,
  type AnyReducer,
  type CallHandle,
  type IntentEvent,
} from '../client/local_first';
import { idKey } from '../client/intent_log';
import { LocalFirstError } from '../client/errors';
import { SeededRng } from '../client/rng';
import { bindingsFromModule } from './bindings';
import { FakeServer } from './fake_server';
import { FakeLink, LAN, type NetworkPlan } from './fake_network';
import { FaultyStorage, NO_FAULTS, type FaultPlan } from './faulty_storage';
import { VirtualScheduler } from './scheduler';
import * as sampleModule from './sample_module';
import * as localfirst from '../server/index';
import { encodeSessionArgs, sessionReducerName, type Session } from '../shared/session';

/**
 * Deterministic simulation of one to N local-first clients against a fake host.
 *
 * Goal: for a seed, drive random user actions, disconnects, crashes, foreign
 * writes, storage faults (failed and torn appends/writes, failed reads), lost
 * calls and lost acks, clock skew, throwing listeners, re-entrant calls and
 * double opens, then bring everything online and check the invariants below.
 * Same seed, same trace, same report, so any failure is a replayable bug.
 *
 * Invariants:
 *  1. Every intent reported durable settles exactly once (acked/failed/cancelled).
 *  2. An intent acked on the client is applied on the server.
 *  3. An intent failed or cancelled on the client has no effects on the server.
 *  4. No intent has effects more than once on the server (dedup).
 *  5. After quiescence each client's merged view equals the server's tables.
 *  6. After a crash, every durable unsettled intent is still pending.
 */
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

type Action =
  | 'call'
  | 'toggleLink'
  | 'crash'
  | 'foreign'
  | 'snapshot'
  | 'tick'
  | 'skewClock'
  | 'doubleOpen'
  | 'reentrantCall';

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
  openRetries: number;
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
  openRetries = 0;
  tornRecoveries = 0;
  wantConnected = false;
  hookFails = false;
  partialTodos = false;
  unsubEvents: (() => void) | null = null;

  constructor(storage: FaultyStorage, identity: Identity) {
    this.storage = storage;
    this.identity = identity;
  }
}

const DEFAULT_WEIGHTS: Record<Action, number> = {
  call: 40,
  toggleLink: 10,
  crash: 5,
  foreign: 12,
  snapshot: 4,
  tick: 24,
  skewClock: 2,
  doubleOpen: 1,
  reentrantCall: 2,
};

const OPEN_RETRIES_MAX = 8;
const QUIESCE_ROUNDS_MAX = 200;
const VIOLATIONS_MAX = 20;

export async function runSimulation(opts: SimOptions): Promise<SimReport> {
  const sim = new Simulation(opts);
  await sim.setup();
  await sim.run();
  await sim.quiesce();
  sim.checkInvariants();
  return sim.report();
}

class Simulation {
  readonly opts: SimOptions;
  readonly rng: SeededRng;
  readonly sched = new VirtualScheduler();
  readonly faults: FaultPlan;
  readonly network: NetworkPlan;
  readonly weights: Record<Action, number>;
  readonly steps: number;
  readonly violations: string[] = [];
  readonly mod = sampleModule as Record<string, any>;
  readonly bindings = bindingsFromModule(this.mod);
  readonly server: FakeServer;
  readonly clients: SimClient[] = [];
  readonly foreignIdentity = new Identity(0xf0f0f0n);
  /** The foreign writer's session; opened once at setup, like any other client's. */
  readonly foreignSession: Session = { clientId: new Uuid(0xf0f0f0n), epoch: 1n };
  readonly stats = { calls: 0, localRejects: 0, acked: 0, failed: 0, cancelled: 0 };
  readonly clock = (): bigint => this.sched.timeMicros;

  constructor(opts: SimOptions) {
    this.opts = opts;
    this.rng = new SeededRng(opts.seed);
    this.sched.timeMicros = 1_700_000_000_000_000n;
    this.faults = { ...NO_FAULTS, ...opts.faults };
    this.network = { ...LAN, ...opts.network };
    this.weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
    this.steps = opts.steps ?? 200;
    const serverRng = new SeededRng(opts.seed ^ 0x5eed);
    this.server = new FakeServer(
      this.mod,
      this.bindings,
      { lf: localfirst },
      this.clock,
      serverRng
    );
    this.server.trace = message => this.trace(message);
  }

  trace(message: string): void {
    if (this.opts.trace) console.log(`[t=${this.sched.timeMicros}] ${message}`);
  }

  // ------------------------------------------------------------- lifecycle

  async setup(): Promise<void> {
    const handshake = this.server.call(
      sessionReducerName('lf'),
      encodeSessionArgs(this.foreignSession),
      this.foreignIdentity
    );
    assert(handshake.ok, 'foreign session handshake must succeed on a fresh server');
    const count = this.opts.clients ?? 1;
    for (let i = 0; i < count; i++) {
      const storage = new FaultyStorage(new SeededRng(this.rng.u32()), this.faults);
      const client = new SimClient(storage, new Identity(BigInt(1000 + i)));
      client.wantConnected = this.rng.chance(0.5);
      client.hookFails = this.rng.chance(0.3);
      client.partialTodos = this.rng.chance(0.25);
      await this.openClient(client);
      this.clients.push(client);
    }
  }

  /** Open with retries: a failed read at open is a transient error the app would retry. */
  async openClient(client: SimClient): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        client.lf = await this.tryOpen(client);
        break;
      } catch (error) {
        client.openRetries += 1;
        if (attempt + 1 >= OPEN_RETRIES_MAX) {
          this.violations.push(`client ${client.identity} could not open: ${String(error)}`);
          client.storage.plan = NO_FAULTS;
          client.lf = await this.tryOpen(client);
          break;
        }
      }
    }
    if (client.lf.log.recovery.torn) client.tornRecoveries += 1;
    this.attachEvents(client);
    const linkRng = new SeededRng(this.rng.u32());
    client.link = new FakeLink(this.server, this.sched, linkRng, this.network, client.identity);
    if (client.wantConnected) {
      client.link.connect();
      client.lf.connect(client.link);
    }
  }

  tryOpen(client: SimClient): Promise<LocalFirst> {
    return LocalFirst.open({
      module: this.mod,
      reducers: this.bindings,
      storage: client.storage,
      workingSet: {
        queries: ['SELECT * FROM todos', 'SELECT * FROM counters'],
        coverage: client.partialTodos ? { todos: 'partial' } : {},
      },
      identity: client.identity,
      clock: this.clock,
      rng: new SeededRng(this.rng.u32()),
      inflightWindow: this.rng.pick([1, 1, 1, 2, 4]),
      snapshotDebounceMs: null,
      compactEvery: this.rng.pick([1, 4, 64]),
      beforeDrain: client.hookFails
        ? () => {
            if (this.rng.chance(0.5)) throw new Error('token refresh failed');
          }
        : undefined,
    });
  }

  attachEvents(client: SimClient): void {
    client.unsubEvents?.();
    const throwing = this.rng.chance(0.3);
    if (throwing) {
      client.lf.onIntent(() => {
        throw new Error('listener bug');
      });
      client.lf.subscribe(() => {
        throw new Error('subscriber bug');
      });
    }
    client.unsubEvents = client.lf.onIntent((event: IntentEvent) => this.onIntent(client, event));
  }

  onIntent(client: SimClient, event: IntentEvent): void {
    if (event.type === 'sent') {
      this.trace(`client ${client.identity} sent ${idKey(event.intent.intentId)}`);
    }
    if (event.type !== 'acked' && event.type !== 'failed' && event.type !== 'cancelled') return;
    const key = idKey(event.intent.intentId);
    const why = event.type === 'failed' ? String((event.error as Error)?.message) : '';
    this.trace(`client ${client.identity} ${event.type} ${key} ${why}`);
    const entry = client.ledger.get(key);
    if (entry !== undefined) {
      if (entry.status !== undefined && entry.status !== event.type) {
        this.violations.push(`intent ${key} settled twice: ${entry.status} then ${event.type}`);
      }
      entry.status = event.type;
    }
    this.stats[event.type] += 1;
  }

  // ------------------------------------------------------------------ run

  async run(): Promise<void> {
    for (let step = 0; step < this.steps; step++) {
      const client = this.rng.pick(this.clients);
      await this.dispatch(client, this.pickAction());
      if (this.violations.length > VIOLATIONS_MAX) break;
    }
  }

  pickAction(): Action {
    const total = Object.values(this.weights).reduce((a, b) => a + b, 0);
    let roll = this.rng.float() * total;
    for (const [action, weight] of Object.entries(this.weights) as [Action, number][]) {
      roll -= weight;
      if (roll < 0) return action;
    }
    return 'tick';
  }

  /** All control flow in one place; the action methods are straight-line. */
  async dispatch(client: SimClient, action: Action): Promise<void> {
    switch (action) {
      case 'call':
        this.actionCall(client, false);
        return;
      case 'reentrantCall':
        this.actionReentrantCall(client);
        return;
      case 'toggleLink':
        this.actionToggleLink(client);
        return;
      case 'crash':
        await this.actionCrash(client);
        return;
      case 'foreign':
        this.actionForeign();
        return;
      case 'snapshot':
        await client.lf.snapshotNow().catch(() => undefined);
        return;
      case 'skewClock':
        this.sched.timeMicros -= BigInt(this.rng.int(1, 500)) * 1_000n;
        return;
      case 'doubleOpen':
        await this.actionDoubleOpen(client);
        return;
      case 'tick':
        await this.sched.runFor(BigInt(this.rng.int(1, 50)) * 1_000n);
        return;
    }
  }

  // -------------------------------------------------------------- actions

  randomCall(client: SimClient): { reducer: AnyReducer; args: Record<string, any>; kind: string } {
    const kind = this.rng.pick(['create', 'create', 'toggle', 'delete', 'bump'] as const);
    if (kind === 'create') {
      const id = Uuid.fromRandomBytesV4(this.rng.fill(new Uint8Array(16)));
      client.known.push(id);
      const title = this.rng.chance(0.05) ? '' : `todo-${this.rng.u32() % 1000}`;
      return { reducer: this.mod.createTodo, args: { id, title }, kind };
    }
    if (kind === 'bump') {
      const args = { name: this.rng.pick(['a', 'b', 'c']), by: BigInt(this.rng.int(-3, 5)) };
      return { reducer: this.mod.bump, args, kind };
    }
    const useKnown = client.known.length > 0 && !this.rng.chance(0.1);
    const id = useKnown
      ? this.rng.pick(client.known)
      : Uuid.fromRandomBytesV4(this.rng.fill(new Uint8Array(16)));
    const reducer = kind === 'toggle' ? this.mod.toggleTodo : this.mod.deleteTodo;
    return { reducer, args: { id }, kind };
  }

  actionCall(client: SimClient, strict: boolean): void {
    const { reducer, args, kind } = this.randomCall(client);
    let handle: CallHandle;
    try {
      handle = client.lf.call(reducer, args, { strict });
    } catch (error) {
      this.stats.localRejects += 1;
      this.trace(`client ${client.identity} local reject ${kind}: ${(error as Error).message}`);
      return;
    }
    this.stats.calls += 1;
    const key = idKey(handle.intentId);
    const entry: Ledger = { durable: 'pending', predicted: handle.predicted };
    client.ledger.set(key, entry);
    handle.durable.then(
      () => {
        entry.durable = 'ok';
      },
      () => {
        entry.durable = 'rejected';
      }
    );
    this.trace(`client ${client.identity} call ${kind} -> ${key} predicted=${handle.predicted}`);
  }

  /** A UI subscriber that issues a call from inside a change notification. */
  actionReentrantCall(client: SimClient): void {
    let fired = false;
    const unsubscribe = client.lf.subscribe(() => {
      if (fired) return;
      fired = true;
      this.actionCall(client, this.rng.chance(0.3));
    });
    this.actionCall(client, false);
    unsubscribe();
  }

  actionToggleLink(client: SimClient): void {
    if (client.link.connected) {
      client.lf.disconnect();
      client.link.disconnect();
      client.wantConnected = false;
      this.trace(`client ${client.identity} offline`);
      return;
    }
    client.link.connect();
    client.lf.connect(client.link);
    client.wantConnected = true;
    this.trace(`client ${client.identity} online`);
  }

  async actionCrash(client: SimClient): Promise<void> {
    const durableUnsettled = new Set<string>();
    for (const [key, entry] of client.ledger) {
      if (entry.durable === 'ok' && entry.status === undefined) durableUnsettled.add(key);
    }
    await client.lf.close();
    client.link.dispose();
    client.storage = client.storage.crash();
    client.crashes += 1;
    this.trace(`client ${client.identity} CRASH`);
    await this.openClient(client);
    const after = new Set(client.lf.pending().map(record => idKey(record.intentId)));
    for (const key of durableUnsettled) {
      if (!after.has(key))
        this.violations.push(`intent ${key} reported durable but vanished after crash`);
    }
    for (const key of after) {
      const entry = client.ledger.get(key);
      if (entry === undefined) {
        this.violations.push(`intent ${key} appeared after crash but was never issued`);
        continue;
      }
      // Its mark append failed before the crash; it will be resent and dedup'd on the server.
      entry.status = undefined;
    }
  }

  actionForeign(): void {
    const kind = this.rng.pick(['create', 'toggle', 'delete', 'bump'] as const);
    const todos = this.server.snapshot().get('todos') ?? [];
    const args: Record<string, any> = {};
    let accessor: string;
    if (kind === 'create' || todos.length === 0) {
      accessor = 'createTodo';
      args.id = Uuid.fromRandomBytesV4(this.rng.fill(new Uint8Array(16)));
      args.title = `foreign-${this.rng.u32() % 1000}`;
    } else if (kind === 'bump') {
      accessor = 'bump';
      args.name = this.rng.pick(['a', 'b', 'c']);
      args.by = BigInt(this.rng.int(1, 3));
    } else {
      accessor = kind === 'toggle' ? 'toggleTodo' : 'deleteTodo';
      args.id = this.rng.pick(todos).id;
    }
    const binding = this.bindings[accessor];
    assert(binding !== undefined, `no binding for ${accessor}`);
    const writer = new BinaryWriter(256);
    ProductType.makeSerializer(binding.paramsType)(writer, {
      ...args,
      intentId: Uuid.fromRandomBytesV4(this.rng.fill(new Uint8Array(16))),
      clientTs: new Timestamp(this.clock()),
      lfClient: this.foreignSession.clientId,
      lfEpoch: this.foreignSession.epoch,
    });
    const result = this.server.call(binding.name, writer.getBuffer(), this.foreignIdentity);
    this.trace(`foreign ${accessor} ok=${result.ok}`);
  }

  /** A second instance on the same storage must be refused by the single-writer lock. */
  async actionDoubleOpen(client: SimClient): Promise<void> {
    try {
      const second = await this.tryOpen(client);
      await second.close();
      this.violations.push(`client ${client.identity}: second open on locked storage succeeded`);
    } catch (error) {
      if (!(error instanceof LocalFirstError)) {
        this.violations.push(`double open failed with the wrong error: ${String(error)}`);
      }
    }
  }

  // ------------------------------------------------------------ quiescence

  async quiesce(): Promise<void> {
    const quietNetwork: NetworkPlan = { ...this.network, dropAck: 0, dropCall: 0 };
    for (const client of this.clients) {
      client.storage.plan = NO_FAULTS;
      client.hookFails = false;
      if (client.link.connected) {
        client.lf.disconnect();
        client.link.disconnect();
      }
      await this.reopenWithoutHook(client);
      const linkRng = new SeededRng(this.rng.u32());
      client.link = new FakeLink(this.server, this.sched, linkRng, quietNetwork, client.identity);
      client.link.connect();
      client.lf.connect(client.link);
      client.wantConnected = true;
    }
    for (let round = 0; round < QUIESCE_ROUNDS_MAX; round++) {
      await this.sched.runUntilIdle();
      if (this.clients.every(client => client.lf.pending().length === 0)) break;
      await this.sched.runFor(100_000n);
    }
    await this.sched.runFor(1_000_000n);
  }

  /** Clients whose beforeDrain hook may fail are reopened with a passing hook so they can drain. */
  async reopenWithoutHook(client: SimClient): Promise<void> {
    await client.lf.close();
    client.storage = client.storage.crash();
    client.lf = await this.tryOpen(client);
    this.attachEvents(client);
  }

  // ------------------------------------------------------------ invariants

  checkInvariants(): void {
    for (const client of this.clients) this.checkClient(client);
    for (const [key, count] of this.server.effectRuns) {
      if (count > 1) this.violations.push(`intent ${key} had effects ${count} times on server`);
    }
  }

  checkClient(client: SimClient): void {
    const pending = client.lf.pending().length;
    if (pending > 0) this.violations.push(`client ${client.identity} still has ${pending} pending`);
    for (const [key, entry] of client.ledger) {
      const uuid = new Uuid(BigInt('0x' + key.replace(/-/g, '')));
      if (entry.durable === 'ok' && entry.status === undefined) {
        this.violations.push(`durable intent ${key} never settled`);
      }
      if (entry.status === 'acked' && !this.server.isApplied(uuid)) {
        this.violations.push(`intent ${key} acked on client but not applied on server`);
      }
      const notApplied = entry.status === 'failed' || entry.status === 'cancelled';
      if (notApplied && this.server.effectRuns.get(key)) {
        this.violations.push(`intent ${key} ${entry.status} on client but had effects on server`);
      }
    }
    this.checkConvergence(client);
  }

  checkConvergence(client: SimClient): void {
    for (const [accessor, rows] of this.server.snapshot()) {
      const spec = client.lf.store.spec(accessor);
      const server = new Map(rows.map(row => [String(spec.rowKey(row)), row]));
      const localRows: any[] = [...client.lf.db[accessor].iter()];
      const local = new Map(localRows.map(row => [String(spec.rowKey(row)), row]));
      if (local.size !== rows.length) {
        this.violations.push(
          `client ${client.identity} ${accessor}: ${local.size} vs ${rows.length}`
        );
        continue;
      }
      for (const [key, row] of local) {
        const serverRow = server.get(key);
        if (serverRow === undefined || !deepEqual(serverRow, row)) {
          this.violations.push(`client ${client.identity} ${accessor} row ${key} differs`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- report

  report(): SimReport {
    const sum = (f: (c: SimClient) => number) => this.clients.reduce((n, c) => n + f(c), 0);
    const faults = { appendFail: 0, appendTorn: 0, writeFail: 0, writeTorn: 0, readFail: 0 };
    for (const client of this.clients) {
      for (const key of Object.keys(faults) as (keyof typeof faults)[]) {
        faults[key] += client.storage.stats[key];
      }
    }
    for (const client of this.clients) client.unsubEvents?.();
    return {
      seed: this.opts.seed,
      steps: this.steps,
      ...this.stats,
      volatile: sum(c => [...c.ledger.values()].filter(l => l.durable === 'rejected').length),
      crashes: sum(c => c.crashes),
      openRetries: sum(c => c.openRetries),
      tornRecoveries: sum(c => c.tornRecoveries),
      faults,
      serverExecutions: this.server.executions.length,
      serverDuplicates: this.server.executions.filter(e => e.duplicate).length,
      violations: this.violations,
    };
  }
}
