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
    | { kind: 'drop' }
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
      case 'drop':
        store.dropCollection(statement.name);
        result.last = { kind: 'drop' };
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
            rows: store.rows(ref.name),
            columns: store.columnNames(ref.name),
          })),
          statement.where,
          statement.columns,
          statement.limit,
        );
        result.rows.push(rows);
        result.last = { kind: 'select', rows };
        break;
      }
    }
  }

  return result;
}


