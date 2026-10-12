import { KinDbError } from './errors';
import { deleteTree, findTree, freeTree, highestRowid, insertTree, scanTree, scanUntil } from './pager/btree';
import { blankLeaf } from './pager/format';
import {
  decodeNumberKey,
  encodeIndexKey,
  numberDomainHigh,
  numberDomainLow,
  pointHigh,
  pointLow,
  type Bound,
} from './pager/index-key';
import {
  blankIndexLeaf,
  countEntries,
  deleteIndex,
  forEachOrdered,
  freeIndex,
  indexExtent,
  insertIndex,
  scanIndex,
  smallestRowid,
  warmIndexMins,
} from './pager/index-tree';
import { Pager } from './pager/pager';
import {
  assertValueType,
  decodeRecord,
  encodeRecord,
  type ColumnDef,
} from './pager/record';
import { accessForColumn, planAccess, type Access } from './relational/planner';
import { assertSqlName } from './sql';
import {
  assertCollectionName,
  assertLimit,
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
  /** User tables in creation order. The schema btree is read once, not on every row. */
  private tables = new Map<string, TableEntry>();
  private indexes = new Map<string, IndexEntry>();
  private indexesByTable = new Map<string, IndexEntry[]>();
  private catalogReady = false;
  private rowsReadCount = 0;
  private catalogLoadCount = 0;
  private indexVisitCount = 0;

  private constructor(pager: Pager) {
    this.pager = pager;
  }

  /** Rows decoded by reads, probes, and scans since this store was created. */
  get rowsRead(): number {
    return this.rowsReadCount;
  }

  /** How many times the schema btree was walked. Stays put across later inserts. */
  get catalogLoads(): number {
    return this.catalogLoadCount;
  }

  /** Index entries walked by a lookup or a range. A table walk leaves this unchanged. */
  get indexVisits(): number {
    return this.indexVisitCount;
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
    this.ensureCatalog();
    const copy = new Store(this.pager.snapshot());
    copy.catalogReady = true;
    copy.rowsReadCount = this.rowsReadCount;
    copy.catalogLoadCount = this.catalogLoadCount;
    copy.indexVisitCount = this.indexVisitCount;
    for (const [name, table] of this.tables) {
      copy.tables.set(name, {
        ...table,
        columns: table.columns.map((column) => ({ ...column })),
      });
    }
    for (const [name, index] of this.indexes) {
      const cloned = { ...index };
      copy.indexes.set(name, cloned);
      const list = copy.indexesByTable.get(index.source) ?? [];
      list.push(cloned);
      copy.indexesByTable.set(index.source, list);
    }
    return copy;
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
    this.ensureCatalog();
    return [...this.tables.keys()];
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
    assertSqlName(name, 'Collection name');
    this.ensureCatalog();
    if (this.tables.has(name) || this.indexes.has(name)) {
      throw new KinDbError('E_COLLECTION_EXISTS', `Collection '${name}' already exists`);
    }
    const seen = new Set<string>();
    for (const column of columns) {
      assertSqlName(column.name, 'Column name');
      if (seen.has(column.name)) {
        throw new KinDbError('E_TYPE', `Duplicate column '${column.name}'`);
      }
      seen.add(column.name);
    }
    const root = this.pager.allocate();
    this.pager.put(root, blankLeaf());
    const rowid = this.pager.schemaNext;
    this.pager.schemaNext = rowid + 1;
    const table: TableEntry = {
      kind: 'table',
      rowid,
      name,
      root,
      nextRowid: 1,
      columns: columns.map((column) => ({ ...column })),
    };
    this.insertCatalog(table);
    this.tables.set(name, table);
  }

  /**
   * One column. Rows already in the table are indexed, and later writes keep
   * the index up to date. Two indexes on the same column are rejected.
   */
  createIndex(name: string, collection: string, column: string): void {
    assertSqlName(name, 'Index name');
    assertSqlName(column, 'Column name');
    this.ensureCatalog();
    if (this.tables.has(name) || this.indexes.has(name)) {
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
    this.rememberIndex(index);
    const started = index.root;
    scanUntil(this.pager, table.root, (record) => {
      const key = keyOf(decodeRecord(table.columns, record.payload), column);
      if (!key) return true;
      index.root = insertIndex(this.pager, index.root, key, record.rowid);
      return true;
    });
    if (index.root !== started) this.saveCatalog(index);
  }

  dropIndex(name: string): void {
    assertCollectionName(name);
    this.ensureCatalog();
    const index = this.indexes.get(name);
    if (!index) {
      throw new KinDbError(
        'E_INDEX_MISSING',
        `Index '${name}' was not found. Create one with kora urutonde.`,
      );
    }
    freeIndex(this.pager, index.root);
    this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, index.rowid);
    this.forgetIndex(index);
  }

  dropCollection(name: string): void {
    const table = this.require(name);
    for (const index of [...this.indexesOn(name)]) {
      freeIndex(this.pager, index.root);
      this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, index.rowid);
      this.forgetIndex(index);
    }
    freeTree(this.pager, table.root);
    this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, table.rowid);
    this.tables.delete(name);
  }

  /** json-base delAll: every user relation and its indexes are removed. */
  delAll(): void {
    this.ensureCatalog();
    for (const index of this.indexes.values()) freeIndex(this.pager, index.root);
    for (const table of this.tables.values()) freeTree(this.pager, table.root);
    freeTree(this.pager, this.pager.schemaRoot);
    const root = this.pager.allocate();
    this.pager.put(root, blankLeaf());
    this.pager.schemaRoot = root;
    this.pager.schemaNext = 1;
    this.tables.clear();
    this.indexes.clear();
    this.indexesByTable.clear();
  }

  add(collection: string, data: Row): Row {
    const table = this.require(collection);
    assertRow(data, 'data');
    const row = cloneJson(data);
    const columnsBefore = table.columns.length;
    this.admitColumns(table, row);
    const rowid = table.nextRowid;
    table.nextRowid += 1;
    const rootBefore = table.root;
    table.root = insertTree(this.pager, table.root, rowid, encodeRecord(table.columns, row));
    this.syncIndexes(table.name, rowid, null, row);
    if (table.root !== rootBefore || table.columns.length !== columnsBefore) this.saveCatalog(table);
    return row;
  }

  get(collection: string, where?: Where, limit?: number): Row[] {
    const predicates = where ? whereToPredicates(where) : [];
    const matched: Row[] = [];
    this.read(collection, predicates, limit, (row) => {
      matched.push(row);
      return limit === undefined || matched.length < limit;
    });
    return matched;
  }

  /**
   * Read rows in stored order. A limit stops a table walk early.
   * A limited range on one indexed column asks that index for the next stored
   * row ids. A wide range with no limit still walks the table when the first
   * match is near the start.
   */
  read(
    collection: string,
    predicates: Predicate[],
    limit: number | undefined,
    visit: (row: Row, rowid: number) => boolean,
    qualifier?: string,
  ): void {
    assertLimit(limit);
    if (limit === 0) return;
    const table = this.require(collection);
    const name = qualifier ?? table.name;
    const access = planAccess(
      predicates,
      this.indexesOn(table.name).map((index) => index.column),
      name,
      (candidate) => this.estimateAccess(table, candidate),
    );
    if (access.kind === 'empty') return;
    if (access.kind === 'point') {
      this.visitPoint(table, access.column, access.key, (row, rowid) => {
        if (!matches(row, predicates)) return true;
        return visit(row, rowid);
      });
      return;
    }
    if (
      access.kind === 'range' &&
      limit !== undefined &&
      predicates.every((predicate) => predicate.field === access.column && !predicate.rightField)
    ) {
      this.readIndexedLimit(table, access, predicates, limit, visit);
      return;
    }
    if (access.kind === 'scan' || (access.kind === 'range' && this.preferScan(table, access, limit))) {
      scanUntil(this.pager, table.root, (record) => {
        const row = decodeRecord(table.columns, record.payload);
        this.touchRow();
        if (!matches(row, predicates)) return true;
        return visit(row, record.rowid);
      });
      return;
    }
    if (access.kind !== 'range') return;
    const rowids = this.rangeRowids(table, access.column, access.low, access.high);
    for (const rowid of rowids) {
      const record = findTree(this.pager, table.root, rowid);
      if (!record) {
        throw new KinDbError('E_IO', `Index on '${table.name}.${access.column}' points at a missing row`);
      }
      const row = decodeRecord(table.columns, record.payload);
      this.touchRow();
      if (!matches(row, predicates)) continue;
      if (!visit(row, record.rowid)) return;
    }
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
    this.read(collection, [], undefined, (row) => visit(row));
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
    assertLimit(limit);
    const matched = rows.filter((row) => matches(row, predicates)).map((row) => cloneJson(row));
    if (limit === undefined) return matched;
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
    const rootBefore = table.root;
    for (const hit of hits) {
      this.syncIndexes(table.name, hit.rowid, hit.row, null);
      table.root = deleteTree(this.pager, table.root, hit.rowid);
    }
    if (table.root !== rootBefore) this.saveCatalog(table);
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
    const columnsBefore = table.columns.length;
    const rootBefore = table.root;
    this.admitColumns(table, merged);
    this.syncIndexes(table.name, hits[0].rowid, current, merged);
    table.root = deleteTree(this.pager, table.root, hits[0].rowid);
    table.root = insertTree(
      this.pager,
      table.root,
      hits[0].rowid,
      encodeRecord(table.columns, merged),
    );
    if (table.root !== rootBefore || table.columns.length !== columnsBefore) this.saveCatalog(table);
    return 1;
  }

  private admitColumns(table: TableEntry, data: Row): void {
    // Check names and existing types before any column is added. A rejected
    // value must leave the catalog row unchanged, or the next save writes a
    // leaf the catalog cannot describe.
    for (const key of Object.keys(data)) {
      assertCollectionName(key);
      if (!table.columns.some((column) => column.name === key)) assertSqlName(key, 'Column name');
    }
    for (const column of table.columns) {
      if (column.name in data) assertValueType(column, data[column.name]);
    }
    for (const key of Object.keys(data)) {
      if (!table.columns.some((column) => column.name === key)) {
        table.columns.push({ name: key, type: 'any' });
      }
    }
  }

  private require(name: string): TableEntry {
    assertCollectionName(name);
    this.ensureCatalog();
    const table = this.tables.get(name);
    if (!table) {
      throw new KinDbError(
        'E_COLLECTION_MISSING',
        `Collection '${name}' was not found. Create it with kora itsinda ${name}`,
      );
    }
    return table;
  }

  private collectHits(
    table: TableEntry,
    predicates: Predicate[],
    stopAt: number | undefined,
  ): Hit[] {
    const hits: Hit[] = [];
    this.read(table.name, predicates, stopAt, (row, rowid) => {
      hits.push({ row, rowid });
      return stopAt === undefined || hits.length < stopAt;
    });
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
      this.indexVisitCount += 1;
      const record = findTree(this.pager, table.root, rowid);
      if (!record) {
        throw new KinDbError('E_IO', `Index '${index.name}' points at a missing row`);
      }
      const row = decodeRecord(table.columns, record.payload);
      this.touchRow();
      return visit(row, record.rowid);
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
      const row = decodeRecord(table.columns, record.payload);
      this.touchRow();
      return visit(row, record.rowid);
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
    this.ensureCatalog();
    return this.indexesByTable.get(collection) ?? [];
  }

  private indexFor(collection: string, column: string): IndexEntry {
    const index = this.indexesOn(collection).find((entry) => entry.column === column);
    if (!index) {
      throw new KinDbError('E_INDEX_MISSING', `No index on '${collection}.${column}'`);
    }
    return index;
  }

  /**
   * The next `limit` stored rows in an indexed range.
   * Each index page caches the smallest row id under it, so a limit reads a
   * few pages instead of every matching key.
   */
  private readIndexedLimit(
    table: TableEntry,
    access: Extract<Access, { kind: 'range' }>,
    predicates: Predicate[],
    limit: number,
    visit: (row: Row, rowid: number) => boolean,
  ): void {
    const index = this.indexFor(table.name, access.column);
    const low = access.low ?? numberDomainLow();
    const high = access.high ?? numberDomainHigh();
    let above = 0;
    let produced = 0;
    while (produced < limit) {
      const rowid = smallestRowid(this.pager, index.root, low, high, above, () => {
        this.indexVisitCount += 1;
      });
      if (rowid === null || rowid <= above) return;
      above = rowid;
      const record = findTree(this.pager, table.root, rowid);
      if (!record) {
        throw new KinDbError(
          'E_IO',
          `Index on '${table.name}.${access.column}' points at a missing row`,
        );
      }
      const row = decodeRecord(table.columns, record.payload);
      this.touchRow();
      if (!matches(row, predicates)) continue;
      produced += 1;
      if (!visit(row, record.rowid)) return;
    }
  }

  /**
   * Rows in `tondeka` order for one indexed number or boolean column.
   * Returns false when that order is not the index order, so the caller
   * sorts the filtered rows instead. A much smaller point on another
   * column is also left to the caller: sorting a handful of matches is
   * cheaper than walking the sort index until the rare row appears.
   */
  readOrdered(
    collection: string,
    predicates: Predicate[],
    column: string,
    direction: 'asc' | 'desc',
    limit: number,
    visit: (row: Row, rowid: number) => boolean,
    qualifier?: string,
  ): boolean {
    const table = this.require(collection);
    const defined = table.columns.find((entry) => entry.name === column);
    if (!defined || (defined.type !== 'number' && defined.type !== 'boolean')) return false;
    const index = this.indexesOn(table.name).find((entry) => entry.column === column);
    if (!index) return false;
    const name = qualifier ?? table.name;
    const total = countEntries(this.pager, index.root, null, null);
    if (this.cheaperPoint(table, predicates, column, name, total)) return false;
    const access = accessForColumn(predicates, column, name);
    if (access.kind === 'empty') return true;
    const domain = defined.type === 'number' ? numberWindow() : booleanWindow();
    let low = domain.low;
    let high = domain.high;
    if (access.kind === 'point') {
      low = pointLow(access.key);
      high = pointHigh(access.key);
    } else if (access.kind === 'range') {
      if (access.low) low = access.low;
      if (access.high) high = access.high;
    }
    // `ubusa` sorts last in both directions. When fewer than `limit` real
    // values exist, those nulls sit in this page of results and belong in
    // row id order with missing fields, which the full sort already does.
    const indexed = countEntries(this.pager, index.root, low, high);
    if (indexed < limit && nullSatisfies(predicates, column)) return false;
    let produced = 0;
    const emit = (_key: Buffer, rowid: number): boolean => {
      this.indexVisitCount += 1;
      const record = findTree(this.pager, table.root, rowid);
      if (!record) {
        throw new KinDbError('E_IO', `Index on '${table.name}.${column}' points at a missing row`);
      }
      const row = decodeRecord(table.columns, record.payload);
      this.touchRow();
      if (!matches(row, predicates)) return true;
      produced += 1;
      return visit(row, record.rowid) && produced < limit;
    };
    // Equal keys stay in row id order for both directions.
    const orderedDirection = access.kind === 'point' ? 'asc' : direction;
    forEachOrdered(this.pager, index.root, orderedDirection, low, high, emit);
    return true;
  }

  /** True when another indexed point matches far fewer rows than this index. */
  private cheaperPoint(
    table: TableEntry,
    predicates: Predicate[],
    sortColumn: string,
    qualifier: string,
    sortEntries: number,
  ): boolean {
    let best: number | null = null;
    for (const index of this.indexesOn(table.name)) {
      if (index.column === sortColumn) continue;
      const access = accessForColumn(predicates, index.column, qualifier);
      if (access.kind !== 'point') continue;
      const count = countEntries(this.pager, index.root, pointLow(access.key), pointHigh(access.key));
      if (best === null || count < best) best = count;
    }
    return best !== null && best * 4 < sortEntries;
  }

  private estimateAccess(table: TableEntry, access: Access): number {
    if (access.kind !== 'point' && access.kind !== 'range') return Number.POSITIVE_INFINITY;
    const index = this.indexFor(table.name, access.column);
    if (access.kind === 'point') {
      return countEntries(this.pager, index.root, pointLow(access.key), pointHigh(access.key));
    }
    return countEntries(this.pager, index.root, access.low, access.high);
  }

  private ensureCatalog(): void {
    if (this.catalogReady) return;
    this.catalogLoadCount += 1;
    this.catalogReady = true;
    for (const record of scanTree(this.pager, this.pager.schemaRoot)) {
      const row = decodeRecord(CATALOG, record.payload);
      const name = String(row.name);
      const root = Number(row.root);
      if (row.kind === 'index') {
        if (typeof row.source !== 'string' || typeof row.column !== 'string') {
          throw new KinDbError('E_IO', `Index '${name}' is missing its table or column`);
        }
        this.rememberIndex({
          kind: 'index',
          rowid: record.rowid,
          name,
          root,
          source: row.source,
          column: row.column,
        });
        continue;
      }
      const columns = JSON.parse(String(row.columns)) as ColumnDef[];
      const storedNext = Number(row.nextRowid);
      const liveNext = highestRowid(this.pager, root) + 1;
      this.tables.set(name, {
        kind: 'table',
        rowid: record.rowid,
        name,
        root,
        nextRowid: Math.max(storedNext, liveNext),
        columns,
      });
    }
    for (const index of this.indexes.values()) warmIndexMins(this.pager, index.root);
  }

  private rememberIndex(index: IndexEntry): void {
    this.indexes.set(index.name, index);
    const list = this.indexesByTable.get(index.source) ?? [];
    list.push(index);
    this.indexesByTable.set(index.source, list);
  }

  private forgetIndex(index: IndexEntry): void {
    this.indexes.delete(index.name);
    const list = this.indexesByTable.get(index.source) ?? [];
    this.indexesByTable.set(
      index.source,
      list.filter((entry) => entry.name !== index.name),
    );
  }

  private touchRow(): void {
    this.rowsReadCount += 1;
  }

  /**
   * A wide numeric slice matches most of the table, so a stored-order walk
   * is cheaper and can stop at a limit. A short slice stays on the index.
   */
  /**
   * Walk the table when the first match is near the start, so a limit can stop.
   * `leadingGap` is how much of the key space sits below the range. Once that
   * prefix is half the index or more, reading the table means skipping rows
   * that cannot match, and the index is the shorter walk.
   */
  private preferScan(table: TableEntry, access: Extract<Access, { kind: 'range' }>, limit: number | undefined): boolean {
    const gap = this.leadingGap(table, access);
    if (limit !== undefined) return gap < 0.5;
    if (gap >= 0.5) return false;
    if (!access.bothSides) return true;
    return this.rangeIsWide(table, access);
  }

  /** Fraction of the indexed number span that is strictly below this range. */
  private leadingGap(table: TableEntry, access: Extract<Access, { kind: 'range' }>): number {
    const index = this.indexFor(table.name, access.column);
    const extent = indexExtent(this.pager, index.root);
    if (!extent) return 0;
    const min = decodeNumberKey(extent.min);
    const max = decodeNumberKey(extent.max);
    // A numeric bound does not describe string or boolean keys.
    if (min === null || max === null) return 1;
    if (!access.low) return 0;
    const low = decodeNumberKey(access.low.key);
    if (low === null) return 1;
    if (low < min || (low === min && access.low.inclusive)) return 0;
    if (low === min) return max === min ? 1 : 0;
    if (max === min) return 1;
    return Math.min(1, (low - min) / (max - min));
  }

  private rangeIsWide(table: TableEntry, access: Extract<Access, { kind: 'range' }>): boolean {
    const index = this.indexFor(table.name, access.column);
    const extent = indexExtent(this.pager, index.root);
    if (!extent) return true;
    const min = decodeNumberKey(extent.min);
    const max = decodeNumberKey(extent.max);
    if (min === null || max === null || max === min) return false;
    const low = access.low ? decodeNumberKey(access.low.key) : min;
    const high = access.high ? decodeNumberKey(access.high.key) : max;
    if (low === null || high === null) return false;
    return Math.max(0, high - low) / (max - min) > 0.3;
  }

  private rangeRowids(
    table: TableEntry,
    column: string,
    low: Bound | null,
    high: Bound | null,
  ): number[] {
    const index = this.indexFor(table.name, column);
    const rowids: number[] = [];
    scanIndex(
      this.pager,
      index.root,
      low ?? numberDomainLow(),
      high ?? numberDomainHigh(),
      (_key, rowid) => {
        rowids.push(rowid);
        this.indexVisitCount += 1;
        return true;
      },
    );
    rowids.sort((a, b) => a - b);
    return rowids;
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

function numberWindow(): { low: Bound; high: Bound } {
  return { low: numberDomainLow(), high: numberDomainHigh() };
}

function booleanWindow(): { low: Bound; high: Bound } {
  const lowKey = encodeIndexKey(false);
  const highKey = encodeIndexKey(true);
  if (!lowKey || !highKey) throw new KinDbError('E_IO', 'A boolean index key could not be built');
  return { low: pointLow(lowKey), high: pointHigh(highKey) };
}

/** `ubusa` sorts last. A comparison that rejects it must not append those rows. */
function nullSatisfies(predicates: Predicate[], column: string): boolean {
  const relevant = predicates.filter((predicate) => predicate.field === column && !predicate.rightField);
  return matches({ [column]: null }, relevant);
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
