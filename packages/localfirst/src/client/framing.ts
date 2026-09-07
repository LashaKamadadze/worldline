import { assert } from '../shared/assert';
import { LOG_FRAME_BYTES_MAX } from '../shared/limits';
import { crc32 } from './crc32';

const HEADER_BYTES = 8;

/**
 * Log frame: `[u32 length][u32 crc32(payload)][payload]`, little endian.
 *
 * Recovery reads frames until the length runs past the end, exceeds the frame
 * bound, or the checksum fails. Everything before that point is trusted; the
 * rest is a torn tail.
 */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  assert(payload.length + HEADER_BYTES <= LOG_FRAME_BYTES_MAX, 'frame exceeds LOG_FRAME_BYTES_MAX');
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, crc32(payload), true);
  frame.set(payload, HEADER_BYTES);
  assert(frame.length === HEADER_BYTES + payload.length, 'frame length mismatch');
  return frame;
}

export interface DecodedFrames {
  frames: Uint8Array[];
  /** Byte length of the valid prefix. Anything after it is torn or corrupt. */
  validLength: number;
  torn: boolean;
}

export function decodeFrames(bytes: Uint8Array): DecodedFrames {
  const frames: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  // Bounded by the byte length: every iteration consumes at least HEADER_BYTES.
  while (offset + HEADER_BYTES <= bytes.length) {
    const length = view.getUint32(offset, true);
    const checksum = view.getUint32(offset + 4, true);
    if (length + HEADER_BYTES > LOG_FRAME_BYTES_MAX) break;
    if (offset + HEADER_BYTES + length > bytes.length) break;
    const payload = bytes.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
    if (crc32(payload) !== checksum) break;
    frames.push(payload);
    offset += HEADER_BYTES + length;
  }
  assert(offset <= bytes.length, 'decoded past the end of the buffer');
  return { frames, validLength: offset, torn: offset !== bytes.length };
}
