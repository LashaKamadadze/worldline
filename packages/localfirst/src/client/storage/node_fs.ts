import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageAdapter } from './adapter';

/**
 * Plain files on disk. For Node, Bun, Electron and Tauri (via a Node sidecar or
 * an equivalent adapter over the Tauri fs plugin).
 *
 *  - append: O_APPEND write followed by fsync.
 *  - write: temp file + fsync + rename, so a crash leaves either the old or the
 *    new file, never a mix.
 */
export class NodeFsStorage implements StorageAdapter {
  #dir: string;
  #ready: Promise<void>;

  constructor(dir: string) {
    this.#dir = dir;
    this.#ready = mkdir(dir, { recursive: true }).then(() => undefined);
  }

  #path(name: string): string {
    if (name.includes('/') || name.includes('..')) {
      throw new Error(`invalid storage name '${name}'`);
    }
    return join(this.#dir, name);
  }

  async append(name: string, bytes: Uint8Array): Promise<void> {
    await this.#ready;
    const fh = await open(this.#path(name), 'a');
    try {
      await fh.write(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async read(name: string): Promise<Uint8Array | null> {
    await this.#ready;
    try {
      const buf = await readFile(this.#path(name));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    await this.#ready;
    const target = this.#path(name);
    const tmp = `${target}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.write(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  }

  async remove(name: string): Promise<void> {
    await this.#ready;
    await rm(this.#path(name), { force: true });
  }
}

// Keep `writeFile` referenced for environments that lack `open` (older Bun builds).
void writeFile;
