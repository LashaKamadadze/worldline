import { MemoryStorage, type StorageOp } from '../client/storage/memory';
import type { SeededRng } from '../client/rng';

export interface FaultPlan {
  /** Probability an append is rejected outright. */
  appendFail: number;
  /** Probability an append is torn: only a prefix lands, then it fails. */
  appendTorn: number;
  /** Probability a full-file write fails. */
  writeFail: number;
  /** Probability a full-file write is torn. */
  writeTorn: number;
  /** Probability a read fails. */
  readFail: number;
}

export const NO_FAULTS: FaultPlan = { appendFail: 0, appendTorn: 0, writeFail: 0, writeTorn: 0, readFail: 0 };

export interface FaultStats {
  appendFail: number;
  appendTorn: number;
  writeFail: number;
  writeTorn: number;
  readFail: number;
}

/** In-memory storage that misbehaves according to a seeded plan. `clone()` = what a crash leaves on disk. */
export class FaultyStorage extends MemoryStorage {
  plan: FaultPlan;
  readonly stats: FaultStats = { appendFail: 0, appendTorn: 0, writeFail: 0, writeTorn: 0, readFail: 0 };
  #rng: SeededRng;

  constructor(rng: SeededRng, plan: FaultPlan = NO_FAULTS) {
    super();
    this.#rng = rng;
    this.plan = plan;
    this.fault = (op: StorageOp, _name: string, bytes?: Uint8Array) => {
      const p = this.plan;
      switch (op) {
        case 'append':
          if (this.#rng.chance(p.appendTorn) && bytes && bytes.length > 1) {
            this.stats.appendTorn++;
            return this.#rng.int(0, bytes.length - 1);
          }
          if (this.#rng.chance(p.appendFail)) {
            this.stats.appendFail++;
            return 'fail';
          }
          return undefined;
        case 'write':
          if (this.#rng.chance(p.writeTorn) && bytes && bytes.length > 1) {
            this.stats.writeTorn++;
            return this.#rng.int(0, bytes.length - 1);
          }
          if (this.#rng.chance(p.writeFail)) {
            this.stats.writeFail++;
            return 'fail';
          }
          return undefined;
        case 'read':
          if (this.#rng.chance(p.readFail)) {
            this.stats.readFail++;
            return 'fail';
          }
          return undefined;
        default:
          return undefined;
      }
    };
  }

  /** Bytes as a crash would leave them. The clone shares the plan and RNG. */
  crash(): FaultyStorage {
    const c = new FaultyStorage(this.#rng, this.plan);
    c.importFiles(this.exportFiles());
    return c;
  }
}
