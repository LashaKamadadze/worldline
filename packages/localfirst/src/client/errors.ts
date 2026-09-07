/** Thrown by the local store when a reducer body cannot be predicted on this client. */
export class UnpredictableError extends Error {
  constructor(readonly reason: string, message?: string) {
    super(message ?? `cannot predict locally: ${reason}`);
    this.name = 'UnpredictableError';
  }
}

/**
 * A lookup missed the cache on a table whose working-set coverage is `partial`.
 * `null` there means "unknown", not "absent", so prediction must stop.
 */
export class CacheMissError extends UnpredictableError {
  constructor(readonly table: string, readonly key: string) {
    super('cache-miss', `cache miss on ${table} (${key}); table coverage is partial`);
    this.name = 'CacheMissError';
  }
}

/** Raised when the same intent is submitted twice, or the log is corrupt beyond recovery. */
export class LocalFirstError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalFirstError';
  }
}
