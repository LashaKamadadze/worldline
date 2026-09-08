import { deepEqual } from 'spacetimedb';

/** Total order over index key scalars, close enough to the host's BTree order for prediction. */
export function scalarCompare(a: any, b: any): number {
  return comparePrimitive(unwrapScalar(a), unwrapScalar(b), a, b);
}

/** Timestamp, Identity and Uuid compare by their inner integer. */
function unwrapScalar(value: any): any {
  if (value === null || typeof value !== 'object') return value;
  if ('microsSinceUnixEpoch' in value) return value.microsSinceUnixEpoch;
  if ('__identity__' in value) return value.__identity__;
  if (typeof value.asBigInt === 'function') return value.asBigInt();
  return value;
}

function comparePrimitive(a: any, b: any, rawA: any, rawB: any): number {
  if (a === b) return 0;
  const ta = typeof a;
  const tb = typeof b;
  if ((ta === 'number' || ta === 'bigint') && (tb === 'number' || tb === 'bigint')) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (ta === 'string' && tb === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'boolean' && tb === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (rawA && rawB && typeof rawA === 'object' && typeof rawB === 'object') {
    if (typeof rawA.compareTo === 'function') return rawA.compareTo(rawB);
    if (deepEqual(rawA, rawB)) return 0;
  }
  const sa = JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const sb = JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export { deepEqual };

/**
 * Ranged-index match, copied from the SDK's client cache semantics: all prefix
 * terms are equality, only the last provided term may be a `Range`.
 */
export function matchRange(key: readonly unknown[], rangeArg: any): boolean {
  const arr = Array.isArray(rangeArg) ? rangeArg : [rangeArg];
  const prefixLen = Math.max(0, arr.length - 1);
  for (let i = 0; i < prefixLen; i++) {
    if (!deepEqual(key[i], arr[i])) return false;
  }
  const last = arr[arr.length - 1];
  const kLast = key[prefixLen];
  if (last && typeof last === 'object' && 'from' in last && 'to' in last) {
    const from = last.from;
    const to = last.to;
    if (from.tag !== 'unbounded') {
      const c = scalarCompare(kLast, from.value);
      if (c < 0) return false;
      if (c === 0 && from.tag === 'excluded') return false;
    }
    if (to.tag !== 'unbounded') {
      const c = scalarCompare(kLast, to.value);
      if (c > 0) return false;
      if (c === 0 && to.tag === 'excluded') return false;
    }
    return true;
  }
  return deepEqual(kLast, last);
}
