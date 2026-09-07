import { t } from 'spacetimedb/server';
import type { ReducerBinding } from '../client/local_first';
import { CLIENT_TS_PARAM, INTENT_ID_PARAM, LF_PARAMS, LF_WRAPPED } from '../shared/symbols';

export function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Build the equivalent of the generated client bindings' `reducers` map straight
 * from a module namespace object. Only offline-wrapped reducers are included.
 * Real apps use `spacetime generate`; this keeps the simulator self-contained.
 */
export function bindingsFromModule(mod: Record<string, any>): Record<string, ReducerBinding> {
  const out: Record<string, ReducerBinding> = {};
  for (const [key, val] of Object.entries(mod)) {
    if (key === 'default' || typeof val !== 'function' || !val[LF_WRAPPED]) continue;
    const params: Record<string, any> = {
      ...val[LF_PARAMS],
      [INTENT_ID_PARAM]: t.uuid(),
      [CLIENT_TS_PARAM]: t.timestamp(),
    };
    out[key] = {
      name: toSnakeCase(key),
      accessorName: key,
      paramsType: {
        elements: Object.entries(params).map(([name, tb]) => ({
          name,
          algebraicType: tb.algebraicType,
        })),
      },
    };
  }
  return out;
}
