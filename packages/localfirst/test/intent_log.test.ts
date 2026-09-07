import { Uuid } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { IntentLog, type IntentRecord } from '../src/client/intent_log';
import { MemoryStorage } from '../src/client/storage/memory';

const rec = (n: number): IntentRecord => ({
  intentId: new Uuid(BigInt(n) + 1n),
  reducerName: 'create_todo',
  accessorName: 'createTodo',
  argsBsatn: new Uint8Array([n, n + 1]),
  clientTsMicros: BigInt(1000 * n),
  predicted: true,
  readSet: [`todos:${n}`],
  writeSet: [`todos:${n}`, 'todos:*'],
});

describe('IntentLog', () => {
  it('persists intents and marks, and recovers pending after reopen', async () => {
    const storage = new MemoryStorage();
    const log = await IntentLog.open(storage);
    await log.append(rec(1));
    await log.append(rec(2));
    await log.append(rec(3));
    await log.mark(rec(2).intentId, 'acked');
    expect([...log.pending.keys()].length).toBe(2);

    const again = await IntentLog.open(storage);
    expect([...again.pending.values()].map(r => r.intentId.asBigInt())).toEqual([2n, 4n]);
    const r = again.pending.get(rec(3).intentId.toString())!;
    expect([...r.argsBsatn]).toEqual([3, 4]);
    expect(r.readSet).toEqual(['todos:3']);
    expect(r.writeSet).toEqual(['todos:3', 'todos:*']);
    expect(r.clientTsMicros).toBe(3000n);
    expect(again.recovery.torn).toBe(false);
  });

  it('drops a torn tail on recovery and keeps appending cleanly', async () => {
    const storage = new MemoryStorage();
    const log = await IntentLog.open(storage);
    await log.append(rec(1));
    await log.append(rec(2));
    // Simulate a torn append: chop the active slot mid-frame.
    const file = `intents.log.${log.slot}`;
    const bytes = storage.peek(file)!;
    await storage.write(file, bytes.subarray(0, bytes.length - 5));

    const again = await IntentLog.open(storage);
    expect(again.recovery.torn).toBe(true);
    expect([...again.pending.keys()].length).toBe(1);
    expect(again.clean).toBe(true); // moved to a fresh slot
    expect(again.slot).not.toBe(log.slot);
    await again.append(rec(3));
    const third = await IntentLog.open(storage);
    expect([...third.pending.keys()].length).toBe(2);
    expect(third.recovery.torn).toBe(false);
  });

  it('compacts to only pending intents', async () => {
    const storage = new MemoryStorage();
    const log = await IntentLog.open(storage);
    for (let i = 1; i <= 5; i++) await log.append(rec(i));
    for (let i = 1; i <= 4; i++) await log.mark(rec(i).intentId, i % 2 ? 'acked' : 'failed', 'x');
    const before = storage.peek(`intents.log.${log.slot}`)!.length;
    await log.compact();
    expect(storage.peek(`intents.log.${log.slot}`)!.length).toBeLessThan(before);
    const again = await IntentLog.open(storage);
    expect([...again.pending.keys()]).toEqual([rec(5).intentId.toString()]);
  });

  it('keeps a volatile intent in memory when the append fails', async () => {
    const storage = new MemoryStorage();
    const log = await IntentLog.open(storage);
    storage.fault = op => (op === 'append' ? 'fail' : undefined);
    await expect(log.append(rec(1))).rejects.toThrow();
    expect(log.pending.size).toBe(1);
  });

  it('a torn compaction never loses durable intents', async () => {
    const storage = new MemoryStorage();
    const log = await IntentLog.open(storage);
    await log.append(rec(1));
    await log.append(rec(2));
    // Compaction target write tears; the old slot must remain authoritative.
    storage.fault = (op, _n, bytes) => (op === 'write' && bytes ? Math.floor(bytes.length / 2) : undefined);
    await expect(log.compact()).rejects.toThrow();
    storage.fault = undefined;
    const again = await IntentLog.open(storage);
    expect([...again.pending.keys()].length).toBe(2);
  });
});
