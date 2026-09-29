import { KinDbError } from './errors';
import { deleteTree, freeTree, insertTree, scanTree } from './pager/btree';
import { blankLeaf } from './pager/format';
import { Pager } from './pager/pager';
import {
  assertValueType,
  decodeRecord,
  encodeRecord,
  type ColumnDef,
} from './pager/record';
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
];

interface Table {
  /** Rowid of this table inside the schema btree. */
  rowid: number;
  name: string;
  root: number;
  nextRowid: number;
  columns: ColumnDef[];
}

/**
 * Relations stored in a page file.
 * Each user table is a btree. The schema btree on the header's schema root
 * lists those tables. CRUD still matches json-base: get, add, set, del, delAll.
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
    return Store.fromBytes(this.toBytes());
  }

  toBytes(): Buffer {
    return this.pager.toBuffer();
  }

  get pageCount(): number {
    return this.pager.pageCount;
  }

  get freelistCount(): number {
    return this.pager.freelistCount;
  }

  names(): string[] {
    return this.catalog().map((table) => table.name);
  }

  columnNames(name: string): string[] {
    return this.require(name).columns.map((column) => column.name);
  }

  createCollection(name: string, columns: ColumnDef[] = []): void {
    assertCollectionName(name);
    if (this.find(name)) {
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
    this.insertCatalog({ rowid, name, root, nextRowid: 1, columns: columns.map((column) => ({ ...column })) });
  }

  dropCollection(name: string): void {
    const table = this.require(name);
    freeTree(this.pager, table.root);
    this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, table.rowid);
  }

  /** json-base delAll: every user relation is removed. */
  delAll(): void {
    for (const table of this.catalog()) freeTree(this.pager, table.root);
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
    this.saveCatalog(table);
    return row;
  }

  get(collection: string, where?: Where, limit?: number): Row[] {
    const predicates = where ? whereToPredicates(where) : [];
    return this.filter(this.rows(collection), predicates, limit);
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
    const hits = scanTree(this.pager, table.root).filter((record) =>
      matches(decodeRecord(table.columns, record.payload), predicates),
    );
    if (hits.length === 0) {
      throw new KinDbError('E_NOT_FOUND', `No record in '${collection}' matched the where clause`);
    }
    for (const hit of hits) {
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
    const records = scanTree(this.pager, table.root);
    const hits = records.filter((record) =>
      matches(decodeRecord(table.columns, record.payload), predicates),
    );
    if (hits.length === 0) {
      throw new KinDbError('E_NOT_FOUND', `No record in '${collection}' matched the where clause`);
    }
    if (hits.length > 1) {
      throw new KinDbError(
        'E_DUPLICATE',
        `More than one record in '${collection}' matched the where clause`,
      );
    }
    const current = decodeRecord(table.columns, hits[0].payload);
    const merged = { ...current, ...cloneJson(data) };
    this.admitColumns(table, merged);
    table.root = deleteTree(this.pager, table.root, hits[0].rowid);
    table.root = insertTree(this.pager, table.root, hits[0].rowid, encodeRecord(table.columns, merged));
    this.saveCatalog(table);
    return 1;
  }

  private admitColumns(table: Table, data: Row): void {
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

  private require(name: string): Table {
    assertCollectionName(name);
    const table = this.find(name);
    if (!table) throw new KinDbError('E_COLLECTION_MISSING', `Collection '${name}' was not found`);
    return table;
  }

  private find(name: string): Table | undefined {
    return this.catalog().find((table) => table.name === name);
  }

  private catalog(): Table[] {
    return scanTree(this.pager, this.pager.schemaRoot).map((record) => {
      const row = decodeRecord(CATALOG, record.payload);
      const columns = JSON.parse(String(row.columns)) as ColumnDef[];
      return {
        rowid: record.rowid,
        name: String(row.name),
        root: Number(row.root),
        nextRowid: Number(row.nextRowid),
        columns,
      };
    });
  }

  private insertCatalog(table: Table): void {
    const payload = encodeRecord(CATALOG, catalogRow(table));
    this.pager.schemaRoot = insertTree(this.pager, this.pager.schemaRoot, table.rowid, payload);
  }

  private saveCatalog(table: Table): void {
    this.pager.schemaRoot = deleteTree(this.pager, this.pager.schemaRoot, table.rowid);
    this.insertCatalog(table);
  }
}

function catalogRow(table: Table): Row {
  return {
    name: table.name,
    root: table.root,
    nextRowid: table.nextRowid,
    columns: JSON.stringify(table.columns),
  };
}
