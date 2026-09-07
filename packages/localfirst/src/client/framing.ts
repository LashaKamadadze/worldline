import { crc32 } from './crc32';

/**
 * Log frame: `[u32 length][u32 crc32(payload)][payload]`, little endian.
 *
 * Recovery reads frames until the length runs past the end or the checksum
 * fails. Everything before that point is trusted; the rest is a torn tail.
 */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payload.length, true);
  dv.setUint32(4, crc32(payload), true);
  out.set(payload, 8);
  return out;
}

export interface DecodedFrames {
  frames: Uint8Array[];
  /** Byte length of the valid prefix. Anything after it is torn or corrupt. */
  validLength: number;
  torn: boolean;
}

export function decodeFrames(bytes: Uint8Array): DecodedFrames {
  const frames: Uint8Array[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off, true);
    const crc = dv.getUint32(off + 4, true);
    if (off + 8 + len > bytes.length) break;
    const payload = bytes.subarray(off + 8, off + 8 + len);
    if (crc32(payload) !== crc) break;
    frames.push(payload);
    off += 8 + len;
  }
  return { frames, validLength: off, torn: off !== bytes.length };
}
