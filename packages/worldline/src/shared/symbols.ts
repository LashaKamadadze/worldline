/**
 * Symbols shared between the server wrapper and the client executor.
 *
 * `Symbol.for` (global registry) on purpose: a library bundle and an app bundle
 * may end up with two physical copies of this file (see SpacetimeDB issue
 * #5740 for how that happens with `link:` deps). Registry symbols still match.
 */
export const WL_INNER: unique symbol = Symbol.for('worldline.inner') as never;
export const WL_WRAPPED: unique symbol = Symbol.for('worldline.wrapped') as never;
export const WL_PARAMS: unique symbol = Symbol.for('worldline.params') as never;

/** Parameter names the wrapper appends to every offline-capable reducer. */
export const INTENT_ID_PARAM = 'intentId';
export const CLIENT_TS_PARAM = 'clientTs';

/** Rejection text of `begin_session` when the stored client id is owned by another identity. */
export const SESSION_OWNER_MISMATCH = 'client id belongs to another identity';

/**
 * Session fence parameters, appended after the two above. An intent is only
 * applied when the pair names the sender's current session; a copy that was
 * still in the network when the client began a new session is rejected.
 */
export const SESSION_CLIENT_PARAM = 'wlClient';
export const SESSION_EPOCH_PARAM = 'wlEpoch';
