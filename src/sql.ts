import { KEYWORDS } from './lexer/tokens';
import { KinDbError } from './errors';
import { assertIdentifier, assertJson, type JsonValue } from './value';

/** Values passed to `execute` and `query` for `$name` placeholders. */
export type SqlParams = Record<string, JsonValue>;

/**
 * A quoted literal that the script parser reads back as `value`.
 * Use this only when a statement must be built as text.
 * Prefer `$name` placeholders: `query('hitamo * muri t aho izina = $izina', { izina })`.
 */
export function sqlLiteral(value: JsonValue): string {
  assertJson(value, 'sqlLiteral');
  if (value === null) return 'ubusa';
  if (value === true) return 'nibyo';
  if (value === false) return 'sibyo';
  if (typeof value === 'number') return formatSqlNumber(value);
  if (typeof value === 'string') {
    return `"${value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')}"`;
  }
  throw new KinDbError(
    'E_TYPE',
    'sqlLiteral supports ubusa, nibyo, sibyo, numbers, and strings. Pass an object with $name instead of pasting it into the script.',
  );
}

/**
 * A name that can be a collection, a column, or an index.
 * SQL and `createCollection` share this check, so a name the script
 * cannot quote is rejected at creation too.
 */
export function assertSqlName(name: string, what: string): void {
  assertIdentifier(name, what);
  if (KEYWORDS[name.toLowerCase()]) {
    throw new KinDbError(
      'E_TYPE',
      `'${name}' is a KinDB word, so it cannot be a name. Choose another name, for example ${name}_1.`,
    );
  }
}

/** A collection or column name that cannot change the statement that follows it. */
export function sqlName(name: string): string {
  assertSqlName(name, 'Name');
  return name;
}

/**
 * A decimal the script lexer can read back as the same number.
 * `String(1e21)` is `1e+21`, and the lexer has no exponent.
 */
function formatSqlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new KinDbError('E_TYPE', 'sqlLiteral must be a finite number');
  }
  if (Object.is(value, -0)) return '-0';
  const text = value.toString();
  if (!/[eE]/.test(text)) return text;
  const plain = expandExponent(text);
  if (Number(plain) !== value) {
    throw new KinDbError(
      'E_TYPE',
      'sqlLiteral could not write this number. Pass it as $name beside the script.',
    );
  }
  return plain;
}

function expandExponent(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (!match) {
    throw new KinDbError(
      'E_TYPE',
      'sqlLiteral could not write this number. Pass it as $name beside the script.',
    );
  }
  const sign = match[1];
  const digits = match[2] + (match[3] ?? '');
  const point = match[2].length + Number(match[4]);
  let body: string;
  if (point <= 0) body = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) body = digits + '0'.repeat(point - digits.length);
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + body;
}
