import { KinDbError } from '../errors';
import type { ColumnRef, TableRef } from '../parser/ast';
import {
  cloneJson,
  looseBucket,
  looseEqual,
  compare,
  type JsonValue,
  type Predicate,
  type Row,
} from '../value';

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
  columns: string[];
  /** Walk rows in table order. Return false from `visit` to stop. */
  forEach(visit: (row: Row) => boolean): void;
}

/**
 * Run a select as relational operators only:
 * selection on each input, theta-join for `huza`, then selection of whatever
 * predicate still crosses the result, then projection and limit.
 * A limit stops the scan, or the last join, once enough rows match.
 */
export function evaluateSelect(
  inputs: InputRelation[],
  where: Predicate[],
  columns: '*' | ColumnRef[],
  limit?: number,
): Row[] {
  if (inputs.length === 0) return [];
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new KinDbError('E_TYPE', 'Limit must be a non-negative integer');
  }
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
  if (limit === 0) return [];
  if (inputs.length === 1) return selectOne(inputs[0], where, columns, limit);

  const pending = [...where];
  let scopes = collect(inputs[0], take(pending, (predicate) => covers(predicate, inputs[0])));
  for (let index = 1; index < inputs.length; index += 1) {
    const right = inputs[index];
    const rightScopes = collect(right, take(pending, (predicate) => covers(predicate, right)));
    const joinOn = take(pending, (predicate) => crosses(predicate, inputs.slice(0, index), right));
    const last = index === inputs.length - 1;
    scopes = produceJoin(scopes, rightScopes, joinOn, last ? pending.splice(0) : [], last ? limit : undefined);
  }
  return project(scopes, columns);
}

/** σ — keep tuples that match every predicate. */
export function selection(scopes: Scope[], predicates: Predicate[]): Scope[] {
  return scopes.filter((scope) => predicates.every((predicate) => holds(scope, predicate)));
}

/** ⋈ — inner join. Predicates that mention both sides are the theta condition. */
export function join(left: Scope[], right: Scope[], predicates: Predicate[]): Scope[] {
  return produceJoin(left, right, predicates, [], undefined);
}

export function project(scopes: Scope[], columns: '*' | ColumnRef[]): Row[] {
  return scopes.map((scope) => projectScope(scope, columns));
}

function selectOne(
  input: InputRelation,
  where: Predicate[],
  columns: '*' | ColumnRef[],
  limit: number | undefined,
): Row[] {
  const rows: Row[] = [];
  const name = input.ref.alias ?? input.ref.name;
  input.forEach((row) => {
    const scope: Scope = { row, sources: { [name]: row }, primary: name };
    if (!where.every((predicate) => holds(scope, predicate))) return true;
    rows.push(projectScope(scope, columns));
    return limit === undefined || rows.length < limit;
  });
  return rows;
}

function collect(input: InputRelation, predicates: Predicate[]): Scope[] {
  const name = input.ref.alias ?? input.ref.name;
  const scopes: Scope[] = [];
  input.forEach((row) => {
    const scope: Scope = { row, sources: { [name]: row }, primary: name };
    if (predicates.every((predicate) => holds(scope, predicate))) scopes.push(scope);
    return true;
  });
  return scopes;
}

interface EquiLink {
  op: 'loose' | 'eq';
  leftQualifier?: string;
  leftField: string;
  rightQualifier?: string;
  rightField: string;
}

function produceJoin(
  left: Scope[],
  right: Scope[],
  predicates: Predicate[],
  residual: Predicate[],
  limit: number | undefined,
): Scope[] {
  if (left.length === 0 || right.length === 0) return [];
  const leftNames = new Set(Object.keys(left[0].sources));
  const rightNames = new Set(Object.keys(right[0].sources));
  for (const name of rightNames) {
    if (leftNames.has(name)) {
      throw new KinDbError(
        'E_TYPE',
        `Join name '${name}' is already in use. Give the table an alias`,
      );
    }
  }
  const joined: Scope[] = [];
  const accept = (scope: Scope): boolean => {
    if (!residual.every((predicate) => holds(scope, predicate))) return true;
    joined.push(scope);
    return limit === undefined || joined.length < limit;
  };
  const equi: EquiLink[] = [];
  const rest: Predicate[] = [];
  const leftFields = fieldsOf(left, leftNames);
  const rightFields = fieldsOf(right, rightNames);
  for (const predicate of predicates) {
    const link = asEqui(predicate, leftNames, rightNames, leftFields, rightFields);
    if (link) equi.push(link);
    else rest.push(predicate);
  }
  if (equi.length > 0) hashJoin(left, right, equi, rest, accept);
  else nestedJoin(left, right, predicates, accept);
  return joined;
}

function hashJoin(
  left: Scope[],
  right: Scope[],
  equi: EquiLink[],
  rest: Predicate[],
  accept: (scope: Scope) => boolean,
): void {
  const buckets = new Map<string, Scope[]>();
  for (const rightScope of right) {
    const key = equiKey(rightScope, equi, 'right');
    if (key === null) continue;
    const list = buckets.get(key);
    if (list) list.push(rightScope);
    else buckets.set(key, [rightScope]);
  }
  for (const leftScope of left) {
    const key = equiKey(leftScope, equi, 'left');
    if (key === null) continue;
    const hits = buckets.get(key);
    if (!hits) continue;
    for (const rightScope of hits) {
      const sources = { ...leftScope.sources, ...rightScope.sources };
      const preview: Scope = { row: leftScope.row, sources, primary: leftScope.primary };
      if (!equi.every((link) => holdsEqui(preview, link))) continue;
      if (!rest.every((predicate) => holds(preview, predicate))) continue;
      const row = mergeRows(leftScope.row, rightScope.row, leftScope.primary, rightScope.primary);
      if (!accept({ row, sources, primary: leftScope.primary })) return;
    }
  }
}

function nestedJoin(
  left: Scope[],
  right: Scope[],
  predicates: Predicate[],
  accept: (scope: Scope) => boolean,
): void {
  for (const leftScope of left) {
    for (const rightScope of right) {
      const sources = { ...leftScope.sources, ...rightScope.sources };
      const preview: Scope = { row: leftScope.row, sources, primary: leftScope.primary };
      if (!predicates.every((predicate) => holds(preview, predicate))) continue;
      const row = mergeRows(leftScope.row, rightScope.row, leftScope.primary, rightScope.primary);
      if (!accept({ row, sources, primary: leftScope.primary })) return;
    }
  }
}

function asEqui(
  predicate: Predicate,
  leftNames: Set<string>,
  rightNames: Set<string>,
  leftFields: Set<string>,
  rightFields: Set<string>,
): EquiLink | null {
  if (!predicate.rightField) return null;
  if (predicate.op !== 'loose' && predicate.op !== 'eq') return null;
  const leftSide = locate(
    predicate.qualifier,
    predicate.field,
    leftNames,
    rightNames,
    leftFields,
    rightFields,
  );
  const rightSide = locate(
    predicate.rightQualifier,
    predicate.rightField,
    leftNames,
    rightNames,
    leftFields,
    rightFields,
  );
  if (!leftSide || !rightSide || leftSide === rightSide) return null;
  if (leftSide === 'left') {
    return {
      op: predicate.op,
      leftQualifier: predicate.qualifier,
      leftField: predicate.field,
      rightQualifier: predicate.rightQualifier,
      rightField: predicate.rightField,
    };
  }
  return {
    op: predicate.op,
    leftQualifier: predicate.rightQualifier,
    leftField: predicate.rightField,
    rightQualifier: predicate.qualifier,
    rightField: predicate.field,
  };
}

function locate(
  qualifier: string | undefined,
  field: string,
  leftNames: Set<string>,
  rightNames: Set<string>,
  leftFields: Set<string>,
  rightFields: Set<string>,
): 'left' | 'right' | null {
  if (qualifier) {
    if (leftNames.has(qualifier)) return 'left';
    if (rightNames.has(qualifier)) return 'right';
    return null;
  }
  const inLeft = leftFields.has(field);
  const inRight = rightFields.has(field);
  if (inLeft && !inRight) return 'left';
  if (inRight && !inLeft) return 'right';
  return null;
}

function fieldsOf(scopes: Scope[], names: Set<string>): Set<string> {
  const fields = new Set<string>();
  for (const scope of scopes) {
    for (const name of names) {
      const row = scope.sources[name];
      if (!row) continue;
      for (const key of Object.keys(row)) fields.add(key);
    }
  }
  return fields;
}

function equiKey(scope: Scope, links: EquiLink[], side: 'left' | 'right'): string | null {
  let key = '';
  for (const link of links) {
    const value = readColumn(
      scope,
      side === 'left' ? link.leftQualifier : link.rightQualifier,
      side === 'left' ? link.leftField : link.rightField,
    );
    const part = link.op === 'eq' ? (typeof value === 'number' ? `e:${value}` : null) : looseBucket(value);
    if (part === null) return null;
    key += `${part}\0`;
  }
  return key;
}

function holdsEqui(scope: Scope, link: EquiLink): boolean {
  const left = readColumn(scope, link.leftQualifier, link.leftField);
  const right = readColumn(scope, link.rightQualifier, link.rightField);
  if (link.op === 'loose') return looseEqual(left, right ?? null);
  return typeof left === 'number' && left === right;
}

function projectScope(scope: Scope, columns: '*' | ColumnRef[]): Row {
  if (columns === '*') return cloneJson(scope.row);
  const names = columns.map((column) => column.name);
  const duplicated = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  const row: Row = {};
  for (const column of columns) {
    const key =
      column.qualifier && duplicated.has(column.name) ? `${column.qualifier}.${column.name}` : column.name;
    const value = readColumn(scope, column.qualifier, column.name);
    row[key] = value === undefined ? null : cloneJson(value);
  }
  return row;
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
