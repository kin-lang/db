import { KinDbError } from '../errors';
import { encodeIndexKey, type Bound } from '../pager/index-key';
import type { AggregateRef, ColumnRef, OrderKey, SelectItem, TableRef } from '../parser/ast';
import {
  assertLimit,
  cloneJson,
  looseBucket,
  looseEqual,
  compare,
  orderValues,
  type JsonValue,
  type Predicate,
  type Row,
} from '../value';
import { planRead } from './planner';

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
  /** Columns that have a simple index, in creation order. */
  indexed: string[];
  /** Walk rows in table order. Return false from `visit` to stop. */
  forEach(visit: (row: Row) => boolean): void;
  /** Rows whose indexed value encodes to `key`, in row id order. */
  probe(column: string, key: Buffer, visit: (row: Row) => boolean): void;
  /** Rows in index order, not row id order. */
  range(
    column: string,
    low: Bound | null,
    high: Bound | null,
    visit: (row: Row, rowid: number) => boolean,
  ): void;
  /**
   * Rows in stored order. `limit` lets a wide read stop.
   * `visit` returns false to stop.
   */
  read(
    predicates: Predicate[],
    limit: number | undefined,
    visit: (row: Row, rowid: number) => boolean,
  ): void;
  /**
   * Rows in `tondeka` order when the indexed column is a number or a boolean.
   * Returns false when the caller should filter and sort instead.
   * `visit` returns false to stop.
   */
  readOrdered?(
    predicates: Predicate[],
    column: string,
    direction: 'asc' | 'desc',
    limit: number,
    visit: (row: Row) => boolean,
  ): boolean;
}

/**
 * Run a select as relational operators only:
 * selection on each input, theta-join for `huza`, then selection of whatever
 * predicate still crosses the result, then projection and limit.
 * A point or a bounded range uses an index when one exists. The smaller
 * index wins when two columns are both indexed. An equality join probes
 * the inner index when that side has one. When only the outer table has
 * the index, a limit walks the inner table and probes the outer index.
 * `tondeka` with `imipaka` on an indexed number or boolean reads only
 * enough rows to fill the limit.
 */
export function evaluateSelect(
  inputs: InputRelation[],
  where: Predicate[],
  columns: '*' | SelectItem[],
  limit?: number,
  group?: ColumnRef[],
  order?: OrderKey[],
): Row[] {
  if (inputs.length === 0) return [];
  assertLimit(limit);
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
  assertKnownColumns(inputs, mentionedColumns(where, columns, group, order));
  if (limit === 0) return [];
  const shaping = needsShape(columns, group, order);
  if (inputs.length === 1 && !shaping) {
    const rows: Row[] = [];
    streamBase(inputs[0], where, limit, (scope) => {
      rows.push(projectScope(scope, columns));
      return limit === undefined || rows.length < limit;
    });
    return rows;
  }
  if (inputs.length === 1 && shaping && limit !== undefined) {
    const ordered = takeOrdered(inputs[0], where, columns, order, group, limit);
    if (ordered) return ordered;
  }
  if (inputs.length === 1) {
    const scopes: Scope[] = [];
    streamBase(inputs[0], where, undefined, (scope) => {
      scopes.push(scope);
      return true;
    });
    return finishScopes(scopes, columns, group, order, limit);
  }

  const pending = [...where];
  const residual = take(pending, (predicate) => !attached(predicate, inputs));
  const scopes: Scope[] = [];
  const stoppable = !shaping && limit !== undefined;
  produce(inputs, pending, residual, inputs.length - 1, shaping ? undefined : limit, stoppable, (scope) => {
    scopes.push(scope);
    return shaping || limit === undefined || scopes.length < limit;
  });
  if (!shaping) return project(scopes, columns);
  return finishScopes(scopes, columns, group, order, limit);
}

/** σ — keep tuples that match every predicate. */
export function selection(scopes: Scope[], predicates: Predicate[]): Scope[] {
  return scopes.filter((scope) => predicates.every((predicate) => holds(scope, predicate)));
}

/** ⋈ — inner join. Predicates that mention both sides are the theta condition. */
export function join(left: Scope[], right: Scope[], predicates: Predicate[]): Scope[] {
  return produceJoin(left, right, predicates, [], undefined);
}

export function project(scopes: Scope[], columns: '*' | SelectItem[]): Row[] {
  return scopes.map((scope) => projectScope(scope, columns));
}

function streamBase(
  input: InputRelation,
  predicates: Predicate[],
  limit: number | undefined,
  onScope: (scope: Scope) => boolean,
): void {
  const name = qualifierOf(input);
  input.read(predicates, limit, (row) => {
    const scope: Scope = { row, sources: { [name]: row }, primary: name };
    if (!predicates.every((predicate) => holds(scope, predicate))) return true;
    return onScope(scope);
  });
}

function produce(
  inputs: InputRelation[],
  pending: Predicate[],
  residual: Predicate[],
  end: number,
  limit: number | undefined,
  stoppable: boolean,
  onScope: (scope: Scope) => boolean,
): void {
  if (end === 0) {
    streamBase(inputs[0], take(pending, (predicate) => covers(predicate, inputs[0])), undefined, onScope);
    return;
  }
  const right = inputs[end];
  const leftInputs = inputs.slice(0, end);
  const rightPreds = take(pending, (predicate) => covers(predicate, right));
  const joinOn = take(pending, (predicate) => crosses(predicate, leftInputs, right));
  const link = indexLink(joinOn, leftInputs, right);
  const leftPoint =
    leftInputs.length === 1 &&
    planRead(
      pending.filter((predicate) => covers(predicate, leftInputs[0])),
      leftInputs[0].indexed,
      qualifierOf(leftInputs[0]),
    ).kind === 'point';
  const extras = end === inputs.length - 1 ? residual : [];
  if (link && (stoppable || leftPoint)) {
    produce(inputs, pending, residual, end - 1, undefined, true, (leftScope) =>
      probeRight(leftScope, right, rightPreds, joinOn, link, extras, onScope),
    );
    return;
  }
  // The index is on the original left table. Walk the right table in stored
  // order and probe that index, so `imipaka 1` does not read both tables.
  // The merged row still names the original left table as the primary.
  if (stoppable && leftInputs.length === 1) {
    const swapped = indexLink(joinOn, [right], leftInputs[0]);
    if (swapped) {
      const leftPreds = take(pending, (predicate) => covers(predicate, leftInputs[0]));
      streamBase(right, rightPreds, undefined, (outerScope) =>
        probeFromOuter(outerScope, leftInputs[0], leftPreds, joinOn, swapped, extras, onScope),
      );
      return;
    }
  }
  const leftScopes: Scope[] = [];
  produce(inputs, pending, residual, end - 1, undefined, false, (scope) => {
    leftScopes.push(scope);
    return true;
  });
  const rightScopes: Scope[] = [];
  streamBase(right, rightPreds, undefined, (scope) => {
    rightScopes.push(scope);
    return true;
  });
  const joined = produceJoin(
    leftScopes,
    rightScopes,
    joinOn,
    extras,
    end === inputs.length - 1 ? limit : undefined,
  );
  for (const scope of joined) {
    if (!onScope(scope)) return;
  }
}

function probeRight(
  leftScope: Scope,
  right: InputRelation,
  rightPreds: Predicate[],
  joinOn: Predicate[],
  link: EquiLink,
  residual: Predicate[],
  onScope: (scope: Scope) => boolean,
): boolean {
  const raw = readColumn(leftScope, link.leftQualifier, link.leftField);
  if (raw === undefined || raw === null || typeof raw === 'object') return true;
  const key = encodeIndexKey(raw);
  if (!key) return true;
  const name = qualifierOf(right);
  let keep = true;
  right.probe(link.rightField, key, (row) => {
    const rightScope: Scope = { row, sources: { [name]: row }, primary: name };
    if (!rightPreds.every((predicate) => holds(rightScope, predicate))) return true;
    const sources = { ...leftScope.sources, ...rightScope.sources };
    const preview: Scope = { row: leftScope.row, sources, primary: leftScope.primary };
    if (!joinOn.every((predicate) => holds(preview, predicate))) return true;
    if (!residual.every((predicate) => holds(preview, predicate))) return true;
    keep = onScope({
      row: mergeRows(leftScope.row, row, leftScope.primary, name),
      sources,
      primary: leftScope.primary,
    });
    return keep;
  });
  return keep;
}

function probeFromOuter(
  outerScope: Scope,
  inner: InputRelation,
  innerPreds: Predicate[],
  joinOn: Predicate[],
  link: EquiLink,
  residual: Predicate[],
  onScope: (scope: Scope) => boolean,
): boolean {
  const raw = readColumn(outerScope, link.leftQualifier, link.leftField);
  if (raw === undefined || raw === null || typeof raw === 'object') return true;
  const key = encodeIndexKey(raw);
  if (!key) return true;
  const innerName = qualifierOf(inner);
  const outerName = outerScope.primary;
  let keep = true;
  inner.probe(link.rightField, key, (row) => {
    const innerScope: Scope = { row, sources: { [innerName]: row }, primary: innerName };
    if (!innerPreds.every((predicate) => holds(innerScope, predicate))) return true;
    const sources = { ...innerScope.sources, ...outerScope.sources };
    const preview: Scope = { row, sources, primary: innerName };
    if (!joinOn.every((predicate) => holds(preview, predicate))) return true;
    if (!residual.every((predicate) => holds(preview, predicate))) return true;
    keep = onScope({
      row: mergeRows(row, outerScope.row, innerName, outerName),
      sources,
      primary: innerName,
    });
    return keep;
  });
  return keep;
}

function takeOrdered(
  input: InputRelation,
  where: Predicate[],
  columns: '*' | SelectItem[],
  order: OrderKey[] | undefined,
  group: ColumnRef[] | undefined,
  limit: number,
): Row[] | null {
  if (group && group.length > 0) return null;
  if (columns !== '*' && columns.some(isAggregate)) return null;
  if (!order || order.length !== 1 || !input.readOrdered) return null;
  const key = order[0];
  if (isAggregate(key.item)) return null;
  const name = qualifierOf(input);
  if (key.item.qualifier && key.item.qualifier !== name) return null;
  if (!input.indexed.includes(key.item.name)) return null;
  const rows: Row[] = [];
  const handled = input.readOrdered(where, key.item.name, key.direction, limit, (row) => {
    const scope: Scope = { row, sources: { [name]: row }, primary: name };
    if (!where.every((predicate) => holds(scope, predicate))) return true;
    rows.push(projectScope(scope, columns));
    return rows.length < limit;
  });
  if (!handled) return null;
  return rows;
}

function indexLink(
  predicates: Predicate[],
  left: InputRelation[],
  right: InputRelation,
): EquiLink | null {
  if (right.indexed.length === 0) return null;
  const leftNames = new Set(left.map(qualifierOf));
  const rightNames = new Set([qualifierOf(right)]);
  const leftFields = new Set(left.flatMap((input) => input.columns));
  const rightFields = new Set(right.columns);
  for (const predicate of predicates) {
    const link = asEqui(predicate, leftNames, rightNames, leftFields, rightFields);
    if (link && right.indexed.includes(link.rightField)) return link;
  }
  return null;
}

function attached(predicate: Predicate, inputs: InputRelation[]): boolean {
  if (inputs.some((input) => covers(predicate, input))) return true;
  for (let index = 1; index < inputs.length; index += 1) {
    if (crosses(predicate, inputs.slice(0, index), inputs[index])) return true;
  }
  return false;
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
    const part = link.op === 'eq' ? strictPart(value) : looseBucket(value);
    if (part === null) return null;
    key += `${part}\0`;
  }
  return key;
}

function holdsEqui(scope: Scope, link: EquiLink): boolean {
  const left = readColumn(scope, link.leftQualifier, link.leftField);
  const right = readColumn(scope, link.rightQualifier, link.rightField);
  if (left === undefined || left === null || right === undefined || right === null) return false;
  if (link.op === 'loose') return looseEqual(left, right);
  return left === right;
}

function strictPart(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return `n:${value === 0 ? 0 : value}`;
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0';
  return null;
}

function projectScope(scope: Scope, columns: '*' | SelectItem[]): Row {
  if (columns === '*') return cloneJson(scope.row);
  const plain = columns.filter((column): column is ColumnRef => !isAggregate(column));
  if (plain.length !== columns.length) {
    throw new KinDbError(
      'E_TYPE',
      'BARA, TERANYA, NTO, and NINI count rows for a group. Example: hitamo ishuri, bara(*) muri abanyeshuri koranya ishuri',
    );
  }
  const names = plain.map((column) => column.name);
  const duplicated = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  const row: Row = {};
  for (const column of plain) {
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
    // A missing value or `ubusa` does not equal another column, including another `ubusa`.
    if (left === undefined || left === null || right === undefined || right === null) return false;
    if (predicate.op === 'loose') return looseEqual(left, right);
    if (predicate.op === 'eq') return left === right;
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

function needsShape(columns: '*' | SelectItem[], group?: ColumnRef[], order?: OrderKey[]): boolean {
  if (group && group.length > 0) return true;
  if (order && order.length > 0) return true;
  return columns !== '*' && columns.some(isAggregate);
}

function isAggregate(item: SelectItem | AggregateRef | ColumnRef): item is AggregateRef {
  return 'kind' in item && item.kind === 'aggregate';
}

function mentionedColumns(
  where: Predicate[],
  columns: '*' | SelectItem[],
  group: ColumnRef[] | undefined,
  order: OrderKey[] | undefined,
): { qualifier?: string; field: string }[] {
  const mentioned: { qualifier?: string; field: string }[] = [];
  for (const predicate of where) mentioned.push(...referenced(predicate));
  if (columns !== '*') {
    for (const item of columns) {
      if (isAggregate(item)) {
        if (item.column !== '*') {
          mentioned.push({ qualifier: item.column.qualifier, field: item.column.name });
        }
        continue;
      }
      mentioned.push({ qualifier: item.qualifier, field: item.name });
    }
  }
  for (const key of group ?? []) mentioned.push({ qualifier: key.qualifier, field: key.name });
  for (const key of order ?? []) {
    if (isAggregate(key.item)) {
      if (key.item.column !== '*') {
        mentioned.push({ qualifier: key.item.column.qualifier, field: key.item.column.name });
      }
    } else {
      mentioned.push({ qualifier: key.item.qualifier, field: key.item.name });
    }
  }
  return mentioned;
}

function assertKnownColumns(
  inputs: InputRelation[],
  columns: { qualifier?: string; field: string }[],
): void {
  for (const column of columns) {
    if (column.qualifier) {
      const owner = inputs.find((input) => qualifierOf(input) === column.qualifier);
      if (!owner) throw new KinDbError('E_TYPE', `Unknown table '${column.qualifier}'`);
      if (!owner.columns.includes(column.field)) throw unknownColumn(column.field, owner.columns, qualifierOf(owner));
      continue;
    }
    const declared = inputs.filter((input) => input.columns.length > 0);
    if (declared.length === 0) throw unknownColumn(column.field, []);
    const owners = declared.filter((input) => input.columns.includes(column.field));
    if (owners.length === 1) continue;
    if (owners.length > 1) throw new KinDbError('E_TYPE', `Column '${column.field}' is ambiguous`);
    const known = [...new Set(declared.flatMap((input) => input.columns))];
    throw unknownColumn(column.field, known);
  }
}

function unknownColumn(field: string, columns: string[], table?: string): KinDbError {
  const where = table ? ` on '${table}'` : '';
  const list = columns.length > 0 ? columns.join(', ') : 'none yet';
  const hint =
    columns.length === 0
      ? ` Declare it with kora itsinda, or insert a row that includes ${field}.`
      : '';
  return new KinDbError('E_TYPE', `Column '${field}' was not found${where}. Columns: ${list}.${hint}`);
}

function finishScopes(
  scopes: Scope[],
  columns: '*' | SelectItem[],
  group: ColumnRef[] | undefined,
  order: OrderKey[] | undefined,
  limit: number | undefined,
): Row[] {
  const grouped = columns !== '*' && (columns.some(isAggregate) || Boolean(group && group.length > 0));
  if (columns === '*' && group && group.length > 0) {
    throw new KinDbError(
      'E_TYPE',
      'KORANYA needs named columns. Example: hitamo ishuri, bara(*) muri abanyeshuri koranya ishuri',
    );
  }
  const rows = grouped
    ? buildGroups(scopes, columns as SelectItem[], group ?? [])
    : project(order && order.length ? sortScopes(scopes, order) : scopes, columns);
  const ordered = grouped && order && order.length ? sortRows(rows, order) : rows;
  return limit !== undefined ? ordered.slice(0, limit) : ordered;
}

function sortScopes(scopes: Scope[], order: OrderKey[]): Scope[] {
  for (const key of order) {
    if (isAggregate(key.item)) {
      throw new KinDbError(
        'E_TYPE',
        'TONDEKA can sort BARA, TERANYA, NTO, or NINI after KORANYA. Example: hitamo ishuri, bara(*) muri abanyeshuri koranya ishuri tondeka bara(*) manuka',
      );
    }
  }
  return [...scopes].sort((left, right) => {
    for (const key of order) {
      if (isAggregate(key.item)) continue;
      const cmp = directed(
        readColumn(left, key.item.qualifier, key.item.name),
        readColumn(right, key.item.qualifier, key.item.name),
        key.direction,
      );
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function sortRows(rows: Row[], order: OrderKey[]): Row[] {
  return [...rows].sort((left, right) => {
    for (const key of order) {
      const name = isAggregate(key.item) ? aggregateName(key.item) : key.item.name;
      const cmp = directed(left[name], right[name], key.direction);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function directed(left: JsonValue | undefined, right: JsonValue | undefined, direction: 'asc' | 'desc'): number {
  const cmp = orderValues(left, right);
  if (cmp === 0) return 0;
  const leftMissing = left === undefined || left === null;
  const rightMissing = right === undefined || right === null;
  if (leftMissing || rightMissing) return cmp;
  return direction === 'desc' ? -cmp : cmp;
}

function buildGroups(scopes: Scope[], columns: SelectItem[], group: ColumnRef[]): Row[] {
  const plain = columns.filter((item): item is ColumnRef => !isAggregate(item));
  for (const column of plain) {
    const listed = group.some((key) => key.name === column.name && key.qualifier === column.qualifier);
    if (!listed) {
      const label = column.qualifier ? `${column.qualifier}.${column.name}` : column.name;
      throw new KinDbError(
        'E_TYPE',
        `Column '${label}' is not in KORANYA. Add it to KORANYA, or wrap it in BARA, TERANYA, NTO, or NINI.`,
      );
    }
  }
  if (scopes.length === 0) {
    if (group.length === 0 && columns.some(isAggregate)) return [bucketRow(columns, [])];
    return [];
  }
  const buckets = new Map<string, Scope[]>();
  const order: string[] = [];
  for (const scope of scopes) {
    const id =
      group.length === 0
        ? ''
        : group
            .map((key) => JSON.stringify(readColumn(scope, key.qualifier, key.name) ?? null))
            .join('\0');
    const list = buckets.get(id);
    if (list) list.push(scope);
    else {
      buckets.set(id, [scope]);
      order.push(id);
    }
  }
  return order.map((id) => bucketRow(columns, buckets.get(id) ?? []));
}

function bucketRow(columns: SelectItem[], rows: Scope[]): Row {
  const row: Row = {};
  const used = new Set<string>();
  for (const item of columns) {
    const name = isAggregate(item) ? aggregateName(item) : item.name;
    if (used.has(name)) {
      throw new KinDbError(
        'E_TYPE',
        `The result column '${name}' is used twice. Remove one, or group by different columns.`,
      );
    }
    used.add(name);
    row[name] = isAggregate(item) ? aggregateValue(item, rows) : groupedValue(item, rows);
  }
  return row;
}

function groupedValue(column: ColumnRef, rows: Scope[]): JsonValue {
  if (rows.length === 0) return null;
  const value = readColumn(rows[0], column.qualifier, column.name);
  return value === undefined ? null : cloneJson(value);
}

function aggregateName(item: AggregateRef): string {
  if (item.column === '*') return 'bara';
  const prefix =
    item.fn === 'count' ? 'bara' : item.fn === 'sum' ? 'teranya' : item.fn === 'min' ? 'nto' : 'nini';
  return `${prefix}_${item.column.name}`;
}

function aggregateValue(item: AggregateRef, rows: Scope[]): JsonValue {
  if (item.fn === 'count' && item.column === '*') return rows.length;
  const column = item.column === '*' ? null : item.column;
  if (!column) return rows.length;
  if (item.fn === 'count') {
    let count = 0;
    for (const scope of rows) {
      const value = readColumn(scope, column.qualifier, column.name);
      if (value !== null && value !== undefined) count += 1;
    }
    return count;
  }
  let chosen: JsonValue | undefined;
  let seen = false;
  for (const scope of rows) {
    const value = readColumn(scope, column.qualifier, column.name);
    if (value === null || value === undefined) continue;
    if (item.fn === 'sum') {
      if (typeof value !== 'number') {
        throw new KinDbError(
          'E_TYPE',
          `TERANYA needs numbers. Column '${column.name}' has a different value.`,
        );
      }
      chosen = ((chosen as number) ?? 0) + value;
      seen = true;
      continue;
    }
    if (typeof value === 'object') {
      throw new KinDbError(
        'E_TYPE',
        `NTO and NINI compare single values. Column '${column.name}' has an object.`,
      );
    }
    if (!seen) {
      chosen = value;
      seen = true;
      continue;
    }
    const cmp = orderValues(value, chosen);
    if (item.fn === 'min' && cmp < 0) chosen = value;
    if (item.fn === 'max' && cmp > 0) chosen = value;
  }
  return seen ? (chosen ?? null) : null;
}
