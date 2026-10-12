import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KinDbError } from './errors';
import { executeStatements, type ExecuteResult } from './execute';
import { MAGIC } from './pager/format';
import { recoverDatabase } from './pager/journal';
import type { ColumnDef } from './pager/record';
import type { Statement } from './parser/ast';
import { parse } from './parser/parser';
import type { SqlParams } from './sql';
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
  execute(source: string, params?: SqlParams): ExecuteResult;
  /** Run a script whose last statement must be HITAMO. Returns those rows. */
  query(source: string, params?: SqlParams): Row[];
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
  /**
   * Refused on a transaction handle. The open transaction writes the file
   * when its callback returns.
   */
  save(filePath?: string): void;
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
    // A crash may have left a journal or a temporary file and no database yet.
    recoverDatabase(absolute);
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

  /** Rows decoded by get, query, and indexed probes on this database. */
  get rowsRead(): number {
    return this.store.rowsRead;
  }

  /** Schema walks. Inserts do not load the catalog again. */
  get catalogLoads(): number {
    return this.store.catalogLoads;
  }

  /** Index entries walked since this database was opened. */
  get indexVisits(): number {
    return this.store.indexVisits;
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
    const view = new TransactionSession(this);
    const snapshot = this.store.clone();
    this.transactionDepth += 1;
    let released = false;
    try {
      const value = body(view);
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
    } finally {
      view.closed = true;
    }
  }

  /**
   * Run Kinyarwanda SQL. A failure rolls the in-memory data back to the
   * state before this call, and does not write the `.db` file.
   * Inside {@link transaction}, the write waits for that callback to return.
   * `$name` placeholders read `params` instead of pasting text into the script.
   */
  execute(source: string, params?: SqlParams): ExecuteResult {
    return this.run(parse(source, params));
  }

  /**
   * Run a script made only of HITAMO and return the rows from the last one.
   * The script is checked before anything runs, so a write never starts.
   */
  query(source: string, params?: SqlParams): Row[] {
    const statements = parse(source, params);
    if (statements.length === 0 || statements.some((statement) => statement.kind !== 'select')) {
      throw new KinDbError(
        'E_TYPE',
        'query() only reads. Keep the script to HITAMO, and use execute() to write. Example: hitamo * muri abanyeshuri imipaka 10',
      );
    }
    const result = this.run(statements);
    if (result.last.kind !== 'select') {
      throw new KinDbError(
        'E_TYPE',
        'query() only reads. Keep the script to HITAMO, and use execute() to write. Example: hitamo * muri abanyeshuri imipaka 10',
      );
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
    this.change(() => {
      this.store.createCollection(name, columns);
    });
  }

  dropCollection(name: string): void {
    this.change(() => {
      this.store.dropCollection(name);
    });
  }

  add(params: { collection: string; data: Row }): Row {
    return this.change(() => this.store.add(params.collection, params.data));
  }

  get(params: { collection: string; where?: Where; limit?: number }): Row[] {
    return this.store.get(params.collection, params.where, params.limit);
  }

  set(params: { collection: string; where: Where; data: Row }): void {
    this.change(() => {
      this.store.set(params.collection, params.where, params.data);
    });
  }

  del(params: { collection: string; where: Where }): number {
    return this.change(() => this.store.del(params.collection, params.where));
  }

  delAll(): void {
    this.change(() => {
      this.store.delAll();
    });
  }

  /**
   * Apply one mutation and commit it.
   * A file commit that throws restores the pages from before the mutation,
   * so the open database still matches the previous file. Inside a
   * transaction the outer callback already holds that snapshot, and cloning
   * on every row would dominate a bulk load.
   */
  private change<T>(body: () => T): T {
    const undo = this.transactionDepth === 0 && this.filePath !== null ? this.store.clone() : null;
    try {
      const value = body();
      this.commit();
      return value;
    } catch (error) {
      if (undo) this.store = undo;
      throw error;
    }
  }

  private commit(): void {
    if (this.transactionDepth > 0) return;
    if (!this.filePath) return;
    this.store.writeTo(this.filePath, false);
  }

  private run(statements: Statement[]): ExecuteResult {
    const readOnly = statements.every((statement) => statement.kind === 'select');
    const snapshot = readOnly ? null : this.store.clone();
    try {
      const result = executeStatements(statements, this.store);
      // A read must not rewrite a JSON document or touch a page file.
      // The next save, or a script that writes, stores the pages.
      if (!readOnly) this.commit();
      return result;
    } catch (error) {
      if (snapshot) this.store = snapshot;
      throw error;
    }
  }
}

class TransactionSession implements Transaction {
  /** Set when the callback that created this handle has returned or thrown. */
  closed = false;

  constructor(private readonly db: Database) {}

  private guard(): void {
    if (this.closed) {
      throw new KinDbError(
        'E_TRANSACTION',
        'This transaction has finished. Call transaction() again to read or write.',
      );
    }
  }

  execute(source: string, params?: SqlParams): ExecuteResult {
    this.guard();
    return this.db.execute(source, params);
  }

  query(source: string, params?: SqlParams): Row[] {
    this.guard();
    return this.db.query(source, params);
  }

  collections(): string[] {
    this.guard();
    return this.db.collections();
  }

  createCollection(name: string, columns?: ColumnDef[]): void {
    this.guard();
    this.db.createCollection(name, columns);
  }

  dropCollection(name: string): void {
    this.guard();
    this.db.dropCollection(name);
  }

  add(params: { collection: string; data: Row }): Row {
    this.guard();
    return this.db.add(params);
  }

  get(params: { collection: string; where?: Where; limit?: number }): Row[] {
    this.guard();
    return this.db.get(params);
  }

  set(params: { collection: string; where: Where; data: Row }): void {
    this.guard();
    this.db.set(params);
  }

  del(params: { collection: string; where: Where }): number {
    this.guard();
    return this.db.del(params);
  }

  delAll(): void {
    this.guard();
    this.db.delAll();
  }

  transaction<T>(body: (tx: Transaction) => T): T {
    this.guard();
    return this.db.transaction(body);
  }

  save(filePath?: string): void {
    this.guard();
    this.db.save(filePath);
  }
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function readStore(filePath: string): Store {
  recoverDatabase(filePath);
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
