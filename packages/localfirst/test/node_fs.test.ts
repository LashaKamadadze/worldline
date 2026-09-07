import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFsStorage } from '../src/client/storage/node_fs';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshStorage(): Promise<{ storage: NodeFsStorage; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'lf-nodefs-'));
  dirs.push(dir);
  return { storage: new NodeFsStorage(dir), dir };
}

describe('NodeFsStorage', () => {
  it('overlapping writes of one file never collide on a temp name', async () => {
    const { storage, dir } = await freshStorage();
    for (let round = 0; round < 20; round++) {
      const writes = [];
      for (let i = 0; i < 8; i++) writes.push(storage.write('snap', new Uint8Array([round, i])));
      await Promise.all(writes);
      const bytes = await storage.read('snap');
      expect(bytes?.[0]).toBe(round);
    }
    const leftovers = (await readdir(dir)).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('append then read round-trips and missing files read as null', async () => {
    const { storage } = await freshStorage();
    expect(await storage.read('missing')).toBeNull();
    await storage.append('log', new Uint8Array([1, 2]));
    await storage.append('log', new Uint8Array([3]));
    expect(Array.from((await storage.read('log')) ?? [])).toEqual([1, 2, 3]);
    await storage.remove('log');
    expect(await storage.read('log')).toBeNull();
  });

  it('lock is exclusive within a process and released on demand', async () => {
    const { storage } = await freshStorage();
    const release = await storage.lock();
    expect(release).not.toBeNull();
    expect(await storage.lock()).toBeNull();
    await release?.();
    const again = await storage.lock();
    expect(again).not.toBeNull();
    await again?.();
  });
});
