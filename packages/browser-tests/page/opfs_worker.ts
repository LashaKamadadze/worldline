/// <reference lib="webworker" />
import { opfsRoundTrip, opfsTornLog } from './opfs_ops';

/**
 * Runs the OPFS adapter inside a dedicated worker, where
 * `createSyncAccessHandle` exists and the adapter takes its append+flush path.
 */
self.onmessage = async (ev: MessageEvent<{ op: 'roundTrip' | 'tornLog'; dir: string }>) => {
  try {
    const result = ev.data.op === 'roundTrip' ? await opfsRoundTrip(ev.data.dir) : await opfsTornLog(ev.data.dir);
    (self as any).postMessage({ ok: true, result });
  } catch (e) {
    (self as any).postMessage({ ok: false, error: String((e as Error)?.stack ?? e) });
  }
};
