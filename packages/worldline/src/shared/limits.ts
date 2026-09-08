import { assert } from './assert';

/**
 * Every queue, loop and buffer in the library is bounded by one of these.
 * The numbers are deliberate: they are what a single desktop or browser
 * client can hold in memory and replay in well under a second.
 */

/** Pending (unacknowledged) intents a client may accumulate before `call()` refuses. */
export const INTENTS_PENDING_MAX = 10_000;

/** Intents replayed per rebase; equals the pending bound by construction. */
export const REBASE_INTENTS_MAX = INTENTS_PENDING_MAX;

/** Serialized reducer arguments per intent. */
export const INTENT_ARGS_BYTES_MAX = 1 * 1024 * 1024;

/** One log frame (header + payload). Larger frames are corrupt by definition. */
export const LOG_FRAME_BYTES_MAX = INTENT_ARGS_BYTES_MAX + 64 * 1024;

/** Entries kept per intent for dependency tracking; beyond this, reads collapse to a table scan. */
export const READ_SET_ENTRIES_MAX = 4_096;
export const WRITE_SET_ENTRIES_MAX = 4_096;

/** Intents awaiting an ack at once. */
export const INFLIGHT_WINDOW_MAX = 64;

/** Tables a module may expose to the client store. */
export const TABLES_MAX = 1_024;

/** Rows per table in a snapshot; larger working sets must be split. */
export const SNAPSHOT_ROWS_PER_TABLE_MAX = 1_000_000;

/** Total bytes of one snapshot slot. */
export const SNAPSHOT_BYTES_MAX = 512 * 1024 * 1024;

/** Log slot size at which the next write compacts regardless of pending count. */
export const LOG_SLOT_BYTES_COMPACT_AT = 64 * 1024 * 1024;

/** Reducer wire name length (SpacetimeDB identifiers are at most 63 chars plus namespaces). */
export const REDUCER_NAME_CHARS_MAX = 255;

/** Storage file names accepted by adapters. */
export const STORAGE_NAME_CHARS_MAX = 64;
export const STORAGE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Listeners of one kind on one Worldline instance. */
export const LISTENERS_MAX = 1_024;

/** Debounce for automatic snapshots, bounded so a stuck timer cannot delay forever. */
export const SNAPSHOT_DEBOUNCE_MS_DEFAULT = 2_000;
export const SNAPSHOT_DEBOUNCE_MS_MAX = 60_000;

/** Session epochs are u64 on the wire; one is consumed per `connect()`. */
export const SESSION_EPOCH_MAX = (1n << 64n) - 1n;

/** Marks appended between compactions once the queue is empty. */
export const COMPACT_EVERY_MARKS_DEFAULT = 64;

/** Timestamps the library accepts (microseconds since Unix epoch): 2000-01-01 .. 2200-01-01. */
export const TIMESTAMP_MICROS_MIN = 946_684_800_000_000n;
export const TIMESTAMP_MICROS_MAX = 7_258_118_400_000_000n;

// Relationships between limits, asserted once at load so a careless edit fails fast.
assert(REBASE_INTENTS_MAX === INTENTS_PENDING_MAX, 'rebase bound must equal pending bound');
assert(LOG_FRAME_BYTES_MAX > INTENT_ARGS_BYTES_MAX, 'a frame must hold the largest args');
assert(INFLIGHT_WINDOW_MAX <= INTENTS_PENDING_MAX, 'window cannot exceed pending');
assert(SNAPSHOT_DEBOUNCE_MS_DEFAULT <= SNAPSHOT_DEBOUNCE_MS_MAX, 'default debounce within max');
assert(TIMESTAMP_MICROS_MIN < TIMESTAMP_MICROS_MAX, 'timestamp range is ordered');
assert(SESSION_EPOCH_MAX > 0n, 'session epoch bound positive');
assert(READ_SET_ENTRIES_MAX > 0, 'read set bound positive');
assert(WRITE_SET_ENTRIES_MAX > 0, 'write set bound positive');
