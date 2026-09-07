import { AlgebraicType, BinaryReader, BinaryWriter, ProductType } from 'spacetimedb';

export type Row = Record<string, any>;
export type Key = string | number | bigint | boolean;

export interface IndexSpec {
  /** Accessor on the table object, e.g. `id` for `ctx.db.todos.id.find(...)`. */
  name: string;
  columns: readonly string[];
  algorithm: 'btree' | 'hash' | 'direct';
  unique: boolean;
  isPrimaryKey: boolean;
}

export interface AutoIncSpec {
  column: string;
  /** `0` for <=32-bit integer columns, `0n` for wider ones, mirroring the host. */
  sentinel: 0 | 0n;
}

/** Everything the local store needs to know about one table, derived from the SDK table def. */
export interface TableSpec {
  sourceName: string;
  accessorName: string;
  /** Optional namespace alias when the table belongs to a mounted submodule. */
  namespace?: string;
  rowType: any;
  columnNames: string[];
  primaryKey: string | null;
  primaryKeyType: any;
  uniqueColumnSets: string[][];
  autoInc: AutoIncSpec[];
  indexes: IndexSpec[];
  /** Cheap structural fingerprint used to reject stale snapshots after schema changes. */
  fingerprint: string;
  serializeRow: (w: BinaryWriter, row: Row) => void;
  deserializeRow: (r: BinaryReader) => Row;
  rowKey: (row: Row) => Key;
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

function sentinelFor(tag: string): 0 | 0n {
  switch (tag) {
    case 'U8':
    case 'I8':
    case 'U16':
    case 'I16':
    case 'U32':
    case 'I32':
      return 0;
    default:
      return 0n;
  }
}

/**
 * Build a `TableSpec` from an SDK `UntypedTableDef` (what you get from
 * `mod.default.schemaType.tables.<name>` on the server schema, or from the
 * generated client bindings' remote module).
 */
export function tableSpecFromDef(def: any, namespace?: string): TableSpec {
  const rowType = def.rowType;
  const elements: { name: string; algebraicType: any }[] = rowType.elements;
  const columnNames = elements.map(e => e.name);
  const colType = (name: string) =>
    elements.find(e => e.name === name)?.algebraicType;

  const columns: Record<string, any> = def.columns ?? {};
  let primaryKey: string | null = null;
  const uniqueColumnSets: string[][] = [];
  const autoInc: AutoIncSpec[] = [];
  for (const [name, col] of Object.entries(columns)) {
    const md = (col as any).columnMetadata ?? {};
    if (md.isPrimaryKey) primaryKey = name;
    if (md.isPrimaryKey || md.isUnique) uniqueColumnSets.push([name]);
    if (md.isAutoIncrement) {
      autoInc.push({ column: name, sentinel: sentinelFor(colType(name)?.tag) });
    }
  }
  for (const c of def.constraints ?? []) {
    if (c.constraint === 'unique') {
      const cols = [...c.columns] as string[];
      if (!uniqueColumnSets.some(s => sameColumns(s, cols))) uniqueColumnSets.push(cols);
    }
  }

  const indexes: IndexSpec[] = (def.resolvedIndexes ?? []).map((idx: any) => {
    const cols = [...idx.columns] as string[];
    const unique =
      idx.unique === true || uniqueColumnSets.some(s => sameColumns(s, cols));
    return {
      name: idx.name,
      columns: cols,
      algorithm: idx.algorithm,
      unique,
      isPrimaryKey: primaryKey !== null && sameColumns(cols, [primaryKey]),
    };
  });

  const serializeRow = ProductType.makeSerializer(rowType);
  const deserializeRow = ProductType.makeDeserializer(rowType);
  const primaryKeyType = primaryKey ? colType(primaryKey) : null;

  const rowKey = (row: Row): Key => {
    if (primaryKey) {
      return AlgebraicType.intoMapKey(primaryKeyType, row[primaryKey]) as Key;
    }
    const w = new BinaryWriter(64);
    serializeRow(w, row);
    return w.toBase64();
  };

  const fingerprint = JSON.stringify({
    s: def.sourceName,
    e: elements.map(e => [e.name, e.algebraicType]),
    pk: primaryKey,
  });

  return {
    sourceName: def.sourceName,
    accessorName: def.accessorName,
    namespace,
    rowType,
    columnNames,
    primaryKey,
    primaryKeyType,
    uniqueColumnSets,
    autoInc,
    indexes,
    fingerprint,
    serializeRow,
    deserializeRow,
    rowKey,
  };
}

/** Build specs for every table in a server `schema()` object (`mod.default`). */
export function tableSpecsFromSchema(schemaObj: any, namespace?: string): TableSpec[] {
  const out: TableSpec[] = [];
  const tables = schemaObj?.schemaType?.tables ?? {};
  for (const def of Object.values(tables)) out.push(tableSpecFromDef(def, namespace));
  return out;
}
