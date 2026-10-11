import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KinDbError } from './errors';
import { executeSource, type ExecuteResult } from './execute';
import { MAGIC } from './pager/format';
import type { ColumnDef } from './pager/record';
import { Store } from './store';
import type { Row, Where } from './value';

export interface OpenOptions {
  /** Create an empty .db file when the path is missing. */
  create?: boolean;
}

export interface RunFileOptions {
  /** .db file to load and save. Omit to run purely in memory. */
  db?: string;
  /** Create the .db file when it does not exist. Defaults to true when db is set. */
  create?: boolean;
}

/**
 * The database handle passed to {@link Database.transaction}.
 * Its methods are the same mutations as {@link Database}, but they do not
 * write the file. The open transaction writes once, when its callback returns.
 */
export interface Transaction {
  execute(source: string): ExecuteResult;
  /** Run a script whose last statement must be HITAMO. Returns those rows. */
  query(source: string): Row[];
  collections(): string[];
  createCollection(name: string, columns?: ColumnDef[]): void;
  dropCollection(name: string): void;
  add(params: { collection: string; data: Row }): Row;
  get(params: { collection: string; where?: Where; limit?: number }): Row[];
  set(params: { collection: string; where: Where; data: Row }): void;
  del(params: { collection: string; where: Where }): number;
  delAll(): void;
  /**
   * A nested transaction is a savepoint. It does not write the file.
   * A throw restores only the changes made inside this callback.
   */
  transaction<T>(body: (tx: Transaction) => T): T;
}

/**
 * In-memory relational database that can be tied to a `.db` page file.
 * Kinyarwanda SQL is executed with {@link Database.execute}. The same data
 * is available through get / add / set / del / delAll.
 */
export class Database {
  private store: Store;
  private filePath: string | null;
  /** Open transaction callbacks. Mutations skip the file until the outermost one returns. */
  private transactionDepth = 0;

  private constructor(store: Store, filePath: string | null) {
    this.store = store;
    this.filePath = filePath;
  }

  /** A database that is never written unless {@link Database.save} is called. */
  static memory(): Database {
    return new Database(Store.empty(), null);
  }

  /** Load a `.db` file into memory. Later mutations are written back. */
  static open(filePath: string, options: OpenOptions = {}): Database {
    const absolute = resolve(filePath);
    if (!existsSync(absolute)) {
      if (!options.create) {
        throw new KinDbError('E_IO', `Database file not found: ${absolute}`);
      }
      const created = new Database(Store.empty(), absolute);
      created.commit();
      return created;
    }
    return new Database(readStore(absolute), absolute);
  }

  /**
   * Run a `.kindb` script.
   * When `db` is set, that file is loaded first and saved after a successful run.
   */
  static runFile(kindbPath: string, options: RunFileOptions = {}): ExecuteResult {
    const source = readText(resolve(kindbPath));
    const database = options.db
      ? Database.open(options.db, { create: options.create ?? true })
      : Database.memory();
    return database.execute(source);
  }

  /** Absolute path of the bound `.db` file, or null for a pure memory database. */
  get path(): string | null {
    return this.filePath;
  }

  /**
   * Run `body` as one transaction.
   *
   * `add`, `set`, `del`, and the other mutating methods change memory only
   * while `body` is running, whether they are called on `tx` or on this
   * database. They do not each write the file. The file is written once
   * when the outermost callback returns. A throw restores the pages from
   * the start of this callback and does not write.
   *
   * The callback must finish synchronously. A nested {@link transaction}
   * is a savepoint: catching its error keeps the outer changes.
   */
  transaction<T>(body: (tx: Transaction) => T): T {
    if (typeof body !== 'function') {
      throw new KinDbError('E_TYPE', 'transaction() expects a function');
    }
    const snapshot = this.store.clone();
    this.transactionDepth += 1;
    let released = false;
    try {
      const value = body(transactionView(this));
      if (isThenable(value)) {
        throw new KinDbError(
          'E_TRANSACTION',
          'transaction() callback must finish synchronously',
        );
      }
      this.transactionDepth -= 1;
      released = true;
      if (this.transactionDepth === 0) this.commit();
      return value;
    } catch (error) {
      this.store = snapshot;
      if (!released) this.transactionDepth -= 1;
      throw error;
    }
  }

  /**
   * Run Kinyarwanda SQL. A failure rolls the in-memory data back to the
   * state before this call, and does not write the `.db` file.
   * Inside {@link transaction}, the write waits for that callback to return.
   */
  execute(source: string): ExecuteResult {
    const snapshot = this.store.clone();
    try {
      const result = executeSource(source, this.store);
      this.commit();
      return result;
    } catch (error) {
      this.store = snapshot;
      throw error;
    }
  }

  /** Run a script whose last statement must be HITAMO. Returns those rows. */
  query(source: string): Row[] {
    const result = this.execute(source);
    if (result.last.kind !== 'select') {
      throw new KinDbError('E_TYPE', 'query() expects the last statement to be HITAMO');
    }
    return result.last.rows;
  }

  /** Write the `.db` file. Passing a path binds future saves to that file. */
  save(filePath?: string): void {
    if (this.transactionDepth > 0) {
      throw new KinDbError(
        'E_TRANSACTION',
        'save() cannot run inside a transaction. The transaction writes the file when the callback returns',
      );
    }
    if (filePath) {
      const next = resolve(filePath);
      const full = next !== this.filePath;
      this.filePath = next;
      this.store.writeTo(this.filePath, full);
      return;
    }
    if (!this.filePath) {
      throw new KinDbError('E_IO', 'save() needs a file path for a memory database');
    }
    this.commit();
  }

  collections(): string[] {
    return this.store.names();
  }

  createCollection(name: string, columns?: ColumnDef[]): void {
    this.store.createCollection(name, columns);
    this.commit();
  }

  dropCollection(name: string): void {
    this.store.dropCollection(name);
    this.commit();
  }

  add(params: { collection: string; data: Row }): Row {
    const row = this.store.add(params.collection, params.data);
    this.commit();
    return row;
  }

  get(params: { collection: string; where?: Where; limit?: number }): Row[] {
    return this.store.get(params.collection, params.where, params.limit);
  }

  set(params: { collection: string; where: Where; data: Row }): void {
    this.store.set(params.collection, params.where, params.data);
    this.commit();
  }

  del(params: { collection: string; where: Where }): number {
    const removed = this.store.del(params.collection, params.where);
    this.commit();
    return removed;
  }

  delAll(): void {
    this.store.delAll();
    this.commit();
  }

  private commit(): void {
    if (this.transactionDepth > 0) return;
    if (!this.filePath) return;
    this.store.writeTo(this.filePath, false);
  }
}

function transactionView(db: Database): Transaction {
  return {
    execute: (source) => db.execute(source),
    query: (source) => db.query(source),
    collections: () => db.collections(),
    createCollection: (name, columns) => db.createCollection(name, columns),
    dropCollection: (name) => db.dropCollection(name),
    add: (params) => db.add(params),
    get: (params) => db.get(params),
    set: (params) => db.set(params),
    del: (params) => db.del(params),
    delAll: () => db.delAll(),
    transaction: (body) => db.transaction(body),
  };
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function readStore(filePath: string): Store {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KinDbError('E_IO', message);
  }
  if (bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    return Store.fromBytes(bytes);
  }
  // Older KinDB documents and json-base files are JSON objects.
  if (bytes[0] === 0x7b) {
    try {
      return Store.fromDocument(JSON.parse(bytes.toString('utf8')) as unknown);
    } catch (error) {
      if (error instanceof KinDbError) throw error;
      throw new KinDbError('E_IO', `Database file is not valid JSON: ${filePath}`);
    }
  }
  throw new KinDbError('E_IO', `Database file is not a KinDB page file: ${filePath}`);
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new KinDbError('E_IO', message);
  }
}
