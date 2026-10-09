import { KinDbError } from './errors';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
/** One collection record. Nested objects are stored, but WHERE compares scalars. */
export type Row = { [key: string]: JsonValue };

export type CompareOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq';

/**
 * A WHERE field.
 * A scalar uses loose equality (the number 1 matches the string "1").
 * An object is a bag of comparison operators, combined with AND.
 */
export type FieldFilter = JsonValue | Partial<Record<CompareOp | CompareAlias, number>>;
export type Where = Record<string, FieldFilter>;

/** Kinyarwanda names for the json-base comparison operators. */
export type CompareAlias =
  | 'munsi'
  | 'munsi_cyangwa'
  | 'hejuru'
  | 'hejuru_cyangwa'
  | 'ni';

export type Predicate = {
  op: 'loose' | CompareOp;
  field: string;
  qualifier?: string;
  /** Set for `column = value`. Absent when the right side is another column. */
  value?: JsonValue;
  rightField?: string;
  rightQualifier?: string;
};

const OPERATOR_ALIAS: Record<string, CompareOp> = {
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  eq: 'eq',
  munsi: 'lt',
  munsi_cyangwa: 'lte',
  hejuru: 'gt',
  hejuru_cyangwa: 'gte',
  ni: 'eq',
};

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertCollectionName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new KinDbError(
      'E_TYPE',
      `Collection name '${name}' must be a letter or underscore followed by letters, digits, or underscores`,
    );
  }
}

export function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  const copy: { [key: string]: JsonValue } = {};
  const record = value as { [key: string]: JsonValue };
  for (const key of Object.keys(record)) copy[key] = cloneJson(record[key]);
  return copy as T;
}

/**
 * Bucket for a hash join. Values that are loose-equal share a bucket.
 * A numeric string shares the bucket of its number, so callers must
 * recheck with {@link looseEqual}: `"1"` and `"1.0"` collide but are not equal.
 * Returns null when the value cannot match anything.
 */
export function looseBucket(value: JsonValue | undefined): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'b:1' : 'b:0';
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'string') {
    const parsed = numericString(value);
    if (Number.isFinite(parsed)) return `n:${parsed}`;
    return `s:${value}`;
  }
  return `j:${JSON.stringify(value)}`;
}

export function assertJson(value: unknown, path = 'value'): asserts value is JsonValue {
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new KinDbError('E_TYPE', `${path} must be a finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (kind === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJson(item, `${path}.${key}`);
    }
    return;
  }
  throw new KinDbError('E_TYPE', `${path} is not JSON data`);
}

export function assertRow(value: unknown, label = 'record'): asserts value is Row {
  assertJson(value, label);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KinDbError('E_TYPE', `A ${label} must be an object`);
  }
}

/**
 * Loose equality used by a plain WHERE value.
 * Same-type values use ===. A number and a numeric string match each other,
 * which is the useful part of json-base's `==` string coercion.
 */
export function looseEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  if (left === undefined) return false;
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'string') {
    return numericString(right) === left;
  }
  if (typeof left === 'string' && typeof right === 'number') {
    return numericString(left) === right;
  }
  return false;
}

function numericString(value: string): number {
  if (value.trim() === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function compare(left: JsonValue | undefined, op: CompareOp, right: number): boolean {
  // `eq` / `ni` follows json-base: the field must already be that number.
  if (op === 'eq') return left === right;
  // lt/lte/gt/gte follow json-base and coerce numeric strings ("5" < 10).
  const value = typeof left === 'number' ? left : typeof left === 'string' ? numericString(left) : NaN;
  if (!Number.isFinite(value)) return false;
  switch (op) {
    case 'lt':
      return value < right;
    case 'lte':
      return value <= right;
    case 'gt':
      return value > right;
    case 'gte':
      return value >= right;
  }
}

export function matches(row: Row, predicates: Predicate[]): boolean {
  for (const predicate of predicates) {
    const left = row[predicate.field];
    const right = predicate.rightField ? row[predicate.rightField] : predicate.value;
    if (predicate.op === 'loose') {
      if (!looseEqual(left, right ?? null)) return false;
    } else if (typeof right !== 'number' || !compare(left, predicate.op, right)) {
      return false;
    }
  }
  return true;
}

/** Turn a json-base style `where` object into AND predicates. */
export function whereToPredicates(where: Where): Predicate[] {
  const predicates: Predicate[] = [];
  for (const [field, filter] of Object.entries(where)) {
    if (!NAME_PATTERN.test(field)) {
      throw new KinDbError('E_TYPE', `Field name '${field}' is not a valid identifier`);
    }
    if (filter !== null && typeof filter === 'object' && !Array.isArray(filter)) {
      const entries = Object.entries(filter);
      if (entries.length === 0) {
        throw new KinDbError('E_MISSING_PARAM', `Where field '${field}' has no comparison`);
      }
      for (const [operator, raw] of entries) {
        const op = OPERATOR_ALIAS[operator];
        if (!op) {
          throw new KinDbError('E_OPERATOR', `Operator '${operator}' is not supported`);
        }
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          throw new KinDbError(
            'E_TYPE',
            `Operator '${operator}' on '${field}' expects a finite number`,
          );
        }
        predicates.push({ op, field, value: raw });
      }
      continue;
    }
    assertJson(filter, `where.${field}`);
    predicates.push({ op: 'loose', field, value: filter as JsonValue });
  }
  return predicates;
}
