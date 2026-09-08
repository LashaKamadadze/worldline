import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStorageName, type StorageAdapter } from './adapter';

const LOCK_FILE = 'LOCK';
let tempCounter = 0;

/**
 * Plain files on disk. For Node, Bun, Electron and Tauri (via a Node sidecar or
 * an equivalent adapter over the Tauri fs plugin).
 *
 *  - append: O_APPEND write followed by fsync.
 *  - write: temp file + fsync + rename, so a crash leaves either the old or the
 *    new file, never a mix.
 *  - lock: an O_EXCL lock file holding the pid; stale locks from a dead pid are
 *    reclaimed, because a crash never gets to release.
 */
export class NodeFsStorage implements StorageAdapter {
  #directory: string;
  #ready: Promise<void>;

  constructor(directory: string) {
    this.#directory = directory;
    this.#ready = mkdir(directory, { recursive: true }).then(() => undefined);
  }

  #path(name: string): string {
    assertStorageName(name);
    return join(this.#directory, name);
  }

  async append(name: string, bytes: Uint8Array): Promise<void> {
    await this.#ready;
    const handle = await open(this.#path(name), 'a');
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async read(name: string): Promise<Uint8Array | null> {
    await this.#ready;
    try {
      const buffer = await readFile(this.#path(name));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    await this.#ready;
    const target = this.#path(name);
    // Unique per process and per call: two overlapping writes of the same file
    // must not race on one temp name (the second rename would hit ENOENT).
    tempCounter += 1;
    const temp = `${target}.${process.pid}.${tempCounter}.tmp`;
    const handle = await open(temp, 'w');
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    await this.#syncDirectory();
  }

  /** Make the rename itself durable. Windows cannot open a directory; skip there. */
  async #syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(this.#directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async remove(name: string): Promise<void> {
    await this.#ready;
    await rm(this.#path(name), { force: true });
  }

  async lock(): Promise<(() => Promise<void>) | null> {
    await this.#ready;
    const path = join(this.#directory, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => {
          await rm(path, { force: true });
        };
      } catch (error: unknown) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        if (!(await lockIsStale(path))) return null;
        await rm(path, { force: true });
      }
    }
    return null;
  }
}

/** A lock is stale when the pid it names is not running. */
async function lockIsStale(path: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number((await readFile(path, 'utf8')).trim());
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return (error as { code?: string }).code === 'ESRCH';
  }
}
