import { KinDbError } from '../errors';
import type { ColumnRef, TableRef } from '../parser/ast';
import { cloneJson, looseEqual, compare, type JsonValue, type Predicate, type Row } from '../value';

/**
 * One tuple in a relation. `sources` keeps each input row addressable
 * by table name or alias so selection and join can see qualified columns.
 */
export interface Scope {
  row: Row;
  sources: Record<string, Row>;
  primary: string;
}

export interface InputRelation {
  ref: TableRef;
  rows: Row[];
  columns: string[];
}

/**
 * Run a select as relational operators only:
 * selection on each input, theta-join for `huza`, then selection of whatever
 * predicate still crosses the result, then projection and limit.
 */
export function evaluateSelect(
  inputs: InputRelation[],
  where: Predicate[],
  columns: '*' | ColumnRef[],
  limit?: number,
): Row[] {
  if (inputs.length === 0) return [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const name = input.ref.alias ?? input.ref.name;
    if (seen.has(name)) {
      throw new KinDbError(
        'E_TYPE',
        `Join name '${name}' is already in use. Give the table an alias`,
      );
    }
    seen.add(name);
  }
  for (const predicate of where) {
    for (const column of referenced(predicate)) {
      if (column.qualifier) continue;
      const owners = inputs.filter((input) => input.columns.includes(column.field));
      if (owners.length > 1) {
        throw new KinDbError('E_TYPE', `Column '${column.field}' is ambiguous`);
      }
    }
  }
  const pending = [...where];
  let scopes = selection(asScopes(inputs[0]), take(pending, (predicate) => covers(predicate, inputs[0])));
  for (let index = 1; index < inputs.length; index += 1) {
    const right = inputs[index];
    const rightScopes = selection(asScopes(right), take(pending, (predicate) => covers(predicate, right)));
    const joinOn = take(pending, (predicate) => crosses(predicate, inputs.slice(0, index), right));
    scopes = join(scopes, rightScopes, joinOn);
  }
  scopes = selection(scopes, pending.splice(0));
  const projected = project(scopes, columns);
  if (limit === undefined) return projected;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new KinDbError('E_TYPE', 'Limit must be a non-negative integer');
  }
  return projected.slice(0, limit);
}

/** σ — keep tuples that match every predicate. */
export function selection(scopes: Scope[], predicates: Predicate[]): Scope[] {
  return scopes.filter((scope) => predicates.every((predicate) => holds(scope, predicate)));
}

/** ⋈ — inner join. Predicates that mention both sides are the theta condition. */
export function join(left: Scope[], right: Scope[], predicates: Predicate[]): Scope[] {
  const joined: Scope[] = [];
  for (const leftScope of left) {
    for (const rightScope of right) {
      const overlap = Object.keys(leftScope.sources).find((name) => name in rightScope.sources);
      if (overlap) {
        throw new KinDbError(
          'E_TYPE',
          `Join name '${overlap}' is already in use. Give the table an alias`,
        );
      }
      const sources = { ...leftScope.sources, ...rightScope.sources };
      const row = mergeRows(leftScope.row, rightScope.row, leftScope.primary, rightScope.primary);
      const scope: Scope = { row, sources, primary: leftScope.primary };
      if (predicates.every((predicate) => holds(scope, predicate))) joined.push(scope);
    }
  }
  return joined;
}

export function project(scopes: Scope[], columns: '*' | ColumnRef[]): Row[] {
  if (columns === '*') return scopes.map((scope) => cloneJson(scope.row));
  const names = columns.map((column) => column.name);
  const duplicated = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  return scopes.map((scope) => {
    const row: Row = {};
    for (const column of columns) {
      const key =
        column.qualifier && duplicated.has(column.name)
          ? `${column.qualifier}.${column.name}`
          : column.name;
      const value = readColumn(scope, column.qualifier, column.name);
      row[key] = value === undefined ? null : cloneJson(value);
    }
    return row;
  });
}

function asScopes(input: InputRelation): Scope[] {
  const qualifiers = input.ref.alias ? [input.ref.alias] : [input.ref.name];
  return input.rows.map((row) => ({
    row: cloneJson(row),
    sources: Object.fromEntries(qualifiers.map((qualifier) => [qualifier, row])),
    primary: input.ref.alias ?? input.ref.name,
  }));
}

function take(predicates: Predicate[], accept: (predicate: Predicate) => boolean): Predicate[] {
  const kept: Predicate[] = [];
  for (let index = predicates.length - 1; index >= 0; index -= 1) {
    if (accept(predicates[index])) kept.unshift(predicates.splice(index, 1)[0]);
  }
  return kept;
}

function covers(predicate: Predicate, input: InputRelation): boolean {
  const columns = referenced(predicate);
  return columns.length > 0 && columns.every((column) => side(column, [], input) === 'right');
}

function crosses(predicate: Predicate, left: InputRelation[], right: InputRelation): boolean {
  const sides = referenced(predicate).map((column) => side(column, left, right));
  return sides.includes('left') && sides.includes('right');
}

function side(
  column: { qualifier?: string; field: string },
  left: InputRelation[],
  right: InputRelation,
): 'left' | 'right' | 'both' | 'none' {
  if (column.qualifier) {
    const inLeft = left.some((input) => qualifierOf(input) === column.qualifier);
    const inRight = qualifierOf(right) === column.qualifier;
    if (inLeft && inRight) return 'both';
    if (inLeft) return 'left';
    if (inRight) return 'right';
    return 'none';
  }
  const inLeft = left.some((input) => input.columns.includes(column.field));
  const inRight = right.columns.includes(column.field);
  if (inLeft && inRight) return 'both';
  if (inLeft) return 'left';
  if (inRight) return 'right';
  return 'none';
}

function qualifierOf(input: InputRelation): string {
  return input.ref.alias ?? input.ref.name;
}

function referenced(predicate: Predicate): { qualifier?: string; field: string }[] {
  const columns = [{ qualifier: predicate.qualifier, field: predicate.field }];
  if (predicate.rightField) {
    columns.push({ qualifier: predicate.rightQualifier, field: predicate.rightField });
  }
  return columns;
}

function holds(scope: Scope, predicate: Predicate): boolean {
  const left = readColumn(scope, predicate.qualifier, predicate.field);
  if (predicate.rightField) {
    const right = readColumn(scope, predicate.rightQualifier, predicate.rightField);
    if (predicate.op === 'loose') return looseEqual(left, right ?? null);
    return compare(left, predicate.op, typeof right === 'number' ? right : Number.NaN);
  }
  if (predicate.op === 'loose') return looseEqual(left, predicate.value ?? null);
  return compare(left, predicate.op, typeof predicate.value === 'number' ? predicate.value : Number.NaN);
}

function readColumn(scope: Scope, qualifier: string | undefined, field: string): JsonValue | undefined {
  if (qualifier) {
    const source = scope.sources[qualifier];
    if (!source) throw new KinDbError('E_TYPE', `Unknown table '${qualifier}'`);
    return source[field];
  }
  const hits = Object.values(scope.sources).filter((source) => field in source);
  if (hits.length > 1) throw new KinDbError('E_TYPE', `Column '${field}' is ambiguous`);
  return hits.length === 1 ? hits[0][field] : undefined;
}

function mergeRows(left: Row, right: Row, leftName: string, rightName: string): Row {
  const row: Row = {};
  const rightKeys = new Set(Object.keys(right));
  for (const [key, value] of Object.entries(left)) {
    row[rightKeys.has(key) ? `${leftName}.${key}` : key] = cloneJson(value);
  }
  for (const [key, value] of Object.entries(right)) {
    row[key in left ? `${rightName}.${key}` : key] = cloneJson(value);
  }
  return row;
}
