/**
 * Stand-in for the host-only `spacetime:sys@2.0` / `spacetime:sys@2.1` modules.
 *
 * A SpacetimeDB TypeScript module imports `spacetimedb/server`, which imports these
 * virtual modules. They only exist inside the SpacetimeDB host. To run reducer
 * bodies on the client (for prediction) the bundler aliases both specifiers to this
 * file. Only the few functions that are touched at import time or by logging are
 * implemented; every datastore syscall throws, because reducer bodies never reach
 * them on the client: all table access goes through `ctx.db`, which the local
 * store provides.
 */

export class HostOnlyError extends Error {
  constructor(readonly syscall: string) {
    super(
      `spacetime:sys.${syscall} is only available inside the SpacetimeDB host. ` +
        `On the client, reducer bodies must access tables through ctx.db.`
    );
    this.name = 'HostOnlyError';
  }
}

const hostOnly =
  (name: string) =>
  (..._args: unknown[]): never => {
    throw new HostOnlyError(name);
  };

// `spacetimedb/server` replaces `globalThis.console` with one that forwards to
// `console_log`. Capture the real console before that happens (this module is
// evaluated before `polyfills.ts` because imports are evaluated depth-first).
const realConsole = globalThis.console;

export const moduleHooks: unique symbol = Symbol('spacetime:sys moduleHooks (shim)') as never;

export type ModuleHooks = unknown;

let shimIdentity = 0n;

/** Configure what `sys.identity()` returns (the "database identity"). */
export function __setShimIdentity(identity: bigint): void {
  shimIdentity = identity;
}

export function register_hooks(_hooks: unknown): void {}

export function console_log(level: number, message: string): void {
  switch (level) {
    case 0:
      realConsole.error(message);
      break;
    case 1:
      realConsole.warn(message);
      break;
    case 2:
      realConsole.info(message);
      break;
    case 3:
      realConsole.debug(message);
      break;
    case 4:
      realConsole.trace(message);
      break;
    default:
      realConsole.log(message);
  }
}

const timers = new Map<number, { name: string; start: number }>();
let nextTimer = 1;
export function console_timer_start(name: string): number {
  const id = nextTimer++;
  timers.set(id, { name, start: Date.now() });
  return id;
}
export function console_timer_end(id: number): void {
  const t = timers.get(id);
  if (!t) return;
  timers.delete(id);
  realConsole.info(`${t.name}: ${Date.now() - t.start}ms`);
}

export function identity(): bigint {
  return shimIdentity;
}

export function get_jwt_payload(_connectionId: bigint): Uint8Array {
  return new Uint8Array(0);
}

// ---- datastore / transaction / http syscalls: host only ----
export const table_id_from_name = hostOnly('table_id_from_name');
export const index_id_from_name = hostOnly('index_id_from_name');
export const datastore_table_row_count = hostOnly('datastore_table_row_count');
export const datastore_table_scan_bsatn = hostOnly('datastore_table_scan_bsatn');
export const datastore_index_scan_range_bsatn = hostOnly('datastore_index_scan_range_bsatn');
export const datastore_index_scan_point_bsatn = hostOnly('datastore_index_scan_point_bsatn');
export const row_iter_bsatn_advance = hostOnly('row_iter_bsatn_advance');
export const row_iter_bsatn_close = hostOnly('row_iter_bsatn_close');
export const datastore_insert_bsatn = hostOnly('datastore_insert_bsatn');
export const datastore_update_bsatn = hostOnly('datastore_update_bsatn');
export const datastore_delete_by_index_scan_range_bsatn = hostOnly(
  'datastore_delete_by_index_scan_range_bsatn'
);
export const datastore_delete_by_index_scan_point_bsatn = hostOnly(
  'datastore_delete_by_index_scan_point_bsatn'
);
export const datastore_delete_all_by_eq_bsatn = hostOnly('datastore_delete_all_by_eq_bsatn');
export const datastore_clear = hostOnly('datastore_clear');
export const volatile_nonatomic_schedule_immediate = hostOnly(
  'volatile_nonatomic_schedule_immediate'
);
export const procedure_http_request = hostOnly('procedure_http_request');
export const procedure_start_mut_tx = hostOnly('procedure_start_mut_tx');
export const procedure_commit_mut_tx = hostOnly('procedure_commit_mut_tx');
export const procedure_abort_mut_tx = hostOnly('procedure_abort_mut_tx');
