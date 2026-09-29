import type { ColumnDef } from '../pager/record';
import type { JsonValue, Predicate, Row } from '../value';

export interface ColumnRef {
  qualifier?: string;
  name: string;
}

export interface TableRef {
  name: string;
  alias?: string;
}

export type Statement =
  | { kind: 'create'; name: string; columns?: ColumnDef[] }
  | { kind: 'drop'; name: string }
  | { kind: 'dropAll' }
  | { kind: 'insert'; collection: string; row: Row }
  | { kind: 'update'; collection: string; data: Row; where: Predicate[] }
  | { kind: 'delete'; collection: string; where: Predicate[] }
  | {
      kind: 'select';
      columns: '*' | ColumnRef[];
      from: TableRef[];
      where: Predicate[];
      limit?: number;
    };

export type { JsonValue, Predicate, Row };
