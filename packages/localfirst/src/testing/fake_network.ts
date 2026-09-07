import { Identity } from 'spacetimedb';
import type { Delta } from '../client/local_store';
import type { SeededRng } from '../client/rng';
import type { Row } from '../client/table_spec';
import type { Link, ServerEvents, Transport } from '../client/transport';
import type { FakeServer } from './fake_server';
import type { VirtualScheduler } from './scheduler';

export interface NetworkPlan {
  minLatencyMicros: bigint;
  maxLatencyMicros: bigint;
  /** Probability the server commits but the ack never reaches the client. */
  dropAck: number;
  /** Probability a call is lost before reaching the server. */
  dropCall: number;
}

export const LAN: NetworkPlan = {
  minLatencyMicros: 1_000n,
  maxLatencyMicros: 5_000n,
  dropAck: 0,
  dropCall: 0,
};

/**
 * One client's connection to the fake server. Mirrors what the SDK gives us:
 * full state on (re)connect, per-table deltas while connected, and reducer
 * calls that resolve on commit. While disconnected nothing is delivered and
 * in-flight acks are lost, which is exactly the case the intent log exists for.
 */
export class FakeLink implements Link {
  connected = false;
  identity: Identity;
  readonly transport: Transport;
  readonly events: ServerEvents;
  calls = 0;
  acksDropped = 0;
  callsDropped = 0;
  #initialCbs = new Set<(tables: Map<string, Row[]>) => void>();
  #deltaCbs = new Set<(accessor: string, delta: Delta) => void>();
  #server: FakeServer;
  #sched: VirtualScheduler;
  #rng: SeededRng;
  #plan: NetworkPlan;
  #unsubServer: (() => void) | null = null;
  #session = 0;
  /** Server->client deliveries are FIFO per session: never reorder, like a socket. */
  #lastDelivery = 0n;

  constructor(
    server: FakeServer,
    sched: VirtualScheduler,
    rng: SeededRng,
    plan: NetworkPlan,
    identity: Identity
  ) {
    this.#server = server;
    this.#sched = sched;
    this.#rng = rng;
    this.#plan = plan;
    this.identity = identity;
    this.transport = { callReducer: (name, args) => this.#call(name, args) };
    this.events = {
      onInitialState: cb => {
        this.#initialCbs.add(cb);
        return () => this.#initialCbs.delete(cb);
      },
      onDelta: cb => {
        this.#deltaCbs.add(cb);
        return () => this.#deltaCbs.delete(cb);
      },
    };
  }

  #latency(): bigint {
    const span = Number(this.#plan.maxLatencyMicros - this.#plan.minLatencyMicros);
    return this.#plan.minLatencyMicros + BigInt(this.#rng.int(0, span));
  }

  /** Schedule a server->client delivery no earlier than the previous one. */
  #deliver(fn: () => void): void {
    const at = this.#sched.timeMicros + this.#latency();
    const when = at > this.#lastDelivery ? at : this.#lastDelivery;
    this.#lastDelivery = when;
    this.#sched.schedule(when - this.#sched.timeMicros, fn);
  }

  /** Go online: after one latency the server's full state arrives, then live deltas. */
  connect(): void {
    if (this.connected) return;
    this.connected = true;
    const session = ++this.#session;
    this.#lastDelivery = this.#sched.timeMicros;
    this.#unsubServer = this.#server.onDelta((acc, delta) => {
      if (!this.connected || session !== this.#session) return;
      this.#deliver(() => {
        if (!this.connected || session !== this.#session) return;
        for (const cb of this.#deltaCbs) cb(acc, delta);
      });
    });
    this.#deliver(() => {
      if (!this.connected || session !== this.#session) return;
      const tables = this.#server.snapshot();
      for (const cb of this.#initialCbs) cb(tables);
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.#session++;
    this.#unsubServer?.();
    this.#unsubServer = null;
  }

  #call(name: string, args: Uint8Array): Promise<void> {
    this.calls++;
    if (!this.connected) return new Promise(() => undefined); // never settles
    const session = this.#session;
    return new Promise<void>((resolve, reject) => {
      if (this.#rng.chance(this.#plan.dropCall)) {
        this.callsDropped++;
        return; // lost on the way; the client only learns via disconnect/resend
      }
      this.#sched.schedule(this.#latency(), () => {
        // The server commits (broadcasting deltas through the FIFO), then the
        // ack travels back on the same FIFO, after that transaction's deltas.
        const res = this.#server.call(name, args, this.identity);
        const dropAck = this.#rng.chance(this.#plan.dropAck);
        this.#deliver(() => {
          if (!this.connected || session !== this.#session) return; // ack lost with the socket
          if (dropAck) {
            this.acksDropped++;
            return;
          }
          if (res.ok) resolve();
          else reject(new Error(res.error ?? 'reducer failed'));
        });
      });
    });
  }

  dispose(): void {
    this.disconnect();
  }
}
