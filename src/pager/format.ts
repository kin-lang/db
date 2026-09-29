/** Fixed page size. Small on purpose so a short table spans more than one page. */
export const PAGE_SIZE = 512;

/** 16-byte magic at the start of page 1. ASCII "KinDB page v1". */
export const MAGIC = Buffer.from('KinDB page v1\0\0\0');

export const PAGE_LEAF = 0x0d;
export const PAGE_INTERIOR = 0x05;
export const PAGE_FREELIST = 0x02;

/** Bytes reserved at the front of page 1, same idea as SQLite's 100-byte header. */
export const HEADER_BYTES = 100;

export const LEAF_HEADER = 8;
export const INTERIOR_HEADER = 12;
export const CELL_HEADER = 14;
export const INTERIOR_CELL = 8;

const FREELIST_HEADER = 7;

export interface FileHeader {
  pageCount: number;
  freelistHead: number;
  freelistCount: number;
  schemaRoot: number;
  schemaNext: number;
  changeCounter: number;
}

export interface LeafCell {
  rowid: number;
  /** Full payload length, including bytes stored on overflow pages. */
  total: number;
  overflow: number;
  local: Buffer;
}

export interface Divider {
  left: number;
  key: number;
}

export function emptyHeader(pageCount: number): FileHeader {
  return {
    pageCount,
    freelistHead: 0,
    freelistCount: 0,
    schemaRoot: 2,
    schemaNext: 1,
    changeCounter: 0,
  };
}

export function readHeader(page: Buffer): FileHeader {
  if (page.length < HEADER_BYTES || !page.subarray(0, 16).equals(MAGIC)) {
    throw new Error('not a KinDB page file');
  }
  const pageSize = page.readUInt16BE(16);
  if (pageSize !== PAGE_SIZE) {
    throw new Error(`unsupported page size ${pageSize}`);
  }
  return {
    pageCount: page.readUInt32BE(24),
    freelistHead: page.readUInt32BE(28),
    freelistCount: page.readUInt32BE(32),
    schemaRoot: page.readUInt32BE(36),
    changeCounter: page.readUInt32BE(40),
    schemaNext: page.readUInt32BE(44),
  };
}

export function writeHeader(page: Buffer, header: FileHeader): void {
  page.fill(0, 0, HEADER_BYTES);
  MAGIC.copy(page, 0);
  page.writeUInt16BE(PAGE_SIZE, 16);
  page.writeUInt8(1, 18);
  page.writeUInt8(1, 19);
  page.writeUInt32BE(header.pageCount, 24);
  page.writeUInt32BE(header.freelistHead, 28);
  page.writeUInt32BE(header.freelistCount, 32);
  page.writeUInt32BE(header.schemaRoot, 36);
  page.writeUInt32BE(header.changeCounter, 40);
  page.writeUInt32BE(header.schemaNext, 44);
}

export function blankLeaf(): Buffer {
  const page = Buffer.alloc(PAGE_SIZE);
  page.writeUInt8(PAGE_LEAF, 0);
  page.writeUInt16BE(PAGE_SIZE, 3);
  return page;
}

export function readLeaf(page: Buffer): LeafCell[] {
  assertType(page, PAGE_LEAF);
  const count = page.readUInt16BE(1);
  const cells: LeafCell[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = page.readUInt16BE(LEAF_HEADER + i * 2);
    const rowid = page.readUInt32BE(offset);
    const total = page.readUInt32BE(offset + 4);
    const overflow = page.readUInt32BE(offset + 8);
    const localLength = page.readUInt16BE(offset + 12);
    const local = Buffer.from(page.subarray(offset + CELL_HEADER, offset + CELL_HEADER + localLength));
    cells.push({ rowid, total, overflow, local });
  }
  return cells;
}

/** Pack cells from the end of the page. Returns null when they do not fit. */
export function writeLeaf(cells: LeafCell[]): Buffer | null {
  const page = Buffer.alloc(PAGE_SIZE);
  let cursor = PAGE_SIZE;
  const pointers: number[] = [];
  for (const cell of cells) {
    const size = CELL_HEADER + cell.local.length;
    cursor -= size;
    if (cursor < LEAF_HEADER + (pointers.length + 1) * 2) return null;
    pointers.push(cursor);
    page.writeUInt32BE(cell.rowid, cursor);
    page.writeUInt32BE(cell.total, cursor + 4);
    page.writeUInt32BE(cell.overflow, cursor + 8);
    page.writeUInt16BE(cell.local.length, cursor + 12);
    cell.local.copy(page, cursor + CELL_HEADER);
  }
  page.writeUInt8(PAGE_LEAF, 0);
  page.writeUInt16BE(cells.length, 1);
  page.writeUInt16BE(cells.length === 0 ? PAGE_SIZE : cursor, 3);
  pointers.forEach((pointer, index) => page.writeUInt16BE(pointer, LEAF_HEADER + index * 2));
  return page;
}

export function readInterior(page: Buffer): { dividers: Divider[]; right: number } {
  assertType(page, PAGE_INTERIOR);
  const count = page.readUInt16BE(1);
  const right = page.readUInt32BE(8);
  const dividers: Divider[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = page.readUInt16BE(INTERIOR_HEADER + i * 2);
    dividers.push({
      left: page.readUInt32BE(offset),
      key: page.readUInt32BE(offset + 4),
    });
  }
  return { dividers, right };
}

export function writeInterior(dividers: Divider[], right: number): Buffer | null {
  const page = Buffer.alloc(PAGE_SIZE);
  let cursor = PAGE_SIZE;
  const pointers: number[] = [];
  for (const divider of dividers) {
    cursor -= INTERIOR_CELL;
    if (cursor < INTERIOR_HEADER + (pointers.length + 1) * 2) return null;
    pointers.push(cursor);
    page.writeUInt32BE(divider.left, cursor);
    page.writeUInt32BE(divider.key, cursor + 4);
  }
  page.writeUInt8(PAGE_INTERIOR, 0);
  page.writeUInt16BE(dividers.length, 1);
  page.writeUInt16BE(dividers.length === 0 ? PAGE_SIZE : cursor, 3);
  page.writeUInt32BE(right, 8);
  pointers.forEach((pointer, index) => page.writeUInt16BE(pointer, INTERIOR_HEADER + index * 2));
  return page;
}

export function freelistCapacity(): number {
  return Math.floor((PAGE_SIZE - FREELIST_HEADER) / 4);
}

export function readFreelist(page: Buffer): { next: number; ids: number[] } {
  assertType(page, PAGE_FREELIST);
  const next = page.readUInt32BE(1);
  const count = page.readUInt16BE(5);
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) ids.push(page.readUInt32BE(FREELIST_HEADER + i * 4));
  return { next, ids };
}

export function writeFreelist(next: number, ids: number[]): Buffer {
  const page = Buffer.alloc(PAGE_SIZE);
  page.writeUInt8(PAGE_FREELIST, 0);
  page.writeUInt32BE(next, 1);
  page.writeUInt16BE(ids.length, 5);
  ids.forEach((id, index) => page.writeUInt32BE(id, FREELIST_HEADER + index * 4));
  return page;
}

function assertType(page: Buffer, type: number): void {
  if (page.readUInt8(0) !== type) {
    throw new Error(`expected page type ${type}, found ${page.readUInt8(0)}`);
  }
}
