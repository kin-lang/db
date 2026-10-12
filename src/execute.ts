import type { Bound } from './pager/index-key';
import { evaluateSelect } from './relational/algebra';
import type { Statement } from './parser/ast';
import { parse } from './parser/parser';
import { Store } from './store';
import type { Row } from './value';

export interface ExecuteResult {
  statements: number;
  /** One array per HITAMO, in source order. */
  rows: Row[][];
  inserted: number;
  updated: number;
  deleted: number;
  last:
    | { kind: 'empty' }
    | { kind: 'create' }
    | { kind: 'createIndex' }
    | { kind: 'drop' }
    | { kind: 'dropIndex' }
    | { kind: 'dropAll' }
    | { kind: 'insert'; row: Row }
    | { kind: 'update'; count: number }
    | { kind: 'delete'; count: number }
    | { kind: 'select'; rows: Row[] };
}

export function executeSource(source: string, store: Store): ExecuteResult {
  return executeStatements(parse(source), store);
}

export function executeStatements(statements: Statement[], store: Store): ExecuteResult {
  const result: ExecuteResult = {
    statements: statements.length,
    rows: [],
    inserted: 0,
    updated: 0,
    deleted: 0,
    last: { kind: 'empty' },
  };

  for (const statement of statements) {
    switch (statement.kind) {
      case 'create':
        store.createCollection(statement.name, statement.columns);
        result.last = { kind: 'create' };
        break;
      case 'createIndex':
        store.createIndex(statement.name, statement.collection, statement.column);
        result.last = { kind: 'createIndex' };
        break;
      case 'drop':
        store.dropCollection(statement.name);
        result.last = { kind: 'drop' };
        break;
      case 'dropIndex':
        store.dropIndex(statement.name);
        result.last = { kind: 'dropIndex' };
        break;
      case 'dropAll':
        store.delAll();
        result.last = { kind: 'dropAll' };
        break;
      case 'insert': {
        const row = store.add(statement.collection, statement.row);
        result.inserted += 1;
        result.last = { kind: 'insert', row };
        break;
      }
      case 'update': {
        const count = store.updateWhere(statement.collection, statement.where, statement.data);
        result.updated += count;
        result.last = { kind: 'update', count };
        break;
      }
      case 'delete': {
        const count = store.deleteWhere(statement.collection, statement.where);
        result.deleted += count;
        result.last = { kind: 'delete', count };
        break;
      }
      case 'select': {
        const rows = evaluateSelect(
          statement.from.map((ref) => ({
            ref,
            columns: store.columnNames(ref.name),
            indexed: store.indexedColumns(ref.name),
            forEach: (visit: (row: Row) => boolean) => store.forEach(ref.name, visit),
            probe: (column: string, key: Buffer, visit: (row: Row) => boolean) =>
              store.probe(ref.name, column, key, visit),
            range: (
              column: string,
              low: Bound | null,
              high: Bound | null,
              visit: (row: Row, rowid: number) => boolean,
            ) => store.scanRange(ref.name, column, low, high, visit),
            read: (predicates, limit, visit) =>
              store.read(
                ref.name,
                predicates,
                limit,
                (row, rowid) => visit(row, rowid),
                ref.alias ?? ref.name,
              ),
            readOrdered: (predicates, column, direction, limit, visit) =>
              store.readOrdered(
                ref.name,
                predicates,
                column,
                direction,
                limit,
                (row) => visit(row),
                ref.alias ?? ref.name,
              ),
          })),
          statement.where,
          statement.columns,
          statement.limit,
          statement.group,
          statement.order,
        );
        result.rows.push(rows);
        result.last = { kind: 'select', rows };
        break;
      }
    }
  }

  return result;
}


