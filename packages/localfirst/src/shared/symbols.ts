/**
 * Symbols shared between the server wrapper and the client executor.
 *
 * `Symbol.for` (global registry) on purpose: a library bundle and an app bundle
 * may end up with two physical copies of this file (see SpacetimeDB issue
 * #5740 for how that happens with `link:` deps). Registry symbols still match.
 */
export const LF_INNER: unique symbol = Symbol.for('stdb-localfirst.inner') as never;
export const LF_WRAPPED: unique symbol = Symbol.for('stdb-localfirst.wrapped') as never;
export const LF_PARAMS: unique symbol = Symbol.for('stdb-localfirst.params') as never;

/** Parameter names the wrapper appends to every offline-capable reducer. */
export const INTENT_ID_PARAM = 'intentId';
export const CLIENT_TS_PARAM = 'clientTs';

/**
 * Session fence parameters, appended after the two above. An intent is only
 * applied when the pair names the sender's current session; a copy that was
 * still in the network when the client began a new session is rejected.
 */
export const SESSION_CLIENT_PARAM = 'lfClient';
export const SESSION_EPOCH_PARAM = 'lfEpoch';
