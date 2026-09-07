/**
 * The only place the library touches disk.
 *
 * Every implementation must honor three promises:
 *  - `append` resolves only after the bytes are durable (flushed).
 *  - `write` replaces the whole file; it may be non-atomic, callers layer their
 *    own checksums and two-slot scheme on top.
 *  - `read` returns whatever is on disk, possibly a torn tail; callers validate.
 *
 * Keeping this surface tiny is what makes the whole library simulatable: the
 * test harness swaps in an in-memory adapter with fault injection.
 */
export interface StorageAdapter {
  append(name: string, bytes: Uint8Array): Promise<void>;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
