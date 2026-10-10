import { KinDbError } from './errors';
import { deleteTree, findTree, freeTree, insertTree, scanTree, scanUntil } from './pager/btree';
import { blankLeaf } from './pager/format';
import { encodeIndexKey, pointHigh, pointLow, type Bound } from './pager/index-key';
import {
  blankIndexLeaf,
  deleteIndex,
  freeIndex,
  insertIndex,
  scanIndex,
} from './pager/index-tree';
import { Pager } from './pager/pager';
import {
  assertValueType,
  decodeRecord,
  encodeRecord,
  type ColumnDef,
} from './pager/record';
import { planAccess, planRead } from './relational/planner';
import {
  assertCollectionName,
  assertRow,
  cloneJson,
  matches,
  whereToPredicates,
  type Predicate,
  type Row,
  type Where,
} from './value';

export const KINDB_VERSION = 1;

const CATALOG: ColumnDef[] = [
  { name: 'name', type: 'string' },
  { name: 'root', type: 'number' },
  { name: 'nextRowid', type: 'number' },
  { name: 'columns', type: 'string' },
  { name: 'kind', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'column', type: 'string' },
];

interface TableEntry {
  kind: 'table';
  /** Rowid of this table inside the schema btree. */
  rowid: number;
  name: string;
  root: number;
  nextRowid: number;
  columns: ColumnDef[];
}

interface IndexEntry {
  kind: 'index';
  rowid: number;
  name: string;
  root: number;
  source: string;
  column: string;
}

type Entry = TableEntry | IndexEntry;

interface Hit {
  row: Row;
  rowid: number;
}

/**
 * Relations stored in a page file.
 * Each user table is a btree. A simple index is a second btree ordered by
 * one column and the row id. The schema btree on the header's schema root
 * lists both. CRUD still matches json-base: get, add, set, del, delAll.
 */
export class Store {
  private pager: Pager;

  private constructor(pager: Pager) {
    this.pager = pager;
  }

  static empty(): Store {
    return new Store(Pager.create());
  }

  static fromBytes(bytes: Buffer): Store {
    return new Store(Pager.open(bytes));
  }

  /** Open a json-base or older KinDB JSON document and copy it into pages. */
  static fromDocument(raw: unknown): Store {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new KinDbError('E_IO', 'A .db file must be a JSON object with a db field');
    }
    const document = raw as Record<string, unknown>;
    if ('kindb' in document && document.kindb !== KINDB_VERSION) {
      throw new KinDbError(
        'E_IO',
        `Unsupported .db version '${String(document.kindb)}'. This package reads kindb ${KINDB_VERSION}`,
      );
    }
    if (!('db' in document)) {
      throw new KinDbError('E_IO', 'A .db file must contain a db object');
    }
    const db = document.db;
    if (db === null || typeof db !== 'object' || Array.isArray(db)) {
      throw new KinDbError('E_IO', 'The db field must be an object of collections');
    }
    const store = Store.empty();
    for (const [name, rows] of Object.entries(db as Record<string, unknown>)) {
      assertCollectionName(name);
      if (!Array.isArray(rows)) {
        throw new KinDbError('E_IO', `Collection '${name}' must be an array of records`);
      }
      store.createCollection(name);
      rows.forEach((row, index) => {
        assertRow(row, `${name}[${index}]`);
        store.add(name, row);
      });
    }
    return store;
  }

  clone(): Store {
    return new Store(this.pager.snapshot());
  }

  toBytes(): Buffer {
    return this.pager.toBuffer();
  }

  /** Write changed pages. `full` replaces the file instead of patching it. */
  writeTo(filePath: string, full = false): void {
    this.pager.writeTo(filePath, full);
  }

  get pageCount(): number {
    return this.pager.pageCount;
  }

  get freelistCount(): number {
    return this.pager.freelistCount;
  }

  names(): string[] {
    return this.entries()
      .filter((entry): entry is TableEntry => entry.kind === 'table')
      .map((table) => table.name);
  }

  columnNames(name: string): string[] {
    return this.require(name).columns.map((column) => column.name);
  }

  /** Columns of `collection` that have a simple index, in creation order. */
  indexedColumns(collection: string): string[] {
    this.require(collection);
    return this.indexesOn(collection).map((index) => index.column);
  }

  createCollection(name: string, columns: ColumnDef[] = []): void {
    assertCollectionName(name);
    if (this.entries().some((entry) => entry.name === name)) {
      throw new KinDbError('E_COLLECTION_EXISTS', `Collection '${name}' already exists`);
    }
    const seen = new Set<string>();
    for (const column of columns) {
      assertCollectionName(column.name);
      if (seen.has(column.name)) {
        throw new KinDbError('E_TYPE', `Duplicate column '${column.name}'`);
      }
      seen.add(column.name);
    }
    const root = this.pager.allocate();
    this.pager.put(root, blankLeaf());
    const rowid = this.pager.schemaNext;
    this.pager.schemaNext = rowid + 1;
    this.insertCatalog({
      kind: 'table',
      rowid,
      name,
      root,
      nextRowid: 1,
      columns: columns.map((column) => ({ ...column })),
    });
  }

  /**
   * One column. Rows already in the table are indexed, and later writes keep
   * the index up to date. Two indexes on the same column are rejected.
   */
  createIndex(name: string, collection: string, column: string): void {
    assertCollectionName(name);
    assertCollectionName(column);
    if (this.entries().some((entry) => entry.name === name)) {
      throw new KinDbError('E_INDEX_EXISTS', `Name '${name}' is already in use`);
    }
    const table = this.require(collection);
    if (this.indexesOn(collection).some((index) => index.column === column)) {
      throw new KinDbError('E_INDEX_EXISTS', `An index on '${collection}.${column}' already exists`);
    }
    const root = this.pager.allocate();
    this.pager.put(root, blankIndexLeaf());
    const rowid = this.pager.schemaNext;
    this.pager.schemaNext = rowid + 1;
    const index: IndexEntry = { kind: 'index', rowid, name, root, source: collection, column };
    this.insertCatalog(index);
    scanUntil(this.pager, table.root, (record) => {
      const key = keyOf(decodeRecord(table.columns, record.payload), column);
      if (!key) return true;
      index.root = insertIndex(this.pager, index.root, key, record.rowid);
      return true;
    });
    this.saveCatalog(index);
  }

  dropIndex(name: string): void {
    assertCollectionName(name);
    const index = this.entries().find((entry) => entry.kind === 'index' && entry.name === name);
    if (!index || index.kind !== 'index') {
      throw new KinDbError('E_INDEX_MISSING', `Index '${name}' was not found`);
    }
    freeIndex(this.pager, index.root);
    this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, index.rowid);
  }

  dropCollection(name: string): void {
    const table = this.require(name);
    for (const index of this.indexesOn(name)) {
      freeIndex(this.pager, index.root);
      this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, index.rowid);
    }
    freeTree(this.pager, table.root);
    this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, table.rowid);
  }

  /** json-base delAll: every user relation and its indexes are removed. */
  delAll(): void {
    for (const entry of this.entries()) {
      if (entry.kind === 'index') freeIndex(this.pager, entry.root);
      else freeTree(this.pager, entry.root);
    }
    freeTree(this.pager, this.pager.schemaRoot);
    const root = this.pager.allocate();
    this.pager.put(root, blankLeaf());
    this.pager.schemaRoot = root;
    this.pager.schemaNext = 1;
  }

  add(collection: string, data: Row): Row {
    const table = this.require(collection);
    assertRow(data, 'data');
    const row = cloneJson(data);
    this.admitColumns(table, row);
    const rowid = table.nextRowid;
    table.nextRowid += 1;
    table.root = insertTree(this.pager, table.root, rowid, encodeRecord(table.columns, row));
    this.syncIndexes(table.name, rowid, null, row);
    this.saveCatalog(table);
    return row;
  }

  get(collection: string, where?: Where, limit?: number): Row[] {
    const predicates = where ? whereToPredicates(where) : [];
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new KinDbError('E_TYPE', 'Limit must be a non-negative integer');
    }
    if (limit === 0) return [];
    const table = this.require(collection);
    const access = planRead(
      predicates,
      this.indexesOn(table.name).map((index) => index.column),
      table.name,
    );
    if (access.kind === 'empty') return [];
    if (access.kind === 'point') {
      const matched: Row[] = [];
      this.visitPoint(table, access.column, access.key, (row) => {
        if (!matches(row, predicates)) return true;
        matched.push(row);
        return limit === undefined || matched.length < limit;
      });
      return matched;
    }
    if (access.kind === 'range') {
      const hits: Hit[] = [];
      this.visitRange(table, access.column, access.low, access.high, (row, rowid) => {
        hits.push({ row, rowid });
        return true;
      });
      hits.sort((a, b) => a.rowid - b.rowid);
      const matched: Row[] = [];
      for (const hit of hits) {
        if (!matches(hit.row, predicates)) continue;
        matched.push(hit.row);
        if (limit !== undefined && matched.length >= limit) break;
      }
      return matched;
    }
    const matched: Row[] = [];
    scanUntil(this.pager, table.root, (record) => {
      const row = decodeRecord(table.columns, record.payload);
      if (!matches(row, predicates)) return true;
      matched.push(row);
      return limit === undefined || matched.length < limit;
    });
    return matched;
  }

  set(collection: string, where: Where, data: Row): void {
    if (!where || Object.keys(where).length === 0) {
      throw new KinDbError('E_MISSING_PARAM', 'Missing parameter where');
    }
    assertRow(data, 'data');
    this.updateWhere(collection, whereToPredicates(where), data);
  }

  del(collection: string, where: Where): number {
    if (!where || Object.keys(where).length === 0) {
      throw new KinDbError('E_MISSING_PARAM', 'Missing parameter where');
    }
    return this.deleteWhere(collection, whereToPredicates(where));
  }

  rows(collection: string): Row[] {
    const table = this.require(collection);
    return scanTree(this.pager, table.root).map((record) =>
      decodeRecord(table.columns, record.payload),
    );
  }

  /** Walk rows in table order. `visit` returns false to stop. */
  forEach(collection: string, visit: (row: Row) => boolean): void {
    const table = this.require(collection);
    scanUntil(this.pager, table.root, (record) =>
      visit(decodeRecord(table.columns, record.payload)),
    );
  }

  /**
   * Rows whose indexed value encodes to `key`, in row id order.
   * `visit` returns false to stop.
   */
  probe(collection: string, column: string, key: Buffer, visit: (row: Row) => boolean): void {
    const table = this.require(collection);
    this.visitPoint(table, column, key, (row) => visit(row));
  }

  /**
   * Rows in an index range. Order is the index order, not row id order.
   * `visit` returns false to stop.
   */
  scanRange(
    collection: string,
    column: string,
    low: Bound | null,
    high: Bound | null,
    visit: (row: Row, rowid: number) => boolean,
  ): void {
    const table = this.require(collection);
    this.visitRange(table, column, low, high, visit);
  }

  filter(rows: Row[], predicates: Predicate[], limit?: number): Row[] {
    const matched = rows.filter((row) => matches(row, predicates)).map((row) => cloneJson(row));
    if (limit === undefined) return matched;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new KinDbError('E_TYPE', 'Limit must be a non-negative integer');
    }
    return matched.slice(0, limit);
  }

  deleteWhere(collection: string, predicates: Predicate[]): number {
    if (predicates.length === 0) {
      throw new KinDbError('E_MISSING_PARAM', 'Missing parameter where');
    }
    const table = this.require(collection);
    const hits = this.collectHits(table, predicates, undefined);
    if (hits.length === 0) {
      throw new KinDbError('E_NOT_FOUND', `No record in '${collection}' matched the where clause`);
    }
    for (const hit of hits) {
      this.syncIndexes(table.name, hit.rowid, hit.row, null);
      table.root = deleteTree(this.pager, table.root, hit.rowid);
    }
    this.saveCatalog(table);
    return hits.length;
  }

  updateWhere(collection: string, predicates: Predicate[], data: Row): number {
    if (predicates.length === 0) {
      throw new KinDbError('E_MISSING_PARAM', 'Missing parameter where');
    }
    const table = this.require(collection);
    // Two matches are enough: the update must be unique, so the scan stops there.
    const hits = this.collectHits(table, predicates, 2);
    if (hits.length === 0) {
      throw new KinDbError('E_NOT_FOUND', `No record in '${collection}' matched the where clause`);
    }
    if (hits.length > 1) {
      throw new KinDbError(
        'E_DUPLICATE',
        `More than one record in '${collection}' matched the where clause`,
      );
    }
    const current = hits[0].row;
    const merged = { ...current, ...cloneJson(data) };
    this.admitColumns(table, merged);
    this.syncIndexes(table.name, hits[0].rowid, current, merged);
    table.root = deleteTree(this.pager, table.root, hits[0].rowid);
    table.root = insertTree(
      this.pager,
      table.root,
      hits[0].rowid,
      encodeRecord(table.columns, merged),
    );
    this.saveCatalog(table);
    return 1;
  }

  private admitColumns(table: TableEntry, data: Row): void {
    for (const key of Object.keys(data)) {
      assertCollectionName(key);
      if (!table.columns.some((column) => column.name === key)) {
        table.columns.push({ name: key, type: 'any' });
      }
    }
    for (const column of table.columns) {
      if (column.name in data) assertValueType(column, data[column.name]);
    }
  }

  private require(name: string): TableEntry {
    assertCollectionName(name);
    const table = this.entries().find((entry) => entry.kind === 'table' && entry.name === name);
    if (!table || table.kind !== 'table') {
      throw new KinDbError('E_COLLECTION_MISSING', `Collection '${name}' was not found`);
    }
    return table;
  }

  private collectHits(
    table: TableEntry,
    predicates: Predicate[],
    stopAt: number | undefined,
  ): Hit[] {
    const access = planAccess(
      predicates,
      this.indexesOn(table.name).map((index) => index.column),
      table.name,
    );
    const hits: Hit[] = [];
    const push = (row: Row, rowid: number): boolean => {
      if (!matches(row, predicates)) return true;
      hits.push({ row, rowid });
      return stopAt === undefined || hits.length < stopAt;
    };
    if (access.kind === 'empty') return hits;
    if (access.kind === 'point') {
      this.visitPoint(table, access.column, access.key, push);
      return hits;
    }
    if (access.kind === 'range') {
      this.visitRange(table, access.column, access.low, access.high, push);
      return hits;
    }
    scanUntil(this.pager, table.root, (record) =>
      push(decodeRecord(table.columns, record.payload), record.rowid),
    );
    return hits;
  }

  private visitPoint(
    table: TableEntry,
    column: string,
    key: Buffer,
    visit: (row: Row, rowid: number) => boolean,
  ): void {
    const index = this.indexFor(table.name, column);
    scanIndex(this.pager, index.root, pointLow(key), pointHigh(key), (_found, rowid) => {
      const record = findTree(this.pager, table.root, rowid);
      if (!record) {
        throw new KinDbError('E_IO', `Index '${index.name}' points at a missing row`);
      }
      return visit(decodeRecord(table.columns, record.payload), record.rowid);
    });
  }

  private visitRange(
    table: TableEntry,
    column: string,
    low: Bound | null,
    high: Bound | null,
    visit: (row: Row, rowid: number) => boolean,
  ): void {
    const index = this.indexFor(table.name, column);
    scanIndex(this.pager, index.root, low, high, (_found, rowid) => {
      const record = findTree(this.pager, table.root, rowid);
      if (!record) {
        throw new KinDbError('E_IO', `Index '${index.name}' points at a missing row`);
      }
      return visit(decodeRecord(table.columns, record.payload), record.rowid);
    });
  }

  private syncIndexes(collection: string, rowid: number, previous: Row | null, next: Row | null): void {
    for (const index of this.indexesOn(collection)) {
      const before = previous ? keyOf(previous, index.column) : null;
      const after = next ? keyOf(next, index.column) : null;
      if (before && after && before.equals(after)) continue;
      const started = index.root;
      if (before) index.root = deleteIndex(this.pager, index.root, before, rowid);
      if (after) index.root = insertIndex(this.pager, index.root, after, rowid);
      if (index.root !== started) this.saveCatalog(index);
    }
  }

  private indexesOn(collection: string): IndexEntry[] {
    return this.entries().filter(
      (entry): entry is IndexEntry => entry.kind === 'index' && entry.source === collection,
    );
  }

  private indexFor(collection: string, column: string): IndexEntry {
    const index = this.indexesOn(collection).find((entry) => entry.column === column);
    if (!index) {
      throw new KinDbError('E_INDEX_MISSING', `No index on '${collection}.${column}'`);
    }
    return index;
  }

  private entries(): Entry[] {
    return scanTree(this.pager, this.pager.schemaRoot).map((record) => {
      const row = decodeRecord(CATALOG, record.payload);
      const name = String(row.name);
      const root = Number(row.root);
      if (row.kind === 'index') {
        if (typeof row.source !== 'string' || typeof row.column !== 'string') {
          throw new KinDbError('E_IO', `Index '${name}' is missing its table or column`);
        }
        return { kind: 'index', rowid: record.rowid, name, root, source: row.source, column: row.column };
      }
      const columns = JSON.parse(String(row.columns)) as ColumnDef[];
      return {
        kind: 'table',
        rowid: record.rowid,
        name,
        root,
        nextRowid: Number(row.nextRowid),
        columns,
      };
    });
  }

  private insertCatalog(entry: Entry): void {
    const payload = encodeRecord(CATALOG, catalogRow(entry));
    this.pager.schemaRoot = insertTree(this.pager, this.pager.schemaRoot, entry.rowid, payload);
  }

  private saveCatalog(entry: Entry): void {
    this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, entry.rowid);
    this.insertCatalog(entry);
  }
}

function keyOf(row: Row, column: string): Buffer | null {
  if (!(column in row)) return null;
  return encodeIndexKey(row[column]);
}

function catalogRow(entry: Entry): Row {
  if (entry.kind === 'index') {
    return {
      name: entry.name,
      root: entry.root,
      nextRowid: 0,
      columns: '[]',
      kind: 'index',
      source: entry.source,
      column: entry.column,
    };
  }
  return {
    name: entry.name,
    root: entry.root,
    nextRowid: entry.nextRowid,
    columns: JSON.stringify(entry.columns),
    kind: 'table',
  };
}
