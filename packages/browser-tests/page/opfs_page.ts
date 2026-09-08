import { OpfsStorage } from '@kamadadze/worldline/client';
import { opfsRoundTrip, opfsTornLog } from './opfs_ops';

/** Page entry for the adapter-only tests (no SpacetimeDB needed). */
function runInWorker(op: 'roundTrip' | 'tornLog', dir: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/opfs_worker.js', { type: 'module' });
    worker.onmessage = ev => {
      worker.terminate();
      if (ev.data.ok) resolve(ev.data.result);
      else reject(new Error(ev.data.error));
    };
    worker.onerror = ev => {
      worker.terminate();
      reject(new Error(ev.message));
    };
    worker.postMessage({ op, dir });
  });
}

(window as any).opfsTest = {
  supported: () => OpfsStorage.isSupported(),
  requestPersistence: () => OpfsStorage.requestPersistence(),
  roundTrip: (dir: string) => opfsRoundTrip(dir),
  tornLog: (dir: string) => opfsTornLog(dir),
  workerRoundTrip: (dir: string) => runInWorker('roundTrip', dir),
  workerTornLog: (dir: string) => runInWorker('tornLog', dir),
  async write(dir: string, name: string, text: string) {
    await new OpfsStorage(dir).write(name, new TextEncoder().encode(text));
  },
  async append(dir: string, name: string, text: string) {
    await new OpfsStorage(dir).append(name, new TextEncoder().encode(text));
  },
  async read(dir: string, name: string) {
    const b = await new OpfsStorage(dir).read(name);
    return b === null ? null : new TextDecoder().decode(b);
  },
};
(window as any).opfsReady = true;
