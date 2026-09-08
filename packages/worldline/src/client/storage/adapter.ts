import { assert } from '../../shared/assert';
import { STORAGE_NAME_CHARS_MAX, STORAGE_NAME_PATTERN } from '../../shared/limits';

/**
 * The only place the library touches disk.
 *
 * Every implementation must honor these promises:
 *  - `append` resolves only after the bytes are durable (flushed).
 *  - `write` replaces the whole file; it may be non-atomic, callers layer their
 *    own checksums and two-slot scheme on top.
 *  - `read` returns whatever is on disk, possibly a torn tail; callers validate.
 *  - `lock` (optional) grants exclusive use of the directory to one process or
 *    tab. `Worldline.open` refuses to run without it when the adapter offers it.
 *
 * Keeping this surface tiny is what makes the whole library simulatable: the
 * test harness swaps in an in-memory adapter with fault injection.
 */
export interface StorageAdapter {
  append(name: string, bytes: Uint8Array): Promise<void>;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  /** Acquire the single-writer lock. Resolves to a release function, or null if held elsewhere. */
  lock?(): Promise<(() => Promise<void>) | null>;
}

/** Validate a storage file name the same way in every adapter. */
export function assertStorageName(name: string): void {
  assert(name.length > 0, 'storage name is empty');
  assert(
    name.length <= STORAGE_NAME_CHARS_MAX,
    `storage name longer than ${STORAGE_NAME_CHARS_MAX}`
  );
  assert(STORAGE_NAME_PATTERN.test(name), `storage name '${name}' has invalid characters`);
  assert(!name.includes('..'), 'storage name must not contain ..');
}

export function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  assert(out.length === left.length + right.length, 'concat length mismatch');
  return out;
}
