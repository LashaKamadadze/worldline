import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/client/crc32';
import { decodeFrames, encodeFrame } from '../src/client/framing';

describe('framing', () => {
  it('crc32 matches the reference vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips frames and stops at a torn tail', () => {
    const a = encodeFrame(new Uint8Array([1, 2, 3]));
    const b = encodeFrame(new Uint8Array([4, 5]));
    const c = encodeFrame(new Uint8Array([6, 7, 8, 9]));
    const all = new Uint8Array([...a, ...b, ...c.subarray(0, c.length - 2)]);
    const d = decodeFrames(all);
    expect(d.frames.map(f => [...f])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(d.torn).toBe(true);
    expect(d.validLength).toBe(a.length + b.length);
  });

  it('rejects a frame whose payload was corrupted', () => {
    const a = encodeFrame(new Uint8Array([1, 2, 3]));
    const b = encodeFrame(new Uint8Array([4, 5]));
    const all = new Uint8Array([...a, ...b]);
    all[a.length + 8] = (all[a.length + 8] ?? 0) ^ 0xff; // flip a payload byte of b
    const d = decodeFrames(all);
    expect(d.frames.length).toBe(1);
    expect(d.torn).toBe(true);
  });
});
