import {
  encodeIndexKey,
  isNumberKey,
  rangeHigh,
  rangeLow,
  type Bound,
} from '../pager/index-key';
import type { JsonValue, Predicate } from '../value';

/**
 * How to reach the rows of one table.
 * A point lookup is one indexed value. A range is a numeric slice.
 * `bothSides` means the slice has a lower and an upper bound, which is the
 * selective case. An open range (`id > 5` alone) often matches most of the
 * table, so a read keeps walking the table in stored order and can stop at
 * a limit. An update or a delete still uses the open range, because it has
 * to visit every match and can skip keys outside it.
 */
export type Access =
  | { kind: 'empty' }
  | { kind: 'scan' }
  | { kind: 'point'; column: string; key: Buffer }
  | { kind: 'range'; column: string; low: Bound | null; high: Bound | null; bothSides: boolean };

interface ColumnConstraint {
  unsat: boolean;
  point: Buffer | null;
  /** Set when `point` is the number encoding, so it can be clipped by `<` / `>`. */
  pointValue: number | null;
  low?: { value: number; inclusive: boolean };
  high?: { value: number; inclusive: boolean };
}

/**
 * Pick an index for these AND predicates.
 * `qualifier` is the table name or alias. A predicate qualified with another
 * name is ignored. Contradictions (`id = 1 kandi id = 2`) are `empty` even
 * when that column has no index. Equality wins over a range.
 */
export function planAccess(
  predicates: Predicate[],
  indexed: readonly string[],
  qualifier: string,
): Access {
  let best: Access = { kind: 'scan' };
  for (const column of constantColumns(predicates, qualifier)) {
    const constraint = constrain(predicates, column, qualifier);
    if (constraint.unsat) return { kind: 'empty' };
    if (!indexed.includes(column)) continue;
    const access = toAccess(column, constraint);
    if (access && rank(access) > rank(best)) best = access;
  }
  return best;
}

/** A read uses a point or a bounded range. An open range stays a table walk. */
export function planRead(
  predicates: Predicate[],
  indexed: readonly string[],
  qualifier: string,
): Access {
  const access = planAccess(predicates, indexed, qualifier);
  if (access.kind === 'range' && !access.bothSides) return { kind: 'scan' };
  return access;
}

function constantColumns(predicates: Predicate[], qualifier: string): string[] {
  const names: string[] = [];
  for (const predicate of predicates) {
    if (!forTable(predicate, qualifier) || predicate.rightField) continue;
    if (predicate.value === undefined) continue;
    if (!names.includes(predicate.field)) names.push(predicate.field);
  }
  return names;
}

function constrain(predicates: Predicate[], column: string, qualifier: string): ColumnConstraint {
  const result: ColumnConstraint = { unsat: false, point: null, pointValue: null };
  for (const predicate of predicates) {
    if (predicate.field !== column || !forTable(predicate, qualifier) || predicate.rightField) {
      continue;
    }
    if (predicate.value === undefined) continue;
    if (predicate.op === 'loose') {
      if (!samePoint(result, predicate.value)) return result;
      continue;
    }
    if (typeof predicate.value !== 'number' || !Number.isFinite(predicate.value)) {
      result.unsat = true;
      return result;
    }
    if (predicate.op === 'eq') {
      if (!samePoint(result, predicate.value)) return result;
      continue;
    }
    tighten(result, predicate.op, predicate.value);
    if (rangeUnsat(result)) {
      result.unsat = true;
      return result;
    }
  }
  if (result.point && result.pointValue === null && (result.low || result.high)) {
    // A string, boolean, or null cannot also be `<` or `>` a number.
    result.unsat = true;
    return result;
  }
  if (result.pointValue !== null && !fits(result.pointValue, result)) {
    result.unsat = true;
    return result;
  }
  if (rangeUnsat(result)) result.unsat = true;
  return result;
}

function samePoint(result: ColumnConstraint, value: JsonValue): boolean {
  const key = encodeIndexKey(value);
  if (!key) {
    result.unsat = true;
    return false;
  }
  if (result.point && !result.point.equals(key)) {
    result.unsat = true;
    return false;
  }
  result.point = key;
  if (isNumberKey(key)) {
    const numeric = typeof value === 'number' ? value : Number(value);
    result.pointValue = numeric === 0 ? 0 : numeric;
  }
  return true;
}

function tighten(result: ColumnConstraint, op: 'lt' | 'lte' | 'gt' | 'gte', value: number): void {
  if (op === 'gt' || op === 'gte') {
    const inclusive = op === 'gte';
    if (
      !result.low ||
      value > result.low.value ||
      (value === result.low.value && !inclusive && result.low.inclusive)
    ) {
      result.low = { value, inclusive };
    }
    return;
  }
  const inclusive = op === 'lte';
  if (
    !result.high ||
    value < result.high.value ||
    (value === result.high.value && !inclusive && result.high.inclusive)
  ) {
    result.high = { value, inclusive };
  }
}

function fits(value: number, result: ColumnConstraint): boolean {
  if (result.low) {
    if (value < result.low.value) return false;
    if (value === result.low.value && !result.low.inclusive) return false;
  }
  if (result.high) {
    if (value > result.high.value) return false;
    if (value === result.high.value && !result.high.inclusive) return false;
  }
  return true;
}

function rangeUnsat(result: ColumnConstraint): boolean {
  if (!result.low || !result.high) return false;
  if (result.low.value > result.high.value) return true;
  if (result.low.value < result.high.value) return false;
  return !result.low.inclusive || !result.high.inclusive;
}

function toAccess(column: string, constraint: ColumnConstraint): Access | null {
  if (constraint.point) return { kind: 'point', column, key: constraint.point };
  if (!constraint.low && !constraint.high) return null;
  return {
    kind: 'range',
    column,
    low: constraint.low ? rangeLow(constraint.low.value, constraint.low.inclusive) : null,
    high: constraint.high ? rangeHigh(constraint.high.value, constraint.high.inclusive) : null,
    bothSides: Boolean(constraint.low && constraint.high),
  };
}

function forTable(predicate: Predicate, qualifier: string): boolean {
  if (predicate.qualifier !== undefined && predicate.qualifier !== qualifier) return false;
  if (predicate.rightQualifier !== undefined && predicate.rightQualifier !== qualifier) return false;
  return true;
}

function rank(access: Access): number {
  if (access.kind === 'point') return 3;
  if (access.kind === 'range' && access.bothSides) return 2;
  if (access.kind === 'range') return 1;
  return 0;
}
