import type { IntentRecord } from './intent_log';

function touches(readOrWrite: string, write: string): boolean {
  if (readOrWrite === write) return true;
  // `table:*` (a scan) overlaps any key of that table.
  const i = readOrWrite.indexOf(':');
  if (i > 0 && readOrWrite.endsWith(':*')) {
    return write.startsWith(readOrWrite.slice(0, i + 1));
  }
  return false;
}

/** Whether `later` observed or overwrote anything `earlier` wrote. */
export function dependsOn(later: IntentRecord, earlier: IntentRecord): boolean {
  for (const w of earlier.writeSet) {
    for (const r of later.readSet) if (touches(r, w)) return true;
    for (const w2 of later.writeSet) if (touches(w2, w)) return true;
  }
  return false;
}

/**
 * Transitive closure of intents (in log order) that depend on `failed`.
 * Only intents *after* `failed` can depend on it.
 */
export function dependentsOf(failed: IntentRecord, ordered: IntentRecord[]): IntentRecord[] {
  const start = ordered.findIndex(r => r === failed);
  const roots = [failed];
  const out: IntentRecord[] = [];
  for (let i = start + 1; i < ordered.length; i++) {
    const cand = ordered[i];
    if (roots.some(r => dependsOn(cand, r))) {
      out.push(cand);
      roots.push(cand);
    }
  }
  return out;
}
