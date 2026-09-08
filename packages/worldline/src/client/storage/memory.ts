import { assertStorageName, concatBytes, type StorageAdapter } from './adapter';

export type StorageOp = 'append' | 'read' | 'write' | 'remove';

/**
 * Hook invoked before every operation. Return:
 *  - `undefined` to proceed normally,
 *  - `'fail'` to reject the operation without touching data,
 *  - a number `n` (for `append`/`write`) to write only the first `n` bytes and
 *    then reject: a torn write, exactly what a power loss mid-write looks like.
 */
export type FaultHook = (
  op: StorageOp,
  name: string,
  bytes?: Uint8Array
) => undefined | 'fail' | number;

export class StorageFault extends Error {
  constructor(
    op: StorageOp,
    name: string,
    readonly torn: boolean
  ) {
    super(`storage ${op} on '${name}' failed${torn ? ' (torn write)' : ''}`);
    this.name = 'StorageFault';
  }
}

/** In-memory adapter. Used by tests and as the browser fallback when OPFS is unavailable. */
export class MemoryStorage implements StorageAdapter {
  #files = new Map<string, Uint8Array>();
  #locked = false;
  fault: FaultHook | undefined;

  constructor(fault?: FaultHook) {
    this.fault = fault;
  }

  async append(name: string, bytes: Uint8Array): Promise<void> {
    assertStorageName(name);
    const verdict = this.fault?.('append', name, bytes);
    if (verdict === 'fail') throw new StorageFault('append', name, false);
    const current = this.#files.get(name) ?? new Uint8Array(0);
    if (typeof verdict === 'number') {
      this.#files.set(name, concatBytes(current, bytes.subarray(0, verdict)));
      throw new StorageFault('append', name, true);
    }
    this.#files.set(name, concatBytes(current, bytes));
  }

  async read(name: string): Promise<Uint8Array | null> {
    assertStorageName(name);
    const verdict = this.fault?.('read', name);
    if (verdict === 'fail') throw new StorageFault('read', name, false);
    const file = this.#files.get(name);
    return file === undefined ? null : file.slice();
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    assertStorageName(name);
    const verdict = this.fault?.('write', name, bytes);
    if (verdict === 'fail') throw new StorageFault('write', name, false);
    if (typeof verdict === 'number') {
      this.#files.set(name, bytes.slice(0, verdict));
      throw new StorageFault('write', name, true);
    }
    this.#files.set(name, bytes.slice());
  }

  async remove(name: string): Promise<void> {
    assertStorageName(name);
    const verdict = this.fault?.('remove', name);
    if (verdict === 'fail') throw new StorageFault('remove', name, false);
    this.#files.delete(name);
  }

  async lock(): Promise<(() => Promise<void>) | null> {
    if (this.#locked) return null;
    this.#locked = true;
    return async () => {
      this.#locked = false;
    };
  }

  /** Test helper: the raw contents of a file. */
  peek(name: string): Uint8Array | undefined {
    return this.#files.get(name);
  }

  /** Test helper: total bytes stored. */
  get size(): number {
    let total = 0;
    for (const file of this.#files.values()) total += file.length;
    return total;
  }

  /** Test helper: deep copy, so a "crash" can restart from the same bytes. */
  clone(): MemoryStorage {
    const copy = new MemoryStorage(this.fault);
    for (const [name, file] of this.#files) copy.#files.set(name, file.slice());
    return copy;
  }

  /** Test helper: raw bytes of every file (copied). Bypasses fault injection. */
  exportFiles(): Map<string, Uint8Array> {
    return new Map([...this.#files].map(([name, file]) => [name, file.slice()]));
  }

  /** Test helper: replace all files. Bypasses fault injection and drops the lock, like a crash. */
  importFiles(files: Map<string, Uint8Array>): void {
    this.#files = new Map([...files].map(([name, file]) => [name, file.slice()]));
    this.#locked = false;
  }
}
