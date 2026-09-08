import type { Identity } from 'spacetimedb';
import type { Delta } from './local_store';
import type { Row } from './table_spec';

/** Sends reducer calls. Resolves on server commit, rejects with the reducer's error on failure. */
export interface Transport {
  callReducer(reducerName: string, argsBsatn: Uint8Array): Promise<void>;
}

/** Feeds server truth into the base layer. */
export interface ServerEvents {
  /** Full state for the working set (initial subscription applied). */
  onInitialState(cb: (tables: Map<string, Row[]>) => void): () => void;
  /** Incremental change to one table. */
  onDelta(cb: (accessor: string, delta: Delta) => void): () => void;
}

/** A live connection to the server: transport + events + who we are. */
export interface Link {
  transport: Transport;
  events: ServerEvents;
  identity?: Identity;
  dispose(): void;
}
