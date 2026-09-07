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
    return this.#buf[0];
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
  #s: Uint32Array;
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
    this.#s = new Uint32Array([next(), next(), next(), next()]);
    if (this.#s.every(v => v === 0)) this.#s[0] = 1;
  }
  u32(): number {
    const s = this.#s;
    const result = (Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0);
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
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
    return arr[this.int(0, arr.length - 1)];
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
