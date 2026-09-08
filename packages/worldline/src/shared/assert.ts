/**
 * Assertions are on in production. A violated assertion means the program's
 * model of the world is wrong, and continuing would corrupt state that is
 * persisted and replayed. Failing loudly is the safe option.
 */
export class AssertionError extends Error {
  constructor(message: string) {
    super(`@kamadadze/worldline assertion failed: ${message}`);
    this.name = 'AssertionError';
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

/** Assert that a value is neither null nor undefined and return it narrowed. */
export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new AssertionError(message);
  return value;
}

/** Negative space: a branch the type system says cannot be reached. */
export function unreachable(value: never, message = 'unreachable'): never {
  throw new AssertionError(`${message}: ${String(value)}`);
}
