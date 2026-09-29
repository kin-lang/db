import { KinDbError } from '../errors';
import {
  blankLeaf,
  PAGE_INTERIOR,
  PAGE_LEAF,
  PAGE_SIZE,
  readInterior,
  readLeaf,
  writeInterior,
  writeLeaf,
  type Divider,
  type LeafCell,
} from './format';
import { Pager } from './pager';

/** On-page payload cap. The rest of a long record goes to overflow pages. */
const MAX_LOCAL = 64;

export interface StoredRecord {
  rowid: number;
  payload: Buffer;
  overflow: number;
}

/** In-order scan of a table btree. */
export function scanTree(pager: Pager, root: number): StoredRecord[] {
  const found: StoredRecord[] = [];
  walk(pager, root, found);
  return found;
}

export function insertTree(pager: Pager, root: number, rowid: number, payload: Buffer): number {
  const cell = spill(pager, rowid, payload);
  return place(pager, root, cell).root;
}

export function deleteTree(pager: Pager, root: number, rowid: number): number {
  const path = descend(pager, root, rowid);
  const cells = readLeaf(pager.get(path.leaf));
  const index = cells.findIndex((cell) => cell.rowid === rowid);
  if (index < 0) throw new KinDbError('E_IO', `Row ${rowid} was not found in its page`);
  const [removed] = cells.splice(index, 1);
  freeOverflow(pager, removed.overflow);
  if (cells.length > 0 || path.parents.length === 0) {
    commitLeaf(pager, path.leaf, cells);
    return root;
  }
  pager.free(path.leaf);
  return unlink(pager, root, path.parents, path.slot);
}

/** Free every page in a btree, including overflow pages hanging off its leaves. */
export function freeTree(pager: Pager, root: number): void {
  const records = scanTree(pager, root);
  const pages = collectPages(pager, root);
  for (const record of records) freeOverflow(pager, record.overflow);
  for (const page of pages) pager.free(page);
}

function walk(pager: Pager, pageNumber: number, into: StoredRecord[]): void {
  const page = pager.get(pageNumber);
  if (page.readUInt8(0) === PAGE_LEAF) {
    for (const cell of readLeaf(page)) {
      into.push({ rowid: cell.rowid, payload: readPayload(pager, cell), overflow: cell.overflow });
    }
    return;
  }
  if (page.readUInt8(0) !== PAGE_INTERIOR) {
    throw new KinDbError('E_IO', `Page ${pageNumber} is not a table page`);
  }
  const node = readInterior(page);
  for (const divider of node.dividers) walk(pager, divider.left, into);
  walk(pager, node.right, into);
}

function collectPages(pager: Pager, pageNumber: number): number[] {
  const page = pager.get(pageNumber);
  if (page.readUInt8(0) === PAGE_LEAF) return [pageNumber];
  const node = readInterior(page);
  const nested = node.dividers.flatMap((divider) => collectPages(pager, divider.left));
  return [pageNumber, ...nested, ...collectPages(pager, node.right)];
}

interface Path {
  leaf: number;
  /** Parents from root down to the leaf's parent. `slot` is the child index. */
  parents: { page: number; slot: number }[];
  slot: number;
}

function descend(pager: Pager, root: number, rowid: number): Path {
  const parents: { page: number; slot: number }[] = [];
  let pageNumber = root;
  while (pager.get(pageNumber).readUInt8(0) === PAGE_INTERIOR) {
    const node = readInterior(pager.get(pageNumber));
    let slot = node.dividers.length;
    let next = node.right;
    for (let i = 0; i < node.dividers.length; i += 1) {
      if (rowid <= node.dividers[i].key) {
        slot = i;
        next = node.dividers[i].left;
        break;
      }
    }
    parents.push({ page: pageNumber, slot });
    pageNumber = next;
  }
  const parent = parents[parents.length - 1];
  return { leaf: pageNumber, parents, slot: parent ? parent.slot : 0 };
}

function place(pager: Pager, root: number, cell: LeafCell): { root: number } {
  const path = descend(pager, root, cell.rowid);
  const cells = readLeaf(pager.get(path.leaf));
  const next = [...cells, cell].sort((a, b) => a.rowid - b.rowid);
  if (writeLeaf(next)) {
    commitLeaf(pager, path.leaf, next);
    return { root };
  }
  const [leftCells, rightCells] = splitBalanced(next, (group) => writeLeaf(group) !== null);
  const rightPage = pager.allocate();
  commitLeaf(pager, path.leaf, leftCells);
  commitLeaf(pager, rightPage, rightCells);
  const separator = leftCells[leftCells.length - 1].rowid;
  const newRoot = attach(pager, root, path, separator, rightPage);
  return { root: newRoot };
}

function attach(pager: Pager, root: number, path: Path, separator: number, rightPage: number): number {
  if (path.parents.length === 0) {
    const created = pager.allocate();
    commitInterior(pager, created, [{ left: path.leaf, key: separator }], rightPage);
    return created;
  }
  const parent = path.parents[path.parents.length - 1];
  const node = readInterior(pager.get(parent.page));
  const dividers = node.dividers.map((divider) => ({ ...divider }));
  let right = node.right;
  if (parent.slot === dividers.length) {
    dividers.push({ left: right, key: separator });
    right = rightPage;
  } else {
    const current = dividers[parent.slot];
    dividers.splice(parent.slot, 1, { left: current.left, key: separator }, { left: rightPage, key: current.key });
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
  if (cut === 0) throw new KinDbError('E_IO', 'An interior page split could not place its cells');
  const leftDividers = dividers.slice(0, cut);
  const promoted = leftDividers[leftDividers.length - 1];
  const rightRest = dividers.slice(cut);
  // The promoted key separates the two interior pages. Its left page stays
  // in the left interior; the right interior starts at the following child.
  const leftKept = leftDividers.slice(0, -1);
  const rightChildOfLeft = promoted.left;
  const newRight = pager.allocate();
  commitInterior(pager, parent.page, leftKept, rightChildOfLeft);
  commitInterior(pager, newRight, rightRest, right);
  const above = path.parents.slice(0, -1);
  const synthetic: Path = {
    leaf: parent.page,
    parents: above,
    slot: above.length ? above[above.length - 1].slot : 0,
  };
  return attach(pager, root, synthetic, promoted.key, newRight);
}

function unlink(pager: Pager, root: number, parents: { page: number; slot: number }[], slot: number): number {
  const parent = parents[parents.length - 1];
  const node = readInterior(pager.get(parent.page));
  const children = node.dividers.map((divider) => divider.left).concat([node.right]);
  const bounds = node.dividers.map((divider) => divider.key);
  children.splice(slot, 1);
  if (slot < bounds.length) bounds.splice(slot, 1);
  else bounds.pop();
  if (children.length === 0) {
    pager.free(parent.page);
    if (parents.length === 1) {
      const leaf = pager.allocate();
      pager.put(leaf, blankLeaf());
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
  const right = children[children.length - 1];
  const dividers: Divider[] = children.slice(0, -1).map((left, index) => ({
    left,
    key: bounds[index],
  }));
  commitInterior(pager, parent.page, dividers, right);
  return root;
}

/** A collapsed parent was removed. Point the grandparent slot from `oldPage` to `replacement`. */
function retarget(
  pager: Pager,
  root: number,
  parents: { page: number; slot: number }[],
  replacement: number,
  oldPage: number,
): number {
  const parent = parents[parents.length - 1];
  const node = readInterior(pager.get(parent.page));
  const dividers = node.dividers.map((divider) => ({
    ...divider,
    left: divider.left === oldPage ? replacement : divider.left,
  }));
  const right = node.right === oldPage ? replacement : node.right;
  commitInterior(pager, parent.page, dividers, right);
  return root;
}

function spill(pager: Pager, rowid: number, payload: Buffer): LeafCell {
  if (payload.length <= MAX_LOCAL) {
    return { rowid, total: payload.length, overflow: 0, local: Buffer.from(payload) };
  }
  const local = Buffer.from(payload.subarray(0, MAX_LOCAL));
  const overflow = writeOverflow(pager, payload.subarray(MAX_LOCAL));
  return { rowid, total: payload.length, overflow, local };
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

function readPayload(pager: Pager, cell: LeafCell): Buffer {
  if (cell.overflow === 0) return Buffer.from(cell.local);
  const chunks = [cell.local];
  let pageNumber = cell.overflow;
  let remaining = cell.total - cell.local.length;
  while (pageNumber !== 0 && remaining > 0) {
    const page = pager.get(pageNumber);
    const take = Math.min(remaining, PAGE_SIZE - 4);
    chunks.push(Buffer.from(page.subarray(4, 4 + take)));
    remaining -= take;
    pageNumber = page.readUInt32BE(0);
  }
  if (remaining !== 0) throw new KinDbError('E_IO', 'An overflow chain ended early');
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
  throw new KinDbError('E_IO', 'A page split could not place its cells');
}

function commitLeaf(pager: Pager, pageNumber: number, cells: LeafCell[]): void {
  const page = writeLeaf(cells);
  if (!page) throw new KinDbError('E_IO', `Leaf page ${pageNumber} cannot hold its cells`);
  pager.put(pageNumber, page);
}

function commitInterior(pager: Pager, pageNumber: number, dividers: Divider[], right: number): void {
  const page = writeInterior(dividers, right);
  if (!page) throw new KinDbError('E_IO', `Interior page ${pageNumber} cannot hold its cells`);
  pager.put(pageNumber, page);
}
