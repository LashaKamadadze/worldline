/**
 * Rows contain Uuid / Identity / Timestamp instances and bigints, none of which
 * survive `page.evaluate`. Flatten them to strings so the Node side can compare.
 */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  const v = value as any;
  // Uuid (has asBigInt) renders as the canonical hyphenated string, matching
  // Node's randomUUID(); Identity (has toHexString only) renders as hex.
  if (typeof v.asBigInt === 'function') return v.toString();
  if (typeof v.toHexString === 'function') return v.toHexString();
  if ('microsSinceUnixEpoch' in v) return `ts:${v.microsSinceUnixEpoch}`;
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Uint8Array) return Array.from(v);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = plain(v[k]);
  return out;
}

export function sortedRows(rows: Iterable<unknown>): unknown[] {
  return [...rows].map(plain).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}
