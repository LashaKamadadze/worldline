/**
 * Regression tests for two storage races first seen while running the live
 * scenarios ("snapshot failed ... ENOENT rename snapshot.a.tmp" warnings):
 *
 *  1. `NodeFsStorage.write` used one temp name per target, so two concurrent
 *     writes of the same file raced on the same temp path. Now every write
 *     gets its own temp name.
 *  2. `Worldline.close()` did not await a snapshot already in flight, so
 *     removing the directory right after `close()` made that write fail.
 *     Now `close()` waits for it.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFsStorage } from '@kamadadze/worldline/client/node';

describe('NodeFsStorage', () => {
  it('concurrent writes of the same file both succeed and leave a whole file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stdb-race-'));
    const storage = new NodeFsStorage(dir);
    const a = new Uint8Array(64 * 1024).fill(1);
    const b = new Uint8Array(64 * 1024).fill(2);
    let failures = 0;
    for (let round = 0; round < 20; round++) {
      const results = await Promise.allSettled([storage.write('f', a), storage.write('f', b)]);
      failures += results.filter(r => r.status === 'rejected').length;
      const got = await readFile(join(dir, 'f'));
      const whole = got.every(x => x === got[0]) && got.length === a.length;
      expect(whole).toBe(true);
    }
    await rm(dir, { recursive: true, force: true });
    expect(failures).toBe(0);
  });
});
