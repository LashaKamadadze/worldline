import { BinaryReader, BinaryWriter } from 'spacetimedb';
import { assert, assertDefined } from '../shared/assert';
import { SNAPSHOT_BYTES_MAX, SNAPSHOT_ROWS_PER_TABLE_MAX, TABLES_MAX } from '../shared/limits';
import { decodeFrames, encodeFrame } from './framing';
import type { StorageAdapter } from './storage/adapter';
import type { Row, TableSpec } from './table_spec';

const MAGIC = 0x4c465331; // "LFS1"

export interface SnapshotMeta {
  generation: bigint;
  serverTsMicros: bigint;
  workingSetHash: string;
}

export interface LoadedSnapshot {
  meta: SnapshotMeta;
  tables: Map<string, Row[]>;
  /** Tables present on disk but skipped because their row type changed. */
  skipped: string[];
}

/**
 * Base-layer snapshot with a two-slot scheme: writes alternate between `.a`
 * and `.b`; on load both are parsed and the highest valid generation wins.
 * No rename needed, so it works the same on OPFS, files and IndexedDB.
 *
 * Only the base (server-confirmed) layer is ever snapshotted. Predicted rows
 * are rebuilt from the intent log on boot, which avoids double-applying them.
 */
export class SnapshotStore {
  #storage: StorageAdapter;
  #specs: Map<string, TableSpec>;
  #prefix: string;
  #generation = 0n;
  #nextSlot: 'a' | 'b' = 'a';

  constructor(storage: StorageAdapter, specs: Map<string, TableSpec>, prefix = 'snapshot') {
    this.#storage = storage;
    this.#specs = specs;
    this.#prefix = prefix;
  }

  async load(): Promise<LoadedSnapshot | null> {
    const a = await this.#loadSlot('a');
    const b = await this.#loadSlot('b');
    let best: LoadedSnapshot | null = a;
    if (b && (best === null || b.meta.generation > best.meta.generation)) best = b;
    if (best) {
      this.#generation = best.meta.generation;
      this.#nextSlot = best === a ? 'b' : 'a';
    }
    return best;
  }

  async #loadSlot(slot: 'a' | 'b'): Promise<LoadedSnapshot | null> {
    let bytes: Uint8Array | null;
    try {
      bytes = await this.#storage.read(`${this.#prefix}.${slot}`);
    } catch {
      return null;
    }
    if (!bytes || bytes.length === 0) return null;
    const { frames } = decodeFrames(bytes);
    if (frames.length !== 1) return null;
    try {
      return this.#decode(assertDefined(frames[0], 'one frame'));
    } catch {
      return null;
    }
  }

  #decode(payload: Uint8Array): LoadedSnapshot | null {
    const r = new BinaryReader(payload);
    if (r.readU32() !== MAGIC) return null;
    const generation = r.readU64();
    const serverTsMicros = r.readI64();
    const workingSetHash = r.readString();
    const n = r.readU32();
    if (n > TABLES_MAX) return null;
    const tables = new Map<string, Row[]>();
    const skipped: string[] = [];
    for (let i = 0; i < n; i++) {
      const accessor = r.readString();
      const fingerprint = r.readString();
      const rowCount = r.readU32();
      if (rowCount > SNAPSHOT_ROWS_PER_TABLE_MAX) return null;
      const bytes = r.readUInt8Array();
      const spec = this.#specs.get(accessor);
      if (!spec || spec.fingerprint !== fingerprint) {
        skipped.push(accessor);
        continue;
      }
      const rr = new BinaryReader(bytes);
      const rows: Row[] = [];
      for (let j = 0; j < rowCount; j++) rows.push(spec.deserializeRow(rr));
      tables.set(accessor, rows);
    }
    return { meta: { generation, serverTsMicros, workingSetHash }, tables, skipped };
  }

  async save(
    tables: Map<string, Iterable<Row>>,
    meta: Omit<SnapshotMeta, 'generation'>
  ): Promise<SnapshotMeta> {
    assert(tables.size <= TABLES_MAX, 'snapshot has more tables than TABLES_MAX');
    const generation = ++this.#generation;
    const w = new BinaryWriter(4096);
    w.writeU32(MAGIC);
    w.writeU64(generation);
    w.writeI64(meta.serverTsMicros);
    w.writeString(meta.workingSetHash);
    w.writeU32(tables.size);
    for (const [accessor, rows] of tables) {
      const spec = this.#specs.get(accessor);
      if (!spec) throw new Error(`snapshot: unknown table ${accessor}`);
      const tw = new BinaryWriter(1024);
      let count = 0;
      for (const row of rows) {
        spec.serializeRow(tw, row);
        count++;
        assert(count <= SNAPSHOT_ROWS_PER_TABLE_MAX, `snapshot of ${accessor} exceeds row bound`);
      }
      w.writeString(accessor);
      w.writeString(spec.fingerprint);
      w.writeU32(count);
      w.writeUInt8Array(tw.getBuffer());
    }
    const payload = w.getBuffer();
    assert(payload.length <= SNAPSHOT_BYTES_MAX, 'snapshot exceeds SNAPSHOT_BYTES_MAX');
    const slot = this.#nextSlot;
    this.#nextSlot = slot === 'a' ? 'b' : 'a';
    await this.#storage.write(`${this.#prefix}.${slot}`, encodeFrame(payload));
    assert(this.#generation === generation, 'generation changed during save');
    return { generation, ...meta };
  }
}
