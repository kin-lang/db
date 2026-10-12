import { KinDbError } from '../errors';
import { PAGE_SIZE } from './format';
import { pointHigh, pointLow, type Bound } from './index-key';
import { Pager } from './pager';

/**
 * Btree ordered by `(index key, row id)`.
 * Table pages cannot hold this: their separators are row ids.
 * Leaf type is 0x0a and interior type is 0x0b (table pages use 0x0d / 0x05,
 * freelist uses 0x02). A separator owns its own copy of the key bytes, so
 * deleting a leaf entry can free that entry's overflow without touching
 * the parent.
 */

const PAGE_INDEX_LEAF = 0x0a;
const PAGE_INDEX_INTERIOR = 0x0b;

const LEAF_HEADER = 8;
const INTERIOR_HEADER = 12;
/** rowid, keyTotal, overflow, local length. */
const LEAF_FIXED = 14;
/** left child, rowid, keyTotal, overflow, local length. */
const INTERIOR_FIXED = 18;
/** Inline key bytes. The rest of a long key sits on an overflow chain. */
const MAX_LOCAL = 64;

interface KeyBody {
  key: Buffer;
  keyTotal: number;
  overflow: number;
  local: Buffer;
}

interface IndexCell extends KeyBody {
  rowid: number;
}

interface Divider extends KeyBody {
  left: number;
  rowid: number;
}

interface Path {
  leaf: number;
  parents: { page: number; slot: number }[];
  slot: number;
}

export function blankIndexLeaf(): Buffer {
  const page = Buffer.alloc(PAGE_SIZE);
  page.writeUInt8(PAGE_INDEX_LEAF, 0);
  page.writeUInt16BE(PAGE_SIZE, 3);
  return page;
}

/**
 * Visit entries from `low` through `high` in index order.
 * `visit` returns false to stop. Subtrees that cannot hold a match are not read.
 */
/** Smallest and largest keys in an index, or null when the index has no entries. */
export function indexExtent(pager: Pager, root: number): { min: Buffer; max: Buffer } | null {
  const min = edgeKey(pager, root, 'left');
  const max = edgeKey(pager, root, 'right');
  if (!min || !max) return null;
  return { min, max };
}

function edgeKey(pager: Pager, pageNumber: number, side: 'left' | 'right'): Buffer | null {
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) {
    const cells = readLeaf(pager, pageNumber);
    if (cells.length === 0) return null;
    return side === 'left' ? cells[0].key : cells[cells.length - 1].key;
  }
  if (type !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index page`);
  }
  const node = readInterior(pager, pageNumber);
  if (side === 'right') return edgeKey(pager, node.right, side);
  if (node.dividers.length === 0) return edgeKey(pager, node.right, side);
  return edgeKey(pager, node.dividers[0].left, side);
}

export function scanIndex(
  pager: Pager,
  root: number,
  low: Bound | null,
  high: Bound | null,
  visit: (key: Buffer, rowid: number) => boolean,
): void {
  walk(pager, root, low, high, visit);
}

/**
 * Smallest row id strictly above `above` whose key sits in `[low, high]`.
 * A subtree that is entirely inside the range answers from its cached minimum,
 * so a limit does not read every matching key.
 * `visit` runs once for each index page this search reads.
 */
export function smallestRowid(
  pager: Pager,
  root: number,
  low: Bound | null,
  high: Bound | null,
  above: number,
  visit: () => void,
): number | null {
  return smallest(pager, root, low, high, above, visit);
}

/** Fill cached subtree minimums and entry counts. Used when a page file is opened. */
export function warmIndexMins(pager: Pager, root: number): void {
  fillMin(pager, root);
}

/**
 * How many entries have a key inside `[low, high]`.
 * A subtree that sits fully inside the window answers from its cached count.
 */
export function countEntries(
  pager: Pager,
  root: number,
  low: Bound | null,
  high: Bound | null,
): number {
  if (!low && !high) return cachedCount(pager, root);
  return countPage(pager, root, low, high);
}

/** Greatest key inside `[low, high]`, or null when the window is empty. */
export function greatestKey(pager: Pager, root: number, low: Bound | null, high: Bound | null): Buffer | null {
  return maxKeyAt(pager, root, low, high);
}

/**
 * Greatest key strictly less than `key` that still sits inside `[low, high]`.
 * Equal keys stay together, so a descending limit can emit one key's row ids
 * from smallest to largest and then step to the previous key.
 */
export function greatestKeyBelow(
  pager: Pager,
  root: number,
  key: Buffer,
  low: Bound | null,
  high: Bound | null,
): Buffer | null {
  return belowAt(pager, root, key, low, high);
}

/**
 * Entries inside `[low, high]` in index order, or in descending key order
 * with equal keys still in row id order. `visit` returns false to stop.
 */
export function forEachOrdered(
  pager: Pager,
  root: number,
  direction: 'asc' | 'desc',
  low: Bound | null,
  high: Bound | null,
  visit: (key: Buffer, rowid: number) => boolean,
): void {
  if (direction === 'asc') {
    scanIndex(pager, root, low, high, visit);
    return;
  }
  let key = greatestKey(pager, root, low, high);
  let above = 0;
  while (key) {
    const window = clipToKey(key, low, high);
    const rowid = smallestRowid(pager, root, window.low, window.high, above, () => {});
    if (rowid === null) {
      const next = greatestKeyBelow(pager, root, key, low, high);
      if (!next || compareKeys(next, key) >= 0) return;
      key = next;
      above = 0;
      continue;
    }
    above = rowid;
    if (!visit(key, rowid)) return;
  }
}

export function insertIndex(pager: Pager, root: number, key: Buffer, rowid: number): number {
  const cell = spill(pager, key, rowid);
  return place(pager, root, cell);
}

export function deleteIndex(pager: Pager, root: number, key: Buffer, rowid: number): number {
  const path = descend(pager, root, key, rowid);
  const cells = readLeaf(pager, path.leaf);
  const index = cells.findIndex((cell) => cell.rowid === rowid && compareKeys(cell.key, key) === 0);
  if (index < 0) {
    throw new KinDbError('E_IO', 'An index entry was not found in its page');
  }
  const [removed] = cells.splice(index, 1);
  freeOverflow(pager, removed.overflow);
  let next: number;
  if (cells.length > 0 || path.parents.length === 0) {
    commitLeaf(pager, path.leaf, cells);
    next = root;
  } else {
    pager.free(path.leaf);
    next = unlink(pager, root, path.parents, path.slot);
  }
  rememberIndexMin(pager, next, key, rowid);
  return next;
}

/** Free every page of an index btree, including key overflow. */
export function freeIndex(pager: Pager, root: number): void {
  const pages: number[] = [];
  const overflows: number[] = [];
  collect(pager, root, pages, overflows);
  for (const overflow of overflows) freeOverflow(pager, overflow);
  for (const page of pages) pager.free(page);
}

function walk(
  pager: Pager,
  pageNumber: number,
  low: Bound | null,
  high: Bound | null,
  visit: (key: Buffer, rowid: number) => boolean,
): boolean {
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) {
    for (const cell of readLeaf(pager, pageNumber)) {
      const pos = position(cell.key, cell.rowid, low, high);
      if (pos < 0) continue;
      if (pos > 0) return false;
      if (!visit(cell.key, cell.rowid)) return false;
    }
    return true;
  }
  if (type !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index page`);
  }
  const node = readInterior(pager, pageNumber);
  for (const divider of node.dividers) {
    // The divider is the last entry of its left child. A divider below the
    // range means that whole child is below it too.
    if (position(divider.key, divider.rowid, low, high) < 0) continue;
    if (!walk(pager, divider.left, low, high, visit)) return false;
    if (position(divider.key, divider.rowid, low, high) > 0) return false;
  }
  return walk(pager, node.right, low, high, visit);
}

function position(key: Buffer, rowid: number, low: Bound | null, high: Bound | null): number {
  if (low) {
    const cmp = compareEntry(key, rowid, low.key, low.rowid);
    if (cmp < 0 || (cmp === 0 && !low.inclusive)) return -1;
  }
  if (high) {
    const cmp = compareEntry(key, rowid, high.key, high.rowid);
    if (cmp > 0 || (cmp === 0 && !high.inclusive)) return 1;
  }
  return 0;
}

function place(pager: Pager, root: number, cell: IndexCell): number {
  const path = descend(pager, root, cell.key, cell.rowid);
  const cells = readLeaf(pager, path.leaf);
  if (cells.some((item) => item.rowid === cell.rowid && compareKeys(item.key, cell.key) === 0)) {
    throw new KinDbError('E_IO', 'An index entry was inserted twice');
  }
  const next = [...cells, cell].sort((a, b) => compareEntry(a.key, a.rowid, b.key, b.rowid));
  if (writeLeaf(next)) {
    commitLeaf(pager, path.leaf, next);
    bubbleIndexMin(pager, path);
    return root;
  }
  const [leftCells, rightCells] = splitBalanced(next, (group) => writeLeaf(group) !== null);
  const rightPage = pager.allocate();
  commitLeaf(pager, path.leaf, leftCells);
  commitLeaf(pager, rightPage, rightCells);
  const separator = own(pager, leftCells[leftCells.length - 1]);
  const nextRoot = attach(pager, root, path, separator, rightPage);
  bubbleIndexMin(pager, path);
  return nextRoot;
}

function attach(
  pager: Pager,
  root: number,
  path: Path,
  separator: KeyBody & { rowid: number },
  rightPage: number,
): number {
  if (path.parents.length === 0) {
    const created = pager.allocate();
    commitInterior(pager, created, [{ ...separator, left: path.leaf }], rightPage);
    return created;
  }
  const parent = path.parents[path.parents.length - 1];
  const node = readInterior(pager, parent.page);
  const dividers = node.dividers.map((divider) => ({ ...divider }));
  let right = node.right;
  if (parent.slot === dividers.length) {
    dividers.push({ ...separator, left: right });
    right = rightPage;
  } else {
    const current = dividers[parent.slot];
    dividers.splice(
      parent.slot,
      1,
      { ...separator, left: current.left },
      { ...current, left: rightPage },
    );
  }
  if (writeInterior(dividers, right)) {
    commitInterior(pager, parent.page, dividers, right);
    return root;
  }
  const interiorFits = (count: number): boolean => {
    if (count < 1 || count >= dividers.length) return false;
    const leftGroup = dividers.slice(0, count);
    const rightGroup = dividers.slice(count);
    const boundary = leftGroup[leftGroup.length - 1];
    return (
      writeInterior(leftGroup.slice(0, -1), boundary.left) !== null &&
      writeInterior(rightGroup, right) !== null
    );
  };
  let cut = 0;
  const middle = Math.ceil(dividers.length / 2);
  for (let distance = 0; distance < dividers.length && cut === 0; distance += 1) {
    const candidates = distance === 0 ? [middle] : [middle - distance, middle + distance];
    for (const count of candidates) {
      if (interiorFits(count)) {
        cut = count;
        break;
      }
    }
  }
  if (cut === 0) throw new KinDbError('E_IO', 'An index interior split could not place its cells');
  const leftDividers = dividers.slice(0, cut);
  const promoted = leftDividers[leftDividers.length - 1];
  const rightRest = dividers.slice(cut);
  const newRight = pager.allocate();
  commitInterior(pager, parent.page, leftDividers.slice(0, -1), promoted.left);
  commitInterior(pager, newRight, rightRest, right);
  const above = path.parents.slice(0, -1);
  const synthetic: Path = {
    leaf: parent.page,
    parents: above,
    slot: above.length ? above[above.length - 1].slot : 0,
  };
  return attach(pager, root, synthetic, promoted, newRight);
}

function unlink(
  pager: Pager,
  root: number,
  parents: { page: number; slot: number }[],
  slot: number,
): number {
  const parent = parents[parents.length - 1];
  const node = readInterior(pager, parent.page);
  const children = node.dividers.map((divider) => divider.left).concat([node.right]);
  const dividers = node.dividers.map((divider) => ({ ...divider }));
  children.splice(slot, 1);
  const dropped = slot < dividers.length ? dividers.splice(slot, 1)[0] : dividers.pop();
  if (dropped) freeOverflow(pager, dropped.overflow);
  if (children.length === 0) {
    pager.free(parent.page);
    if (parents.length === 1) {
      const leaf = pager.allocate();
      pager.put(leaf, blankIndexLeaf());
      return leaf;
    }
    const above = parents.slice(0, -1);
    return unlink(pager, root, above, above[above.length - 1].slot);
  }
  if (children.length === 1) {
    pager.free(parent.page);
    const only = children[0];
    if (parents.length === 1) return only;
    return retarget(pager, root, parents.slice(0, -1), only, parent.page);
  }
  commitInterior(pager, parent.page, dividers, children[children.length - 1]);
  return root;
}

function retarget(
  pager: Pager,
  root: number,
  parents: { page: number; slot: number }[],
  replacement: number,
  oldPage: number,
): number {
  const parent = parents[parents.length - 1];
  const node = readInterior(pager, parent.page);
  const dividers = node.dividers.map((divider) => ({
    ...divider,
    left: divider.left === oldPage ? replacement : divider.left,
  }));
  const right = node.right === oldPage ? replacement : node.right;
  commitInterior(pager, parent.page, dividers, right);
  return root;
}

function descend(pager: Pager, root: number, key: Buffer, rowid: number): Path {
  const parents: { page: number; slot: number }[] = [];
  let pageNumber = root;
  while (pager.get(pageNumber).readUInt8(0) === PAGE_INDEX_INTERIOR) {
    const node = readInterior(pager, pageNumber);
    let slot = node.dividers.length;
    let next = node.right;
    for (let i = 0; i < node.dividers.length; i += 1) {
      const divider = node.dividers[i];
      if (compareEntry(key, rowid, divider.key, divider.rowid) <= 0) {
        slot = i;
        next = divider.left;
        break;
      }
    }
    parents.push({ page: pageNumber, slot });
    pageNumber = next;
  }
  if (pager.get(pageNumber).readUInt8(0) !== PAGE_INDEX_LEAF) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index leaf`);
  }
  const parent = parents[parents.length - 1];
  return { leaf: pageNumber, parents, slot: parent ? parent.slot : 0 };
}

function collect(pager: Pager, pageNumber: number, pages: number[], overflows: number[]): void {
  pages.push(pageNumber);
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) {
    for (const cell of readLeaf(pager, pageNumber)) {
      if (cell.overflow !== 0) overflows.push(cell.overflow);
    }
    return;
  }
  const node = readInterior(pager, pageNumber);
  for (const divider of node.dividers) {
    if (divider.overflow !== 0) overflows.push(divider.overflow);
    collect(pager, divider.left, pages, overflows);
  }
  collect(pager, node.right, pages, overflows);
}

function spill(pager: Pager, key: Buffer, rowid: number): IndexCell {
  return { rowid, ...copyKey(pager, key) };
}

/** A separator must not share overflow pages with the leaf it was copied from. */
function own(pager: Pager, cell: IndexCell): KeyBody & { rowid: number } {
  return { rowid: cell.rowid, ...copyKey(pager, cell.key) };
}

function copyKey(pager: Pager, key: Buffer): KeyBody {
  const owned = Buffer.from(key);
  if (owned.length <= MAX_LOCAL) {
    return { key: owned, keyTotal: owned.length, overflow: 0, local: owned };
  }
  const local = Buffer.from(owned.subarray(0, MAX_LOCAL));
  return {
    key: owned,
    keyTotal: owned.length,
    overflow: writeOverflow(pager, owned.subarray(MAX_LOCAL)),
    local,
  };
}

function readLeaf(pager: Pager, pageNumber: number): IndexCell[] {
  const page = pager.get(pageNumber);
  if (page.readUInt8(0) !== PAGE_INDEX_LEAF) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index leaf`);
  }
  const count = page.readUInt16BE(1);
  const cells: IndexCell[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = page.readUInt16BE(LEAF_HEADER + i * 2);
    const rowid = page.readUInt32BE(offset);
    const keyTotal = page.readUInt32BE(offset + 4);
    const overflow = page.readUInt32BE(offset + 8);
    const localLen = page.readUInt16BE(offset + 12);
    if (offset + LEAF_FIXED + localLen > PAGE_SIZE) {
      throw new KinDbError('E_IO', 'An index cell is truncated');
    }
    const local = Buffer.from(page.subarray(offset + LEAF_FIXED, offset + LEAF_FIXED + localLen));
    cells.push({ rowid, keyTotal, overflow, local, key: loadKey(pager, keyTotal, overflow, local) });
  }
  return cells;
}

function readInterior(pager: Pager, pageNumber: number): { dividers: Divider[]; right: number } {
  const page = pager.get(pageNumber);
  if (page.readUInt8(0) !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index interior`);
  }
  const count = page.readUInt16BE(1);
  const right = page.readUInt32BE(8);
  const dividers: Divider[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = page.readUInt16BE(INTERIOR_HEADER + i * 2);
    const left = page.readUInt32BE(offset);
    const rowid = page.readUInt32BE(offset + 4);
    const keyTotal = page.readUInt32BE(offset + 8);
    const overflow = page.readUInt32BE(offset + 12);
    const localLen = page.readUInt16BE(offset + 16);
    if (offset + INTERIOR_FIXED + localLen > PAGE_SIZE) {
      throw new KinDbError('E_IO', 'An index separator is truncated');
    }
    const local = Buffer.from(page.subarray(offset + INTERIOR_FIXED, offset + INTERIOR_FIXED + localLen));
    dividers.push({
      left,
      rowid,
      keyTotal,
      overflow,
      local,
      key: loadKey(pager, keyTotal, overflow, local),
    });
  }
  return { dividers, right };
}

function writeLeaf(cells: IndexCell[]): Buffer | null {
  const page = Buffer.alloc(PAGE_SIZE);
  let cursor = PAGE_SIZE;
  const pointers: number[] = [];
  for (const cell of cells) {
    const size = LEAF_FIXED + cell.local.length;
    cursor -= size;
    if (cursor < LEAF_HEADER + (pointers.length + 1) * 2) return null;
    pointers.push(cursor);
    page.writeUInt32BE(cell.rowid, cursor);
    page.writeUInt32BE(cell.keyTotal, cursor + 4);
    page.writeUInt32BE(cell.overflow, cursor + 8);
    page.writeUInt16BE(cell.local.length, cursor + 12);
    cell.local.copy(page, cursor + LEAF_FIXED);
  }
  page.writeUInt8(PAGE_INDEX_LEAF, 0);
  page.writeUInt16BE(cells.length, 1);
  page.writeUInt16BE(cells.length === 0 ? PAGE_SIZE : cursor, 3);
  pointers.forEach((pointer, index) => page.writeUInt16BE(pointer, LEAF_HEADER + index * 2));
  return page;
}

function writeInterior(dividers: Divider[], right: number): Buffer | null {
  const page = Buffer.alloc(PAGE_SIZE);
  let cursor = PAGE_SIZE;
  const pointers: number[] = [];
  for (const divider of dividers) {
    const size = INTERIOR_FIXED + divider.local.length;
    cursor -= size;
    if (cursor < INTERIOR_HEADER + (pointers.length + 1) * 2) return null;
    pointers.push(cursor);
    page.writeUInt32BE(divider.left, cursor);
    page.writeUInt32BE(divider.rowid, cursor + 4);
    page.writeUInt32BE(divider.keyTotal, cursor + 8);
    page.writeUInt32BE(divider.overflow, cursor + 12);
    page.writeUInt16BE(divider.local.length, cursor + 16);
    divider.local.copy(page, cursor + INTERIOR_FIXED);
  }
  page.writeUInt8(PAGE_INDEX_INTERIOR, 0);
  page.writeUInt16BE(dividers.length, 1);
  page.writeUInt16BE(dividers.length === 0 ? PAGE_SIZE : cursor, 3);
  page.writeUInt32BE(right, 8);
  pointers.forEach((pointer, index) => page.writeUInt16BE(pointer, INTERIOR_HEADER + index * 2));
  return page;
}

function commitLeaf(pager: Pager, pageNumber: number, cells: IndexCell[]): void {
  const page = writeLeaf(cells);
  if (!page) throw new KinDbError('E_IO', `Index leaf ${pageNumber} cannot hold its cells`);
  pager.put(pageNumber, page);
  noteCellsMin(pager, pageNumber, cells);
}

function commitInterior(pager: Pager, pageNumber: number, dividers: Divider[], right: number): void {
  const page = writeInterior(dividers, right);
  if (!page) throw new KinDbError('E_IO', `Index interior ${pageNumber} cannot hold its cells`);
  pager.put(pageNumber, page);
  writeInteriorMin(pager, pageNumber);
}

function loadKey(pager: Pager, keyTotal: number, overflow: number, local: Buffer): Buffer {
  if (overflow === 0) {
    if (local.length !== keyTotal) throw new KinDbError('E_IO', 'An index key is truncated');
    return Buffer.from(local);
  }
  const rest = readOverflow(pager, overflow, keyTotal - local.length);
  return Buffer.concat([local, rest]);
}

function writeOverflow(pager: Pager, data: Buffer): number {
  const capacity = PAGE_SIZE - 4;
  let first = 0;
  let previous = 0;
  let offset = 0;
  while (offset < data.length) {
    const pageNumber = pager.allocate();
    const chunk = data.subarray(offset, Math.min(data.length, offset + capacity));
    const page = Buffer.alloc(PAGE_SIZE);
    chunk.copy(page, 4);
    if (previous !== 0) {
      const prior = Buffer.from(pager.get(previous));
      prior.writeUInt32BE(pageNumber, 0);
      pager.put(previous, prior);
    } else {
      first = pageNumber;
    }
    pager.put(pageNumber, page);
    previous = pageNumber;
    offset += chunk.length;
  }
  return first;
}

function readOverflow(pager: Pager, pageNumber: number, total: number): Buffer {
  const chunks: Buffer[] = [];
  let remaining = total;
  let current = pageNumber;
  while (current !== 0 && remaining > 0) {
    const page = pager.get(current);
    const take = Math.min(remaining, PAGE_SIZE - 4);
    chunks.push(Buffer.from(page.subarray(4, 4 + take)));
    remaining -= take;
    current = page.readUInt32BE(0);
  }
  if (remaining !== 0) throw new KinDbError('E_IO', 'An index overflow chain ended early');
  return Buffer.concat(chunks);
}

function freeOverflow(pager: Pager, pageNumber: number): void {
  let current = pageNumber;
  while (current !== 0) {
    const next = pager.get(current).readUInt32BE(0);
    pager.free(current);
    current = next;
  }
}

function rememberIndexMin(pager: Pager, root: number, key: Buffer, rowid: number): void {
  const path = descend(pager, root, key, rowid);
  writeLeafMin(pager, path.leaf);
  bubbleIndexMin(pager, path);
}

function bubbleIndexMin(pager: Pager, path: Path): void {
  for (let i = path.parents.length - 1; i >= 0; i -= 1) {
    writeInteriorMin(pager, path.parents[i].page);
  }
}

function noteCellsMin(pager: Pager, pageNumber: number, cells: IndexCell[]): number | null {
  pager.setIndexCount(pageNumber, cells.length);
  if (cells.length === 0) {
    pager.clearIndexMin(pageNumber);
    return null;
  }
  let min = cells[0].rowid;
  for (let i = 1; i < cells.length; i += 1) {
    if (cells[i].rowid < min) min = cells[i].rowid;
  }
  pager.setIndexMin(pageNumber, min);
  return min;
}

function writeLeafMin(pager: Pager, pageNumber: number): number | null {
  return noteCellsMin(pager, pageNumber, readLeaf(pager, pageNumber));
}

function writeInteriorMin(pager: Pager, pageNumber: number): number | null {
  let min: number | null = null;
  let count = 0;
  for (const child of interiorChildPages(pager, pageNumber)) {
    count += cachedCount(pager, child);
    const value = cachedMin(pager, child);
    if (value !== null && (min === null || value < min)) min = value;
  }
  pager.setIndexCount(pageNumber, count);
  if (min === null) pager.clearIndexMin(pageNumber);
  else pager.setIndexMin(pageNumber, min);
  return min;
}

/** Child page numbers only. Separator keys stay unread. */
function interiorChildPages(pager: Pager, pageNumber: number): number[] {
  const page = pager.get(pageNumber);
  if (page.readUInt8(0) !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index interior`);
  }
  const count = page.readUInt16BE(1);
  const children: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = page.readUInt16BE(INTERIOR_HEADER + i * 2);
    children.push(page.readUInt32BE(offset));
  }
  children.push(page.readUInt32BE(8));
  return children;
}

function cachedMin(pager: Pager, pageNumber: number): number | null {
  return fillMin(pager, pageNumber);
}

function cachedCount(pager: Pager, pageNumber: number): number {
  if (pager.indexCountOf(pageNumber) === undefined) fillMin(pager, pageNumber);
  return pager.indexCountOf(pageNumber) ?? 0;
}

function fillMin(pager: Pager, pageNumber: number): number | null {
  if (pager.indexCountOf(pageNumber) !== undefined) {
    return pager.indexMinOf(pageNumber) ?? null;
  }
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) return writeLeafMin(pager, pageNumber);
  if (type !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index page`);
  }
  return writeInteriorMin(pager, pageNumber);
}

function countPage(pager: Pager, pageNumber: number, low: Bound | null, high: Bound | null): number {
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) {
    let total = 0;
    for (const cell of readLeaf(pager, pageNumber)) {
      const pos = position(cell.key, cell.rowid, low, high);
      if (pos > 0) break;
      if (pos === 0) total += 1;
    }
    return total;
  }
  if (type !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index page`);
  }
  let total = 0;
  for (const child of childEdges(readInterior(pager, pageNumber))) {
    if (child.high && position(child.high.key, child.high.rowid, low, high) < 0) continue;
    if (child.low && position(child.low.key, child.low.rowid, low, high) > 0) break;
    if (fullyInside(low, high, child.low, child.high)) total += cachedCount(pager, child.page);
    else total += countPage(pager, child.page, low, high);
  }
  return total;
}

function maxKeyAt(pager: Pager, pageNumber: number, low: Bound | null, high: Bound | null): Buffer | null {
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) {
    const cells = readLeaf(pager, pageNumber);
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      const cell = cells[i];
      const pos = position(cell.key, cell.rowid, low, high);
      if (pos === 0) return cell.key;
      if (pos < 0) return null;
    }
    return null;
  }
  if (type !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index page`);
  }
  const edges = childEdges(readInterior(pager, pageNumber));
  for (let i = edges.length - 1; i >= 0; i -= 1) {
    const child = edges[i];
    if (child.low && position(child.low.key, child.low.rowid, low, high) > 0) continue;
    if (child.high && position(child.high.key, child.high.rowid, low, high) < 0) return null;
    const found = maxKeyAt(pager, child.page, low, high);
    if (found) return found;
  }
  return null;
}

function belowAt(
  pager: Pager,
  pageNumber: number,
  key: Buffer,
  low: Bound | null,
  high: Bound | null,
): Buffer | null {
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) {
    let best: Buffer | null = null;
    for (const cell of readLeaf(pager, pageNumber)) {
      if (compareKeys(cell.key, key) >= 0) break;
      if (position(cell.key, cell.rowid, low, high) !== 0) continue;
      best = cell.key;
    }
    return best;
  }
  if (type !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index page`);
  }
  let best: Buffer | null = null;
  for (const child of childEdges(readInterior(pager, pageNumber))) {
    if (child.low && compareKeys(child.low.key, key) >= 0) break;
    if (child.high && compareKeys(child.high.key, key) < 0) {
      if (position(child.high.key, child.high.rowid, low, high) === 0) {
        best = child.high.key;
        continue;
      }
      const found = maxKeyAt(pager, child.page, low, high);
      if (found && (!best || compareKeys(found, best) > 0)) best = found;
      continue;
    }
    const found = belowAt(pager, child.page, key, low, high);
    if (found && (!best || compareKeys(found, best) > 0)) best = found;
  }
  return best;
}

function clipToKey(key: Buffer, low: Bound | null, high: Bound | null): { low: Bound; high: Bound } {
  let lo = pointLow(key);
  let hi = pointHigh(key);
  if (low && compareKeys(low.key, key) === 0) {
    const cmp = compareEntry(low.key, low.rowid, lo.key, lo.rowid);
    if (cmp > 0 || (cmp === 0 && !low.inclusive)) lo = low;
  }
  if (high && compareKeys(high.key, key) === 0) {
    const cmp = compareEntry(high.key, high.rowid, hi.key, hi.rowid);
    if (cmp < 0 || (cmp === 0 && !high.inclusive)) hi = high;
  }
  return { low: lo, high: hi };
}

function smallest(
  pager: Pager,
  pageNumber: number,
  low: Bound | null,
  high: Bound | null,
  above: number,
  visit: () => void,
): number | null {
  visit();
  const type = pager.get(pageNumber).readUInt8(0);
  if (type === PAGE_INDEX_LEAF) return smallestLeaf(pager, pageNumber, low, high, above);
  if (type !== PAGE_INDEX_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not an index page`);
  }
  const node = readInterior(pager, pageNumber);
  let best: number | null = null;
  for (const child of childEdges(node)) {
    if (child.high && position(child.high.key, child.high.rowid, low, high) < 0) continue;
    if (child.low && position(child.low.key, child.low.rowid, low, high) > 0) break;
    if (fullyInside(low, high, child.low, child.high)) {
      const min = cachedMin(pager, child.page);
      if (min !== null && min > above) {
        if (best === null || min < best) best = min;
        continue;
      }
      if (min === null) continue;
    }
    const deeper = smallest(pager, child.page, low, high, above, visit);
    if (deeper !== null && (best === null || deeper < best)) best = deeper;
  }
  return best;
}

function smallestLeaf(
  pager: Pager,
  pageNumber: number,
  low: Bound | null,
  high: Bound | null,
  above: number,
): number | null {
  let best: number | null = null;
  for (const cell of readLeaf(pager, pageNumber)) {
    const pos = position(cell.key, cell.rowid, low, high);
    if (pos > 0) break;
    if (pos < 0) continue;
    if (cell.rowid > above && (best === null || cell.rowid < best)) best = cell.rowid;
  }
  return best;
}

function childEdges(node: { dividers: Divider[]; right: number }): { page: number; low: Bound | null; high: Bound | null }[] {
  const edges: { page: number; low: Bound | null; high: Bound | null }[] = [];
  let previous: Bound | null = null;
  for (const divider of node.dividers) {
    edges.push({
      page: divider.left,
      low: previous,
      high: { key: divider.key, rowid: divider.rowid, inclusive: true },
    });
    previous = { key: divider.key, rowid: divider.rowid, inclusive: false };
  }
  edges.push({ page: node.right, low: previous, high: null });
  return edges;
}

/** True when every key in the child window is inside the query window. */
function fullyInside(
  queryLow: Bound | null,
  queryHigh: Bound | null,
  childLow: Bound | null,
  childHigh: Bound | null,
): boolean {
  if (queryLow && !childLow) return false;
  if (queryHigh && !childHigh) return false;
  if (childHigh && position(childHigh.key, childHigh.rowid, queryLow, queryHigh) !== 0) return false;
  if (childLow && position(childLow.key, childLow.rowid, queryLow, queryHigh) < 0) return false;
  return true;
}

function compareKeys(left: Buffer, right: Buffer): number {
  return Buffer.compare(left, right);
}

function compareEntry(leftKey: Buffer, leftId: number, rightKey: Buffer, rightId: number): number {
  const keys = Buffer.compare(leftKey, rightKey);
  if (keys !== 0) return keys;
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

function splitBalanced<T>(items: T[], fits: (group: T[]) => boolean): [T[], T[]] {
  const middle = Math.floor(items.length / 2);
  for (let distance = 0; distance < items.length; distance += 1) {
    const candidates = distance === 0 ? [middle] : [middle - distance, middle + distance];
    for (const count of candidates) {
      if (count < 1 || count >= items.length) continue;
      const left = items.slice(0, count);
      const right = items.slice(count);
      if (fits(left) && fits(right)) return [left, right];
    }
  }
  throw new KinDbError('E_IO', 'An index page split could not place its cells');
}
