import { schema, table, t, ScheduleAt, type ReducerCtx, SenderError } from 'spacetimedb/server';
import type { Identity, Timestamp, TypeBuilder, InferTypeOfParams, Uuid } from 'spacetimedb';
import {
  CLIENT_TS_PARAM,
  INTENT_ID_PARAM,
  WL_INNER,
  WL_PARAMS,
  WL_WRAPPED,
  SESSION_CLIENT_PARAM,
  SESSION_EPOCH_PARAM,
  SESSION_OWNER_MISMATCH,
} from '../shared/symbols';

/**
 * Server half of worldline: a submodule you mount under an alias, plus a
 * wrapper that makes a reducer safe to deliver at-least-once.
 *
 *   import * as worldline from '@kamadadze/worldline/server';
 *   const spacetimedb = schema({ todos, wl: worldline });
 *   export const createTodo = offlineReducer(spacetimedb, 'wl', { id: t.uuid() }, (ctx, a) => ...);
 *   export const init = spacetimedb.init(ctx => installPurge(ctx.as.wl, {}));
 */

const appliedIntents = table(
  { name: 'applied_intents' },
  {
    intentId: t.uuid().primaryKey(),
    sender: t.identity(),
    appliedAt: t.timestamp().index('btree'),
  }
);

/**
 * One row per client device. `epoch` is the newest session the client has
 * opened; intents carrying an older epoch are rejected, so a copy left in the
 * network by a previous connection can never be applied after the client has
 * already learned its fate on a newer one.
 */
const sessions = table(
  { name: 'sessions' },
  {
    clientId: t.uuid().primaryKey(),
    owner: t.identity(),
    epoch: t.u64(),
    lastSeen: t.timestamp(),
  }
);

const purgeScheduleRow = t.row({
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  /** Intents older than this are forgotten; a retried intent older than this may run twice. */
  retentionMicros: t.i64(),
});

const purgeSchedule = table({ name: 'purge_schedule' }, purgeScheduleRow);

const worldline = schema({ appliedIntents, purgeSchedule, sessions });
export default worldline;

export type WorldlineSchema = typeof worldline.schemaType;
export type WorldlineCtx = ReducerCtx<WorldlineSchema>;

/**
 * Scheduled reducer: drop dedup markers and sessions older than the retention
 * window. A client that has not opened a session within the window starts a
 * fresh one on its next connect, which is always accepted.
 */
export const purgeAppliedIntents = worldline.reducer(
  { onSchedule: purgeSchedule },
  { arg: purgeScheduleRow },
  (ctx, { arg }) => {
    const cutoff = ctx.timestamp.microsSinceUnixEpoch - arg.retentionMicros;
    const staleIntents: any[] = [];
    for (const row of ctx.db.appliedIntents.iter()) {
      if (row.appliedAt.microsSinceUnixEpoch < cutoff) staleIntents.push(row);
    }
    for (const row of staleIntents) ctx.db.appliedIntents.delete(row);
    const staleSessions: any[] = [];
    for (const row of ctx.db.sessions.iter()) {
      if (row.lastSeen.microsSinceUnixEpoch < cutoff) staleSessions.push(row);
    }
    for (const row of staleSessions) ctx.db.sessions.delete(row);
  }
);

export interface SessionArgs {
  clientId: Uuid;
  epoch: bigint;
}

/**
 * Open session `epoch` for `clientId` on behalf of `ctx.sender`. Epochs only
 * move forward, and a client id stays with the identity that first used it.
 * `ns` is the submodule's table view (`ctx.db` inside the submodule,
 * `ctx.db.<alias>` from the consumer module).
 */
export function beginSessionBody(ns: any, ctx: any, args: SessionArgs): void {
  const { clientId, epoch } = args;
  if (epoch <= 0n) throw new SenderError('session epoch must be positive');
  const row = ns.sessions.clientId.find(clientId);
  if (row !== null) {
    if (!(row.owner as Identity).isEqual(ctx.sender)) {
      throw new SenderError(SESSION_OWNER_MISMATCH);
    }
    if (epoch <= row.epoch) throw new SenderError('stale session epoch');
    ns.sessions.clientId.update({ clientId, owner: ctx.sender, epoch, lastSeen: ctx.timestamp });
    return;
  }
  ns.sessions.insert({ clientId, owner: ctx.sender, epoch, lastSeen: ctx.timestamp });
}

/** Handshake reducer; clients call it as `<alias>.begin_session` before draining. */
export const beginSession = worldline.reducer({ clientId: t.uuid(), epoch: t.u64() }, (ctx, args) =>
  beginSessionBody(ctx.db, ctx, args)
);

export const DAY_MICROS = 24n * 60n * 60n * 1_000_000n;
export const HOUR_MICROS = 60n * 60n * 1_000_000n;

/**
 * Call from the consumer's `init` with `ctx.as.<alias>` to start the purge
 * schedule. Idempotent. Retention decides how long a client may stay offline
 * before a lost ack could make a retried intent run twice (default 30 days).
 */
export function installPurge(
  ctx: WorldlineCtx,
  opts: { retentionMicros?: bigint; intervalMicros?: bigint } = {}
): void {
  if (ctx.db.purgeSchedule.count() > 0n) return;
  ctx.db.purgeSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(opts.intervalMicros ?? HOUR_MICROS),
    retentionMicros: opts.retentionMicros ?? 30n * DAY_MICROS,
  });
}

type AnyParams = Record<string, TypeBuilder<any, any>>;

export type OfflineCtx<S> = ReducerCtx<
  S extends { schemaType: infer D } ? (D extends object ? D : any) : any
> & {
  /** When the user acted on their device; server `timestamp` is when it committed. */
  readonly clientTimestamp: Timestamp;
};

export type OfflineReducerExport = ((ctx: any, args: any) => void) & {
  [WL_INNER]: (ctx: any, args: any) => void;
  [WL_WRAPPED]: true;
  [WL_PARAMS]: AnyParams;
};

function withClientTimestamp(ctx: any, clientTimestamp: Timestamp): any {
  return Object.freeze({
    get sender() {
      return ctx.sender;
    },
    get databaseIdentity() {
      return ctx.databaseIdentity;
    },
    get identity() {
      return ctx.identity;
    },
    get timestamp() {
      return ctx.timestamp;
    },
    get connectionId() {
      return ctx.connectionId;
    },
    get senderAuth() {
      return ctx.senderAuth;
    },
    get random() {
      return ctx.random;
    },
    get db() {
      return ctx.db;
    },
    get as() {
      return ctx.as;
    },
    newUuidV4: () => ctx.newUuidV4(),
    newUuidV7: () => ctx.newUuidV7(),
    clientTimestamp,
  });
}

const RESERVED_PARAMS = [
  INTENT_ID_PARAM,
  CLIENT_TS_PARAM,
  SESSION_CLIENT_PARAM,
  SESSION_EPOCH_PARAM,
];

/**
 * Define a reducer that clients may run offline and deliver later.
 *
 * Adds `intentId: uuid`, `clientTs: timestamp`, `wlClient: uuid` and
 * `wlEpoch: u64` parameters. On the server the wrapper checks
 * `applied_intents` first: a redelivered intent is a silent no-op, which is
 * what a client that never saw the ack needs. It then requires the session
 * named by `wlClient`/`wlEpoch` to be the client's current one, so a copy
 * from an earlier connection cannot run after the client has moved on. The
 * original body is exposed to the client executor for prediction.
 *
 * Rows created inside must use client-chosen keys (no auto-increment), or the
 * client cannot predict them.
 */
export function offlineReducer<
  S extends { reducer: (...args: any[]) => any; schemaType: any },
  P extends AnyParams,
>(
  spacetimedb: S,
  alias: string,
  params: P,
  fn: (ctx: OfflineCtx<S>, args: InferTypeOfParams<P>) => void
): OfflineReducerExport {
  for (const reserved of RESERVED_PARAMS) {
    if (reserved in params) {
      throw new TypeError(`offlineReducer: parameter '${reserved}' is reserved`);
    }
  }
  const fullParams = {
    ...params,
    [INTENT_ID_PARAM]: t.uuid(),
    [CLIENT_TS_PARAM]: t.timestamp(),
    [SESSION_CLIENT_PARAM]: t.uuid(),
    [SESSION_EPOCH_PARAM]: t.u64(),
  };
  const exp = spacetimedb.reducer(fullParams, (ctx: any, args: any) => {
    const {
      [INTENT_ID_PARAM]: intentId,
      [CLIENT_TS_PARAM]: clientTs,
      [SESSION_CLIENT_PARAM]: wlClient,
      [SESSION_EPOCH_PARAM]: wlEpoch,
      ...rest
    } = args;
    const ns = ctx.db[alias];
    if (!ns || !ns.appliedIntents || !ns.sessions) {
      const hint = `add \`${alias}: worldline\` to schema()`;
      throw new Error(`worldline: submodule not mounted under '${alias}'; ${hint}`);
    }
    if (ns.appliedIntents.intentId.find(intentId) !== null) {
      return; // already applied: at-least-once delivery collapses to exactly-once
    }
    const session = ns.sessions.clientId.find(wlClient);
    if (session === null || session.epoch !== wlEpoch) throw new SenderError('stale session');
    ns.appliedIntents.insert({ intentId, sender: ctx.sender, appliedAt: ctx.timestamp });
    try {
      fn(withClientTimestamp(ctx, clientTs), rest);
    } catch (error: unknown) {
      // The V8 host only forwards SenderError messages to the caller; anything
      // else arrives as "The instance encountered a fatal error". The client
      // predicted this failure with the same message, so it must see it.
      if (error instanceof SenderError) throw error;
      throw new SenderError(error instanceof Error ? error.message : String(error));
    }
  });
  exp[WL_INNER] = fn;
  exp[WL_WRAPPED] = true;
  exp[WL_PARAMS] = params;
  return exp as OfflineReducerExport;
}

export {
  WL_INNER,
  WL_WRAPPED,
  WL_PARAMS,
  INTENT_ID_PARAM,
  CLIENT_TS_PARAM,
  SESSION_CLIENT_PARAM,
  SESSION_EPOCH_PARAM,
};
