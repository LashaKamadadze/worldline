import { concatBytes, type StorageAdapter } from './adapter';

/**
 * Origin Private File System adapter for browsers.
 *
 * Inside a worker, `createSyncAccessHandle` gives real append + flush. On the
 * main thread only `createWritable` exists; it is still durable on `close()`,
 * but each append rewrites through a stream. Both paths are handled.
 *
 * The caller should request persistent storage (`navigator.storage.persist()`)
 * so the browser does not evict the directory under disk pressure.
 */
export class OpfsStorage implements StorageAdapter {
  #dir: Promise<FileSystemDirectoryHandle>;

  constructor(directoryName = 'stdb-localfirst') {
    this.#dir = navigator.storage
      .getDirectory()
      .then(root => root.getDirectoryHandle(directoryName, { create: true }));
  }

  /**
   * Ask the browser not to evict this origin's storage under disk pressure.
   * Returns whether persistence is granted. Call before relying on the log.
   */
  static async requestPersistence(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return navigator.storage.persist();
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    );
  }

  async #file(name: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const dir = await this.#dir;
    try {
      return await dir.getFileHandle(name, { create });
    } catch (e: any) {
      if (e?.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async append(name: string, bytes: Uint8Array): Promise<void> {
    const fh = (await this.#file(name, true))!;
    const anyFh = fh as any;
    if (typeof anyFh.createSyncAccessHandle === 'function') {
      const h = await anyFh.createSyncAccessHandle();
      try {
        const size = h.getSize();
        h.write(bytes, { at: size });
        h.flush();
      } finally {
        h.close();
      }
      return;
    }
    const w = await fh.createWritable({ keepExistingData: true });
    const size = (await fh.getFile()).size;
    await w.seek(size);
    await w.write(toArrayBuffer(bytes));
    await w.close();
  }

  async read(name: string): Promise<Uint8Array | null> {
    const fh = await this.#file(name, false);
    if (!fh) return null;
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    const fh = (await this.#file(name, true))!;
    const anyFh = fh as any;
    if (typeof anyFh.createSyncAccessHandle === 'function') {
      const h = await anyFh.createSyncAccessHandle();
      try {
        h.truncate(0);
        h.write(bytes, { at: 0 });
        h.flush();
      } finally {
        h.close();
      }
      return;
    }
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(toArrayBuffer(bytes));
    await w.close();
  }

  async remove(name: string): Promise<void> {
    const dir = await this.#dir;
    try {
      await dir.removeEntry(name);
    } catch (e: any) {
      if (e?.name !== 'NotFoundError') throw e;
    }
  }
}

void concatBytes;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
