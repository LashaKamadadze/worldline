import { ConnectionId, Identity, Timestamp } from 'spacetimedb';
import { UnpredictableError } from './errors';
import type { LocalStore, StagedWrites } from './local_store';
import { makeRandom, uuidV4, uuidV7, type Rng } from './rng';
import type { Row } from './table_spec';

export interface ExecInfo {
  sender: Identity;
  timestamp: Timestamp;
  /** What the reducer sees as `ctx.clientTimestamp` (defaults to `timestamp`). */
  clientTimestamp?: Timestamp;
  connectionId: ConnectionId | null;
  rng: Rng;
  databaseIdentity?: Identity;
}

export type ExecOutcome =
  | { status: 'predicted'; writes: StagedWrites; readSet: Set<string>; writeSet: Set<string> }
  | { status: 'unpredicted'; reason: string; error: UnpredictableError }
  | { status: 'failed'; error: unknown };

/**
 * Run a reducer body against the local store inside a staged transaction.
 *
 * - A normal return commits the staged writes and reports read/write sets.
 * - `UnpredictableError` (cache miss, auto-increment, clear) means the intent is
 *   still valid for the server but the client cannot guess its effect.
 * - Any other throw means the reducer rejected the call; the server would too.
 */
export function executeReducer(
  store: LocalStore,
  fn: (ctx: any, args: Row) => unknown,
  args: Row,
  info: ExecInfo
): ExecOutcome {
  const tx = store.begin();
  const counter = { value: 0 };
  const ctx = Object.freeze({
    sender: info.sender,
    databaseIdentity: info.databaseIdentity ?? Identity.zero(),
    identity: info.databaseIdentity ?? Identity.zero(),
    timestamp: info.timestamp,
    clientTimestamp: info.clientTimestamp ?? info.timestamp,
    connectionId: info.connectionId,
    db: tx.db,
    senderAuth: Object.freeze({ isInternal: false, hasJWT: false, jwt: null }),
    random: makeRandom(info.rng),
    newUuidV4: () => uuidV4(info.rng),
    newUuidV7: () => uuidV7(info.rng, counter, info.timestamp.microsSinceUnixEpoch),
    as: Object.freeze({}),
  });
  try {
    fn(ctx, args);
  } catch (e) {
    tx.rollback();
    if (e instanceof UnpredictableError) {
      return { status: 'unpredicted', reason: e.reason, error: e };
    }
    return { status: 'failed', error: e };
  }
  const { writes, readSet, writeSet } = tx.commit();
  return { status: 'predicted', writes, readSet, writeSet };
}
