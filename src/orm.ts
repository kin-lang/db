import type { Transaction } from './database';
import { KinDbError } from './errors';
import {
  assertValueType,
  COLUMN_TYPES,
  columnTypeFromName,
  type ColumnDef,
  type FieldKind,
} from './pager/record';
import { assertSqlName } from './sql';
import {
  assertRow,
  type FieldFilter,
  type JsonValue,
  type Row,
  type Where,
} from './value';

export type { FieldKind };

/** A collection's fields: each name maps to a {@link FieldKind}. */
export type ModelFields = Record<string, FieldKind>;

type StoredValue = {
  number: number;
  string: string;
  boolean: boolean;
  any: JsonValue;
};

/** One field's stored value. `null` (`ubusa`) is allowed on every field. */
export type FieldValue<K extends FieldKind> = StoredValue[(typeof COLUMN_TYPES)[K]];

/** Columns written by {@link Repository.shira} and {@link Repository.hindura}. Every field is optional. */
export type ModelRow<F extends ModelFields> = {
  [K in keyof F]?: FieldValue<F[K]> | null;
};

/** `where` for a model. Keys are the model's fields. Comparisons match `Database.get`. */
export type ModelWhere<F extends ModelFields> = {
  [K in keyof F]?: FieldFilter;
};

export interface Model<F extends ModelFields> {
  readonly collection: string;
  /** Declared columns, with Kinyarwanda type names normalized to number, string, boolean, or any. */
  readonly columns: ColumnDef[];
  /** Bind this description to a database or to an open transaction. */
  on(session: Transaction): Repository<F>;
}

/**
 * One collection on one session.
 * `kora`, `shira`, `hindura`, and `siba` call that session, so an open
 * transaction still writes the file once when its callback returns.
 */
export interface Repository<F extends ModelFields> {
  readonly collection: string;
  readonly columns: ColumnDef[];
  /** Create the collection with this model's columns. */
  kora(): void;
  shira(data: ModelRow<F>): ModelRow<F>;
  hitamo(params?: { where?: ModelWhere<F>; limit?: number }): ModelRow<F>[];
  hindura(params: { where: ModelWhere<F>; data: ModelRow<F> }): void;
  siba(params: { where: ModelWhere<F> }): number;
}

/**
 * Describe one collection.
 * Call {@link Model.on} with a `Database` or a transaction, then
 * `kora`, `shira`, `hitamo`, `hindura`, and `siba` run on that session.
 */
export function model<const F extends ModelFields>(collection: string, fields: F): Model<F> {
  assertSqlName(collection, 'Collection name');
  const columns = normalizeColumns(collection, fields);
  return {
    collection,
    columns,
    on(session) {
      return bind(session, collection, columns);
    },
  };
}

function normalizeColumns(collection: string, fields: ModelFields): ColumnDef[] {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new KinDbError('E_TYPE', 'model() expects an object of field types');
  }
  const columns: ColumnDef[] = [];
  for (const name of Object.keys(fields)) {
    assertFieldName(collection, name);
    const raw: unknown = fields[name];
    if (typeof raw !== 'string' || !isFieldKind(raw)) {
      throw new KinDbError(
        'E_TYPE',
        `Field '${name}' on model '${collection}' has type '${String(raw)}', expected number, string, boolean, any, umubare, ijambo, ukuri, or ikintu`,
      );
    }
    columns.push({ name, type: columnTypeFromName(raw) });
  }
  return columns;
}

function isFieldKind(value: string): value is FieldKind {
  return Object.prototype.hasOwnProperty.call(COLUMN_TYPES, value.toLowerCase());
}

function assertFieldName(collection: string, name: string): void {
  assertSqlName(name, 'Field');
  if (!collection) {
    throw new KinDbError('E_TYPE', 'model() needs a collection name');
  }
}

function bind<F extends ModelFields>(
  session: Transaction,
  collection: string,
  columns: ColumnDef[],
): Repository<F> {
  const byName = new Map(columns.map((column) => [column.name, column]));

  function assertData(data: ModelRow<F>): Row {
    assertRow(data, 'data');
    const row = data as Row;
    for (const key of Object.keys(row)) {
      const column = byName.get(key);
      if (!column) {
        throw new KinDbError('E_TYPE', `Field '${key}' is not on model '${collection}'`);
      }
      assertValueType(column, row[key]);
    }
    return row;
  }

  function assertWhere(where: ModelWhere<F>): Where {
    if (where === null || typeof where !== 'object' || Array.isArray(where)) {
      throw new KinDbError('E_TYPE', 'where must be an object');
    }
    for (const key of Object.keys(where)) {
      if (!byName.has(key)) {
        throw new KinDbError('E_TYPE', `Field '${key}' is not on model '${collection}'`);
      }
    }
    return where as Where;
  }

  return {
    collection,
    columns,
    kora() {
      session.createCollection(collection, columns.map((column) => ({ ...column })));
    },
    shira(data) {
      return session.add({ collection, data: assertData(data) }) as ModelRow<F>;
    },
    hitamo(params = {}) {
      return session.get({
        collection,
        where: params.where === undefined ? undefined : assertWhere(params.where),
        limit: params.limit,
      }) as ModelRow<F>[];
    },
    hindura(params) {
      session.set({
        collection,
        where: assertWhere(params.where),
        data: assertData(params.data),
      });
    },
    siba(params) {
      return session.del({ collection, where: assertWhere(params.where) });
    },
  };
}
