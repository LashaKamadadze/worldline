import { BinaryWriter, ProductType, type Uuid } from 'spacetimedb';
import { t } from 'spacetimedb/server';
import { assert } from './assert';
import { SESSION_EPOCH_MAX } from './limits';

/** A client's session fence: a stable per-device id and an epoch bumped on every connect. */
export interface Session {
  clientId: Uuid;
  epoch: bigint;
}

/** Wire name of the handshake reducer inside the submodule (`<alias>.begin_session`). */
export const SESSION_REDUCER = 'begin_session';

export const sessionReducerName = (alias: string): string => `${alias}.${SESSION_REDUCER}`;

/** Argument product of `begin_session`, as `spacetime generate` would describe it. */
export const SESSION_ARGS_TYPE = {
  elements: [
    { name: 'clientId', algebraicType: t.uuid().algebraicType },
    { name: 'epoch', algebraicType: t.u64().algebraicType },
  ],
};

const serializeSessionArgs = ProductType.makeSerializer(SESSION_ARGS_TYPE);
export const deserializeSessionArgs = ProductType.makeDeserializer(SESSION_ARGS_TYPE);

export function encodeSessionArgs(session: Session): Uint8Array {
  assert(session.epoch > 0n, 'session epoch must be positive');
  assert(session.epoch <= SESSION_EPOCH_MAX, 'session epoch above SESSION_EPOCH_MAX');
  const writer = new BinaryWriter(32);
  serializeSessionArgs(writer, session);
  return writer.getBuffer();
}
