import type { ColumnDef } from '../pager/record';
import type { JsonValue, Predicate, Row } from '../value';

export interface ColumnRef {
  qualifier?: string;
  name: string;
}

export type AggregateFn = 'count' | 'sum' | 'min' | 'max';

export interface AggregateRef {
  kind: 'aggregate';
  fn: AggregateFn;
  column: '*' | ColumnRef;
}

export type SelectItem = ColumnRef | AggregateRef;

export interface OrderKey {
  item: ColumnRef | AggregateRef;
  direction: 'asc' | 'desc';
}

export interface TableRef {
  name: string;
  alias?: string;
}

export type Statement =
  | { kind: 'create'; name: string; columns?: ColumnDef[] }
  | { kind: 'createIndex'; name: string; collection: string; column: string }
  | { kind: 'drop'; name: string }
  | { kind: 'dropIndex'; name: string }
  | { kind: 'dropAll' }
  | { kind: 'insert'; collection: string; row: Row }
  | { kind: 'update'; collection: string; data: Row; where: Predicate[] }
  | { kind: 'delete'; collection: string; where: Predicate[] }
  | {
      kind: 'select';
      columns: '*' | SelectItem[];
      from: TableRef[];
      where: Predicate[];
      group?: ColumnRef[];
      order?: OrderKey[];
      limit?: number;
    };

export type { JsonValue, Predicate, Row };
