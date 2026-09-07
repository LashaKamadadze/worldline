import { schema, table, t, ScheduleAt, type ReducerCtx } from 'spacetimedb/server';
import type { Timestamp, TypeBuilder, InferTypeOfParams } from 'spacetimedb';
import {
  CLIENT_TS_PARAM,
  INTENT_ID_PARAM,
  LF_INNER,
  LF_PARAMS,
  LF_WRAPPED,
} from '../shared/symbols';

/**
 * Server half of stdb-localfirst: a submodule you mount under an alias, plus a
 * wrapper that makes a reducer safe to deliver at-least-once.
 *
 *   import * as localfirst from 'stdb-localfirst/server';
 *   const spacetimedb = schema({ todos, lf: localfirst });
 *   export const createTodo = offlineReducer(spacetimedb, 'lf', { id: t.uuid() }, (ctx, a) => ...);
 *   export const init = spacetimedb.init(ctx => installPurge(ctx.as.lf, {}));
 */

const appliedIntents = table(
  { name: 'applied_intents' },
  {
    intentId: t.uuid().primaryKey(),
    sender: t.identity(),
    appliedAt: t.timestamp().index('btree'),
  }
);

const purgeScheduleRow = t.row({
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  /** Intents older than this are forgotten; a retried intent older than this may run twice. */
  retentionMicros: t.i64(),
});

const purgeSchedule = table({ name: 'purge_schedule' }, purgeScheduleRow);

const localfirst = schema({ appliedIntents, purgeSchedule });
export default localfirst;

export type LocalFirstSchema = typeof localfirst.schemaType;
export type LocalFirstCtx = ReducerCtx<LocalFirstSchema>;

/** Scheduled reducer: drop dedup markers older than the retention window. */
export const purgeAppliedIntents = localfirst.reducer(
  { onSchedule: purgeSchedule },
  { arg: purgeScheduleRow },
  (ctx, { arg }) => {
    const cutoff = ctx.timestamp.microsSinceUnixEpoch - arg.retentionMicros;
    const stale: any[] = [];
    for (const row of ctx.db.appliedIntents.iter()) {
      if (row.appliedAt.microsSinceUnixEpoch < cutoff) stale.push(row);
    }
    for (const row of stale) ctx.db.appliedIntents.delete(row);
  }
);

export const DAY_MICROS = 24n * 60n * 60n * 1_000_000n;
export const HOUR_MICROS = 60n * 60n * 1_000_000n;

/**
 * Call from the consumer's `init` with `ctx.as.<alias>` to start the purge
 * schedule. Idempotent. Retention decides how long a client may stay offline
 * before a lost ack could make a retried intent run twice (default 30 days).
 */
export function installPurge(
  ctx: LocalFirstCtx,
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
  [LF_INNER]: (ctx: any, args: any) => void;
  [LF_WRAPPED]: true;
  [LF_PARAMS]: AnyParams;
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

/**
 * Define a reducer that clients may run offline and deliver later.
 *
 * Adds `intentId: uuid` and `clientTs: timestamp` parameters. On the server the
 * wrapper checks `applied_intents` first: a redelivered intent is a silent
 * no-op, which is what a client that never saw the ack needs. The original
 * body is exposed to the client executor for prediction.
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
  if (INTENT_ID_PARAM in params || CLIENT_TS_PARAM in params) {
    throw new TypeError(
      `offlineReducer: parameters '${INTENT_ID_PARAM}' and '${CLIENT_TS_PARAM}' are reserved`
    );
  }
  const fullParams = {
    ...params,
    [INTENT_ID_PARAM]: t.uuid(),
    [CLIENT_TS_PARAM]: t.timestamp(),
  };
  const exp = spacetimedb.reducer(fullParams, (ctx: any, args: any) => {
    const { [INTENT_ID_PARAM]: intentId, [CLIENT_TS_PARAM]: clientTs, ...rest } = args;
    const ns = ctx.db[alias];
    if (!ns || !ns.appliedIntents) {
      const hint = `add \`${alias}: localfirst\` to schema()`;
      throw new Error(`stdb-localfirst: submodule not mounted under '${alias}'; ${hint}`);
    }
    if (ns.appliedIntents.intentId.find(intentId) !== null) {
      return; // already applied: at-least-once delivery collapses to exactly-once
    }
    ns.appliedIntents.insert({ intentId, sender: ctx.sender, appliedAt: ctx.timestamp });
    fn(withClientTimestamp(ctx, clientTs), rest);
  });
  exp[LF_INNER] = fn;
  exp[LF_WRAPPED] = true;
  exp[LF_PARAMS] = params;
  return exp as OfflineReducerExport;
}

export { LF_INNER, LF_WRAPPED, LF_PARAMS, INTENT_ID_PARAM, CLIENT_TS_PARAM };
