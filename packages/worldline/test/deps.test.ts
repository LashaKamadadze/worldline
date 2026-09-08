import { Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { dependentsOf, dependsOn } from '../src/client/deps';
import type { IntentRecord } from '../src/client/intent_log';

const rec = (n: number, readSet: string[], writeSet: string[]): IntentRecord => ({
  intentId: new Uuid(BigInt(n)),
  reducerName: 'r',
  accessorName: 'r',
  argsBsatn: new Uint8Array(),
  clientTsMicros: 0n,
  predicted: true,
  readSet,
  writeSet,
});

describe('dependency tracking', () => {
  it('detects read-after-write, write-after-write and scans', () => {
    const create = rec(1, [], ['todos:1']);
    const toggle = rec(2, ['todos:1'], ['todos:1']);
    const count = rec(3, ['todos:*'], ['counters:a']);
    const unrelated = rec(4, ['counters:b'], ['counters:b']);
    expect(dependsOn(toggle, create)).toBe(true);
    expect(dependsOn(count, create)).toBe(true);
    expect(dependsOn(unrelated, create)).toBe(false);
  });

  it('closes transitively and only forward in log order', () => {
    const a = rec(1, [], ['todos:1']);
    const b = rec(2, ['todos:1'], ['counters:a']);
    const c = rec(3, ['counters:a'], ['counters:c']);
    const d = rec(4, ['todos:9'], ['todos:9']);
    const before = rec(0, ['todos:1'], []);
    const deps = dependentsOf(a, [before, a, b, c, d]);
    expect(deps.map(r => r.intentId.asBigInt())).toEqual([2n, 3n]);
  });
});
