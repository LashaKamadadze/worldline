import { IntentLog, OpfsStorage, type IntentRecord } from '@kamadadze/worldline/client';
import { Uuid } from 'spacetimedb';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

/**
 * Adapter contract exercised on whichever thread this runs on (main or worker).
 * Returns plain data so the test can assert on it after postMessage/evaluate.
 */
export async function opfsRoundTrip(dirName: string): Promise<Record<string, unknown>> {
  const storage = new OpfsStorage(dirName);
  await storage.remove('a.txt');
  const missing = await storage.read('a.txt');
  await storage.append('a.txt', enc('hello '));
  await storage.append('a.txt', enc('world'));
  const appended = dec(await storage.read('a.txt'));
  await storage.write('a.txt', enc('replaced'));
  const written = dec(await storage.read('a.txt'));
  await storage.append('a.txt', enc('+tail'));
  const afterAppend = dec(await storage.read('a.txt'));
  await storage.remove('a.txt');
  const removed = await storage.read('a.txt');
  await storage.remove('a.txt'); // removing a missing file must not throw
  // Binary safety: every byte value round-trips.
  const bytes = new Uint8Array(256).map((_, i) => i);
  await storage.write('bin', bytes);
  const back = await storage.read('bin');
  const binaryOk = back !== null && back.length === 256 && back.every((b, i) => b === i);
  await storage.remove('bin');
  return {
    missing,
    appended,
    written,
    afterAppend,
    removed,
    binaryOk,
    syncAccessHandle:
      typeof (FileSystemFileHandle.prototype as any).createSyncAccessHandle === 'function',
  };
}

function record(n: number): IntentRecord {
  return {
    intentId: new Uuid(BigInt(n)),
    reducerName: 'create_todo',
    accessorName: 'createTodo',
    argsBsatn: new Uint8Array([n, n + 1, n + 2]),
    clientTsMicros: BigInt(1000 * n),
    predicted: true,
    readSet: [`todos:${n}`],
    writeSet: [`todos:${n}`],
  };
}

/** Torn-tail recovery of the two-slot intent log on real OPFS files. */
export async function opfsTornLog(dirName: string): Promise<Record<string, unknown>> {
  const storage = new OpfsStorage(dirName);
  for (const slot of ['a', 'b']) await storage.remove(`intents.log.${slot}`);
  const log = await IntentLog.open(storage);
  await log.append(record(1));
  await log.append(record(2));
  const file = `intents.log.${log.slot}`;
  const bytes = (await storage.read(file))!;
  await storage.write(file, bytes.subarray(0, bytes.length - 5));

  const again = await IntentLog.open(storage);
  const recoveredPending = again.pending.size;
  const recoveredTorn = again.recovery.torn;
  const movedSlot = again.slot !== log.slot;
  await again.append(record(3));
  const third = await IntentLog.open(storage);
  return {
    recoveredPending,
    recoveredTorn,
    movedSlot,
    afterAppendPending: third.pending.size,
    afterAppendTorn: third.recovery.torn,
    args: [...third.pending.values()].map(r => Array.from(r.argsBsatn)),
  };
}
