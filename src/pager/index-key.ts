import type { JsonValue } from '../value';

/** A bound on an index entry `(key, rowid)`. Row ids start at 1. */
export interface Bound {
  key: Buffer;
  rowid: number;
  inclusive: boolean;
}

const MAX_ROWID = 0xffffffff;

const TAG_NULL = 0x01;
const TAG_FALSE = 0x02;
const TAG_TRUE = 0x03;
const TAG_NUMBER = 0x04;
const TAG_STRING = 0x05;

export function isNumberKey(key: Buffer): boolean {
  return key[0] === TAG_NUMBER;
}

/**
 * Orderable bytes for one indexed value.
 * Numbers and numeric strings share a key, including `"-0"` and `"1.0"`,
 * so a lookup can return extra rows. Callers recheck the real predicate.
 * Objects and arrays are omitted: a stored value is a fresh decode, so
 * `===` never matches them.
 * Returns null when the value cannot be indexed.
 */
export function encodeIndexKey(value: JsonValue | undefined): Buffer | null {
  if (value === undefined) return null;
  if (value === null) return Buffer.from([TAG_NULL]);
  if (value === false) return Buffer.from([TAG_FALSE]);
  if (value === true) return Buffer.from([TAG_TRUE]);
  if (typeof value === 'number') {
    const finite = finiteNumber(value);
    return finite === null ? null : encodeNumber(finite);
  }
  if (typeof value === 'string') {
    const finite = finiteNumber(value);
    if (finite !== null) return encodeNumber(finite);
    const bytes = Buffer.from(value, 'utf8');
    const out = Buffer.alloc(1 + bytes.length);
    out[0] = TAG_STRING;
    bytes.copy(out, 1);
    return out;
  }
  return null;
}

/** First entry of `key`, before every real row id stored under it. */
export function pointLow(key: Buffer): Bound {
  return { key, rowid: 0, inclusive: true };
}

/** Last entry of `key`, after every real row id stored under it. */
export function pointHigh(key: Buffer): Bound {
  return { key, rowid: MAX_ROWID, inclusive: true };
}

/** Lower bound of a numeric comparison. `inclusive` is `>=`, otherwise `>`. */
export function rangeLow(value: number, inclusive: boolean): Bound {
  const key = encodeNumber(value === 0 ? 0 : value);
  if (inclusive) return { key, rowid: 0, inclusive: true };
  return { key, rowid: MAX_ROWID, inclusive: false };
}

/** Upper bound of a numeric comparison. `inclusive` is `<=`, otherwise `<`. */
export function rangeHigh(value: number, inclusive: boolean): Bound {
  const key = encodeNumber(value === 0 ? 0 : value);
  if (inclusive) return { key, rowid: MAX_ROWID, inclusive: true };
  return { key, rowid: 0, inclusive: false };
}

/**
 * Finite number, with `-0` folded to `0`.
 * Same acceptance as loose equality: a numeric string uses `Number`, so
 * `"1"` and `"1.0"` are one key. Callers still recheck.
 */
function finiteNumber(value: JsonValue): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed === 0 ? 0 : parsed;
}

/**
 * IEEE-754 big-endian, rearranged so byte order matches numeric order.
 * Negatives are inverted; positives flip the sign bit. `-0` is not passed in.
 */
function encodeNumber(value: number): Buffer {
  const out = Buffer.alloc(9);
  out[0] = TAG_NUMBER;
  const raw = Buffer.alloc(8);
  raw.writeDoubleBE(value, 0);
  if (raw[0] & 0x80) {
    for (let i = 0; i < 8; i += 1) raw[i] ^= 0xff;
  } else {
    raw[0] |= 0x80;
  }
  raw.copy(out, 1);
  return out;
}
