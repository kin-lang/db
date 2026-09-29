import { KinDbError } from '../errors';
import type { JsonValue, Row } from '../value';

export type ColumnType = 'any' | 'number' | 'string' | 'boolean';

export interface ColumnDef {
  name: string;
  type: ColumnType;
}

const TYPE_NAMES: Record<string, ColumnType> = {
  umubare: 'number',
  ijambo: 'string',
  ukuri: 'boolean',
  ikintu: 'any',
};

export function columnTypeFromName(name: string): ColumnType {
  const type = TYPE_NAMES[name];
  if (!type) {
    throw new KinDbError(
      'E_TYPE',
      `Column type '${name}' is not umubare, ijambo, ukuri, or ikintu`,
    );
  }
  return type;
}

export function assertValueType(column: ColumnDef, value: JsonValue): void {
  if (value === null || column.type === 'any') return;
  if (column.type === 'number' && typeof value !== 'number') {
    throw new KinDbError('E_TYPE', `Column '${column.name}' expects a number`);
  }
  if (column.type === 'string' && typeof value !== 'string') {
    throw new KinDbError('E_TYPE', `Column '${column.name}' expects a string`);
  }
  if (column.type === 'boolean' && typeof value !== 'boolean') {
    throw new KinDbError('E_TYPE', `Column '${column.name}' expects nibyo or sibyo`);
  }
}

/** Record body: present columns only, indexed into the table's column list. */
export function encodeRecord(columns: ColumnDef[], row: Row): Buffer {
  const parts: Buffer[] = [];
  const present: Buffer[] = [];
  columns.forEach((column, index) => {
    if (!(column.name in row)) return;
    const value = encodeValue(row[column.name]);
    const head = Buffer.alloc(2);
    head.writeUInt16BE(index, 0);
    present.push(Buffer.concat([head, value]));
  });
  const count = Buffer.alloc(2);
  count.writeUInt16BE(present.length, 0);
  parts.push(count, ...present);
  return Buffer.concat(parts);
}

export function decodeRecord(columns: ColumnDef[], payload: Buffer): Row {
  if (payload.length < 2) throw new KinDbError('E_IO', 'A stored record is truncated');
  const count = payload.readUInt16BE(0);
  const row: Row = {};
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 > payload.length) throw new KinDbError('E_IO', 'A stored record is truncated');
    const index = payload.readUInt16BE(offset);
    offset += 2;
    const decoded = decodeValue(payload, offset);
    offset = decoded.offset;
    const column = columns[index];
    if (!column) throw new KinDbError('E_IO', 'A stored record names a missing column');
    row[column.name] = decoded.value;
  }
  return row;
}

function encodeValue(value: JsonValue): Buffer {
  if (value === null) return Buffer.from([0]);
  if (value === false) return Buffer.from([1]);
  if (value === true) return Buffer.from([2]);
  if (typeof value === 'number') {
    const body = Buffer.alloc(9);
    body.writeUInt8(3, 0);
    body.writeDoubleBE(value, 1);
    return body;
  }
  if (typeof value === 'string') return encodeBytes(4, Buffer.from(value, 'utf8'));
  return encodeBytes(5, Buffer.from(JSON.stringify(value), 'utf8'));
}

function encodeBytes(serial: number, bytes: Buffer): Buffer {
  const body = Buffer.alloc(5 + bytes.length);
  body.writeUInt8(serial, 0);
  body.writeUInt32BE(bytes.length, 1);
  bytes.copy(body, 5);
  return body;
}

function decodeValue(payload: Buffer, offset: number): { value: JsonValue; offset: number } {
  if (offset >= payload.length) throw new KinDbError('E_IO', 'A stored value is truncated');
  const serial = payload.readUInt8(offset);
  if (serial === 0) return { value: null, offset: offset + 1 };
  if (serial === 1) return { value: false, offset: offset + 1 };
  if (serial === 2) return { value: true, offset: offset + 1 };
  if (serial === 3) {
    if (offset + 9 > payload.length) throw new KinDbError('E_IO', 'A stored number is truncated');
    const value = payload.readDoubleBE(offset + 1);
    return { value: Number.isInteger(value) ? value : value, offset: offset + 9 };
  }
  if (serial === 4 || serial === 5) {
    if (offset + 5 > payload.length) throw new KinDbError('E_IO', 'A stored string is truncated');
    const length = payload.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > payload.length) throw new KinDbError('E_IO', 'A stored string is truncated');
    const text = payload.subarray(start, end).toString('utf8');
    if (serial === 4) return { value: text, offset: end };
    return { value: JSON.parse(text) as JsonValue, offset: end };
  }
  throw new KinDbError('E_IO', `Unknown value serial ${serial}`);
}
