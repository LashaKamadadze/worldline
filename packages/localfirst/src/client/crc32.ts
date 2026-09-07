/** CRC-32 (IEEE 802.3), table driven. Used to detect torn or corrupted log frames. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    const index = (c ^ byte) & 0xff; // always 0..255, inside TABLE
    c = (TABLE[index] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
