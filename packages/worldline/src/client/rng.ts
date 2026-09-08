import { Timestamp, Uuid } from 'spacetimedb';

/** Minimal random source. Injectable so simulations are deterministic. */
export interface Rng {
  u32(): number;
  float(): number;
  fill<T extends Uint8Array>(arr: T): T;
}

/** Cryptographic RNG for production. */
export class CryptoRng implements Rng {
  #buf = new Uint32Array(1);
  u32(): number {
    globalThis.crypto.getRandomValues(this.#buf);
    return this.#buf[0] as number; // length-1 array, index 0 always exists
  }
  float(): number {
    return this.u32() / 4294967296;
  }
  fill<T extends Uint8Array>(arr: T): T {
    globalThis.crypto.getRandomValues(arr);
    return arr;
  }
}

/** xoshiro128** seeded RNG. Deterministic for a given seed. */
export class SeededRng implements Rng {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;
  constructor(seed: number) {
    // splitmix32 to expand the seed
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.#s0 = next();
    this.#s1 = next();
    this.#s2 = next();
    this.#s3 = next();
    if ((this.#s0 | this.#s1 | this.#s2 | this.#s3) === 0) this.#s0 = 1;
  }
  u32(): number {
    const result = Math.imul(rotl(Math.imul(this.#s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.#s1 << 9) >>> 0;
    this.#s2 = (this.#s2 ^ this.#s0) >>> 0;
    this.#s3 = (this.#s3 ^ this.#s1) >>> 0;
    this.#s1 = (this.#s1 ^ this.#s2) >>> 0;
    this.#s0 = (this.#s0 ^ this.#s3) >>> 0;
    this.#s2 = (this.#s2 ^ t) >>> 0;
    this.#s3 = rotl(this.#s3, 11);
    return result;
  }
  float(): number {
    return this.u32() / 4294967296;
  }
  fill<T extends Uint8Array>(arr: T): T {
    for (let i = 0; i < arr.length; i++) arr[i] = this.u32() & 0xff;
    return arr;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.float() < p;
  }
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('pick from an empty array');
    return arr[this.int(0, arr.length - 1)] as T;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Adapt an `Rng` to the shape of the host's `ctx.random`. */
export function makeRandom(rng: Rng): any {
  const random: any = () => rng.float();
  random.uint32 = () => rng.u32();
  random.fill = (arr: any) => {
    if (arr instanceof Uint8Array) return rng.fill(arr);
    for (let i = 0; i < arr.length; i++) {
      const v = rng.u32();
      arr[i] = typeof arr[i] === 'bigint' ? BigInt(v) : v;
    }
    return arr;
  };
  random.integerInRange = (min: number, max: number) =>
    min + Math.floor(rng.float() * (max - min + 1));
  random.bigintInRange = (min: bigint, max: bigint) => {
    const span = max - min + 1n;
    const r = (BigInt(rng.u32()) << 32n) | BigInt(rng.u32());
    return min + (r % span);
  };
  return random;
}

export function uuidV7(rng: Rng, counter: { value: number }, nowMicros: bigint): Uuid {
  return Uuid.fromCounterV7(counter, new Timestamp(nowMicros), rng.fill(new Uint8Array(4)));
}

export function uuidV4(rng: Rng): Uuid {
  return Uuid.fromRandomBytesV4(rng.fill(new Uint8Array(16)));
}
