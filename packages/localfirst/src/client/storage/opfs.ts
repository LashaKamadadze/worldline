import { assertStorageName, type StorageAdapter } from './adapter';

const LOCK_NAME_PREFIX = 'stdb-localfirst:';

/**
 * Origin Private File System adapter for browsers.
 *
 * Inside a worker, `createSyncAccessHandle` gives real append + flush. On the
 * main thread only `createWritable` exists; it is still durable on `close()`,
 * but each append rewrites through a stream. Both paths are handled.
 *
 * The single-writer lock uses the Web Locks API, which is scoped to the origin
 * and released automatically when the tab dies.
 *
 * The caller should request persistent storage (`requestPersistence`) so the
 * browser does not evict the directory under disk pressure.
 */
export class OpfsStorage implements StorageAdapter {
  #directoryName: string;
  #directory: Promise<FileSystemDirectoryHandle>;

  constructor(directoryName = 'stdb-localfirst') {
    assertStorageName(directoryName);
    this.#directoryName = directoryName;
    this.#directory = navigator.storage
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
    assertStorageName(name);
    const directory = await this.#directory;
    try {
      return await directory.getFileHandle(name, { create });
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'NotFoundError') return null;
      throw error;
    }
  }

  async append(name: string, bytes: Uint8Array): Promise<void> {
    const handle = await this.#file(name, true);
    if (handle === null) throw new Error(`could not create ${name}`);
    const syncHandle = await tryCreateSyncAccessHandle(handle);
    if (syncHandle !== null) {
      try {
        syncHandle.write(bytes, { at: syncHandle.getSize() });
        syncHandle.flush();
      } finally {
        syncHandle.close();
      }
      return;
    }
    const writable = await handle.createWritable({ keepExistingData: true });
    const size = (await handle.getFile()).size;
    await writable.seek(size);
    await writable.write(toArrayBuffer(bytes));
    await writable.close();
  }

  async read(name: string): Promise<Uint8Array | null> {
    const handle = await this.#file(name, false);
    if (handle === null) return null;
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    const handle = await this.#file(name, true);
    if (handle === null) throw new Error(`could not create ${name}`);
    const syncHandle = await tryCreateSyncAccessHandle(handle);
    if (syncHandle !== null) {
      try {
        syncHandle.truncate(0);
        syncHandle.write(bytes, { at: 0 });
        syncHandle.flush();
      } finally {
        syncHandle.close();
      }
      return;
    }
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(toArrayBuffer(bytes));
    await writable.close();
  }

  async remove(name: string): Promise<void> {
    assertStorageName(name);
    const directory = await this.#directory;
    try {
      await directory.removeEntry(name);
    } catch (error: unknown) {
      if ((error as { name?: string }).name !== 'NotFoundError') throw error;
    }
  }

  async lock(): Promise<(() => Promise<void>) | null> {
    const locks = (navigator as { locks?: LockManager }).locks;
    if (locks === undefined) return null;
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    const granted = await new Promise<boolean>(resolve => {
      void locks.request(LOCK_NAME_PREFIX + this.#directoryName, { ifAvailable: true }, lock => {
        if (lock === null) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return held;
      });
    });
    if (!granted) return null;
    return async () => release();
  }
}

interface SyncAccessHandle {
  getSize(): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

async function tryCreateSyncAccessHandle(
  handle: FileSystemFileHandle
): Promise<SyncAccessHandle | null> {
  const candidate = handle as unknown as {
    createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
  };
  if (typeof candidate.createSyncAccessHandle !== 'function') return null;
  try {
    return await candidate.createSyncAccessHandle();
  } catch {
    return null; // Only available in dedicated workers; fall back to streams.
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
