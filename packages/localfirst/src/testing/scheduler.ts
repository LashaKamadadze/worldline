/** Virtual time. Events run in (time, insertion) order; microtasks are flushed between them. */
export class VirtualScheduler {
  timeMicros = 0n;
  #queue: { at: bigint; seq: number; fn: () => void }[] = [];
  #seq = 0;

  schedule(delayMicros: bigint, fn: () => void): void {
    this.#queue.push({ at: this.timeMicros + delayMicros, seq: this.#seq++, fn });
  }

  get pendingEvents(): number {
    return this.#queue.length;
  }

  /** Run the next due event (advancing time to it). Returns false when idle. */
  async step(): Promise<boolean> {
    if (!this.#queue.length) {
      await flushMicrotasks();
      return false;
    }
    this.#queue.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
    const ev = this.#queue.shift()!;
    if (ev.at > this.timeMicros) this.timeMicros = ev.at;
    ev.fn();
    await flushMicrotasks();
    return true;
  }

  async runFor(micros: bigint): Promise<void> {
    const until = this.timeMicros + micros;
    while (this.#queue.length) {
      this.#queue.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
      if (this.#queue[0].at > until) break;
      await this.step();
    }
    this.timeMicros = until;
    await flushMicrotasks();
  }

  async runUntilIdle(maxSteps = 100_000): Promise<void> {
    let n = 0;
    for (;;) {
      // Microtasks may schedule new events; only stop when a flush adds nothing.
      await flushMicrotasks();
      if (!this.#queue.length) {
        await flushMicrotasks();
        if (!this.#queue.length) return;
      }
      await this.step();
      if (++n > maxSteps) throw new Error('scheduler did not go idle');
    }
  }

  advance(micros: bigint): void {
    this.timeMicros += micros;
  }
}

/** Let promise chains settle (several rounds, since resolutions enqueue more microtasks). */
export async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise<void>(r => setImmediate(r));
}
