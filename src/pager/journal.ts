import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { threadId } from 'node:worker_threads';
import { KinDbError } from '../errors';
import { MAGIC, PAGE_SIZE } from './format';

const LOCK_MAGIC = 'KinDB lock v1\n';

const JOURNAL_MAGIC = Buffer.alloc(16);
Buffer.from('KinDB undo v1').copy(JOURNAL_MAGIC);
const COMMIT_MARK = 0x434f4d54;
const HEADER = 24;

type Fault = 'after-journal' | 'during-pages' | null;

let fault: Fault = null;
let patchedBytes = 0;

/** Test hook. The next file commit throws at that point and leaves the previous file recoverable. */
export function setWriteFault(next: Fault): void {
  fault = next;
}

export function resetWriteMeter(): void {
  patchedBytes = 0;
}

/** Bytes written into database files since the last {@link resetWriteMeter}. */
export function writeMeter(): number {
  return patchedBytes;
}

/**
 * Publish `pages` while this process holds the file lock.
 * A patch journals the old pages, fsyncs that journal, writes the new pages,
 * fsyncs the database, then deletes the journal. A full rewrite goes to a
 * temporary file and is renamed into place.
 * The freshness check runs under that lock. A second session cannot pass
 * the check and then write over a commit it did not see.
 */
export function commitPages(
  filePath: string,
  pages: Buffer[],
  dirty: ReadonlySet<number>,
  full: boolean,
  baseCounter: number,
): void {
  withLock(filePath, () => {
    recoverUnlocked(filePath);
    const plan = planCommit(filePath, pages, dirty, full, baseCounter);
    if (plan.kind === 'skip') return;
    if (plan.kind === 'replace') replaceAll(filePath, pages);
    else patch(filePath, pages, plan.dirty);
  });
}

/** Roll back a commit that crashed, then drop leftover partial files. */
export function recoverDatabase(filePath: string): void {
  const tmp = `${filePath}.tmp`;
  if (
    !existsSync(filePath) &&
    !existsSync(journalPath(filePath)) &&
    !existsSync(partialPath(filePath)) &&
    !existsSync(tmp)
  ) {
    return;
  }
  withLock(filePath, () => {
    recoverUnlocked(filePath);
  });
}

/**
 * Choose replace, patch, or skip from the bytes currently on disk.
 * Caller holds the lock and has already rolled back a torn commit.
 */
function planCommit(
  filePath: string,
  pages: Buffer[],
  dirty: ReadonlySet<number>,
  full: boolean,
  baseCounter: number,
): { kind: 'skip' } | { kind: 'replace' } | { kind: 'patch'; dirty: Set<number> } {
  const bytes = pages.length * PAGE_SIZE;
  if (full || !existsSync(filePath)) return { kind: 'replace' };
  const size = statSync(filePath).size;
  const pageFile = size % PAGE_SIZE === 0 && hasPageMagic(filePath, size);
  if (!pageFile) return { kind: 'replace' };
  if (size > bytes || readChangeCounter(filePath) !== baseCounter) {
    throw new KinDbError(
      'E_IO',
      'This database was saved by another session. Open the file again before writing.',
    );
  }
  if (dirty.size === 0 && size === bytes) return { kind: 'skip' };
  const next = new Set(dirty);
  const firstMissing = size / PAGE_SIZE + 1;
  for (let pageNumber = firstMissing; pageNumber <= pages.length; pageNumber += 1) {
    next.add(pageNumber);
  }
  return { kind: 'patch', dirty: next };
}

function readChangeCounter(filePath: string): number | null {
  if (!existsSync(filePath) || statSync(filePath).size < 44) return null;
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    const got = readSync(fd, buf, 0, 4, 40);
    if (got !== 4) return null;
    return buf.readUInt32BE(0);
  } finally {
    closeSync(fd);
  }
}

function hasPageMagic(filePath: string, size: number): boolean {
  if (size < MAGIC.length) return false;
  const fd = openSync(filePath, 'r');
  try {
    const magic = Buffer.alloc(MAGIC.length);
    const read = readSync(fd, magic, 0, MAGIC.length, 0);
    return read === MAGIC.length && magic.equals(MAGIC);
  } finally {
    closeSync(fd);
  }
}

function patch(filePath: string, pages: Buffer[], dirty: ReadonlySet<number>): void {
  if (dirty.size === 0) return;
  const originalSize = existsSync(filePath) ? statSync(filePath).size : 0;
  const oldPages: { pageNumber: number; bytes: Buffer }[] = [];
  const readFd = existsSync(filePath) ? openSync(filePath, 'r') : 0;
  try {
    for (const pageNumber of dirty) {
      const offset = (pageNumber - 1) * PAGE_SIZE;
      if (offset < 0 || offset + PAGE_SIZE > originalSize) continue;
      const bytes = Buffer.alloc(PAGE_SIZE);
      const got = readSync(readFd, bytes, 0, PAGE_SIZE, offset);
      if (got !== PAGE_SIZE) {
        throw new KinDbError('E_IO', 'Could not read the page that a save was about to replace');
      }
      oldPages.push({ pageNumber, bytes });
    }
  } finally {
    if (readFd !== 0) closeSync(readFd);
  }

  const body = Buffer.alloc(HEADER + oldPages.length * (4 + PAGE_SIZE) + 4);
  JOURNAL_MAGIC.copy(body, 0);
  body.writeUInt32BE(originalSize, 16);
  body.writeUInt32BE(oldPages.length, 20);
  let cursor = HEADER;
  for (const page of oldPages) {
    body.writeUInt32BE(page.pageNumber, cursor);
    page.bytes.copy(body, cursor + 4);
    cursor += 4 + PAGE_SIZE;
  }
  body.writeUInt32BE(COMMIT_MARK, cursor);

  const partial = partialPath(filePath);
  const journal = journalPath(filePath);
  writeDurable(partial, body);
  try {
    renameSync(partial, journal);
  } catch (error) {
    unlinkQuiet(partial);
    throw ioError(error);
  }
  fsyncDir(filePath);
  if (fault === 'after-journal') failInterrupted();

  const fd = openSync(filePath, existsSync(filePath) ? 'r+' : 'w+');
  let opened = true;
  let published = false;
  try {
    let wrote = 0;
    for (const pageNumber of dirty) {
      const page = pages[pageNumber - 1];
      if (!page) throw new KinDbError('E_IO', `Page ${pageNumber} is missing from the save`);
      writeFully(fd, page, (pageNumber - 1) * PAGE_SIZE);
      patchedBytes += PAGE_SIZE;
      wrote += 1;
      if (fault === 'during-pages' && wrote === 1) failInterrupted();
    }
    fsyncSync(fd);
    closeSync(fd);
    opened = false;
    published = true;
    unlinkIfPresent(journal);
    fsyncDir(filePath);
  } catch (error) {
    if (opened) closeSync(fd);
    // A thrown save must put the previous pages back before the lock is released.
    // Otherwise the first dirty page stays on disk under the old change counter.
    if (!published) {
      try {
        recoverUnlocked(filePath);
      } catch (restoreError) {
        throw ioError(restoreError);
      }
    }
    throw error instanceof KinDbError ? error : ioError(error);
  }
}

function replaceAll(filePath: string, pages: Buffer[]): void {
  const bytes = Buffer.concat(pages);
  const tmp = `${filePath}.tmp`;
  writeDurable(tmp, bytes);
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    throw ioError(error);
  }
  fsyncDir(filePath);
  patchedBytes += bytes.length;
  unlinkIfPresent(journalPath(filePath));
  unlinkIfPresent(partialPath(filePath));
}

function recoverUnlocked(filePath: string): void {
  const partial = partialPath(filePath);
  if (existsSync(partial)) unlinkSync(partial);
  const tmp = `${filePath}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  clearLockTemps(filePath);
  const journal = journalPath(filePath);
  if (!existsSync(journal)) return;
  const bytes = readWhole(journal);
  if (!journalComplete(bytes)) {
    unlinkSync(journal);
    return;
  }
  const originalSize = bytes.readUInt32BE(16);
  const count = bytes.readUInt32BE(20);
  const fd = openSync(filePath, existsSync(filePath) ? 'r+' : 'w+');
  try {
    let cursor = HEADER;
    for (let i = 0; i < count; i += 1) {
      const pageNumber = bytes.readUInt32BE(cursor);
      const page = bytes.subarray(cursor + 4, cursor + 4 + PAGE_SIZE);
      writeFully(fd, page, (pageNumber - 1) * PAGE_SIZE);
      cursor += 4 + PAGE_SIZE;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const truncated = openSync(filePath, 'r+');
  try {
    ftruncateSync(truncated, originalSize);
    fsyncSync(truncated);
  } finally {
    closeSync(truncated);
  }
  unlinkIfPresent(journal);
  fsyncDir(filePath);
}

function journalComplete(bytes: Buffer): boolean {
  if (bytes.length < HEADER + 4 || !bytes.subarray(0, 16).equals(JOURNAL_MAGIC)) return false;
  const count = bytes.readUInt32BE(20);
  const expected = HEADER + count * (4 + PAGE_SIZE) + 4;
  if (bytes.length !== expected) return false;
  return bytes.readUInt32BE(expected - 4) === COMMIT_MARK;
}

/** Write every byte. A short `writeSync` used to return success and leave a torn page. */
function writeFully(fd: number, buffer: Buffer, position?: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const wrote =
      position === undefined
        ? writeSync(fd, buffer, offset)
        : writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (wrote <= 0) failInterrupted();
    offset += wrote;
  }
}

function writeDurable(filePath: string, bytes: Buffer): void {
  const fd = openSync(filePath, 'w');
  try {
    writeFully(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (existsSync(filePath)) unlinkSync(filePath);
    throw ioError(error);
  }
  closeSync(fd);
}

function readWhole(filePath: string): Buffer {
  const size = statSync(filePath).size;
  const bytes = Buffer.alloc(size);
  const fd = openSync(filePath, 'r');
  try {
    const got = readSync(fd, bytes, 0, size, 0);
    if (got !== size) throw new KinDbError('E_IO', 'Could not read the save journal');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

interface HeldLock {
  fd: number;
  lock: string;
}

function withLock(filePath: string, body: () => void): void {
  const held = acquire(`${filePath}.lock`);
  try {
    body();
  } finally {
    release(held);
  }
}

/**
 * Publish the lock only after its bytes and an open descriptor exist.
 * An empty lock used to be stolen by a second saver. A descriptor that
 * is still open means the saver is alive, including another thread in
 * this process. `worker.terminate()` closes that descriptor, so a torn
 * save can be restored while the process itself is still alive.
 * A lock that is only a pid, with no open descriptor, is stolen only
 * when that pid does not exist. `EPERM` means the pid is alive.
 */
function acquire(lock: string): HeldLock {
  const started = Date.now();
  for (;;) {
    const created = tryCreate(lock);
    if (created) return created;
    const owner = readOwner(lock);
    if (owner && ownerLive(owner, lock)) {
      if (Date.now() - started > 1000) {
        throw new KinDbError(
          'E_IO',
          `This database is being saved by process ${owner.pid}. Close that session, then try again.`,
        );
      }
      // A commit holds the lock for one fsync. Another saver waits that out.
      pause(10);
      continue;
    }
    if (owner === null && lockSize(lock) === 0) unlinkQuiet(lock);
    else if (owner) unlinkQuiet(lock);
    else pause(5);
    if (Date.now() - started > 1000) break;
  }
  const created = tryCreate(lock);
  if (created) return created;
  throw new KinDbError('E_IO', 'Could not lock the database file for a save. Try the command again.');
}

function lockSize(lock: string): number {
  try {
    return statSync(lock).size;
  } catch {
    return -1;
  }
}

function tryCreate(lock: string): HeldLock | null {
  const nonce = randomBytes(8).toString('hex');
  const temp = `${lock}.${process.pid}.${nonce}`;
  const body = Buffer.from(`${LOCK_MAGIC}${process.pid}\n${threadId}\n${nonce}\n`);
  let fd = -1;
  try {
    fd = openSync(temp, 'wx');
  } catch (error) {
    // A leftover temp name is not the lock. The next attempt uses a new nonce.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw ioError(error);
  }
  try {
    writeFully(fd, body);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkQuiet(temp);
    throw ioError(error);
  }
  try {
    linkSync(temp, lock);
  } catch (error) {
    closeSync(fd);
    unlinkQuiet(temp);
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST: someone else published the lock. ENOENT: our temp was cleared.
    if (code === 'EEXIST' || code === 'ENOENT') return null;
    throw ioError(error);
  }
  unlinkQuiet(temp);
  return { fd, lock };
}

function release(held: HeldLock): void {
  try {
    const mine = fstatSync(held.fd);
    const current = statSync(held.lock);
    if (mine.dev === current.dev && mine.ino === current.ino) unlinkSync(held.lock);
  } catch {
    /* a crash leaves the lock, and the next open clears it when the descriptor is gone */
  }
  try {
    closeSync(held.fd);
  } catch {
    /* already closed */
  }
}

interface LockOwner {
  kind: 'legacy' | 'held';
  pid: number;
}

function readOwner(lock: string): LockOwner | null {
  let text: string;
  try {
    text = readWhole(lock).toString('utf8');
  } catch {
    return null;
  }
  if (text.startsWith(LOCK_MAGIC)) {
    const pid = Number(text.split('\n')[1]);
    return Number.isInteger(pid) && pid > 0 ? { kind: 'held', pid } : null;
  }
  if (text.length === 0) return null;
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? { kind: 'legacy', pid } : null;
}

/** True when this saver should be left alone. */
function ownerLive(owner: LockOwner, lock: string): boolean {
  if (!alive(owner.pid)) return false;
  // A planted pid file has no descriptor. EPERM still means that pid exists.
  if (owner.kind === 'legacy') return true;
  // Another live process keeps the lock. Guessing from lsof was racing the commit
  // and deleting its journal out from under the rename.
  if (owner.pid !== process.pid) return true;
  return processHoldsLock(owner.pid, lock);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processHoldsLock(pid: number, lock: string): boolean {
  let fileStat: ReturnType<typeof statSync>;
  try {
    fileStat = statSync(lock);
  } catch {
    return false;
  }
  if (pid === process.pid) return selfHoldsInode(fileStat.dev, fileStat.ino);
  const proc = `/proc/${pid}/fd`;
  if (existsSync(proc)) return procHoldsInode(proc, fileStat.dev, fileStat.ino);
  return lsofHoldsInode(pid, fileStat.ino);
}

function selfHoldsInode(dev: number, ino: number): boolean {
  let names: string[];
  try {
    names = readdirSync('/dev/fd');
  } catch {
    return true;
  }
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd)) continue;
    try {
      const stat = fstatSync(fd);
      if (stat.dev === dev && stat.ino === ino) return true;
    } catch {
      /* the descriptor closed while we looked */
    }
  }
  return false;
}

function procHoldsInode(dir: string, dev: number, ino: number): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return true;
  }
  for (const name of names) {
    try {
      const stat = statSync(`${dir}/${name}`);
      if (stat.dev === dev && stat.ino === ino) return true;
    } catch {
      /* gone */
    }
  }
  return false;
}

function lsofHoldsInode(pid: number, ino: number): boolean {
  const result = spawnSync('lsof', ['-n', '-P', '-a', '-p', String(pid), '-F', 'i'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return true;
  const needle = `i${ino}`;
  return result.stdout.split('\n').includes(needle);
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function unlinkIfPresent(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw ioError(error);
  }
}

function clearLockTemps(filePath: string): void {
  const dir = dirname(filePath);
  const prefix = `${basename(filePath)}.lock.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length).split('.')[0]);
    // A live process may be about to link this temp onto the lock.
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
    unlinkQuiet(`${dir}/${name}`);
  }
}

function fsyncDir(filePath: string): void {
  let fd = 0;
  try {
    fd = openSync(dirname(filePath), 'r');
    fsyncSync(fd);
  } catch {
    /* directory fsync is not available on every filesystem */
  } finally {
    if (fd !== 0) closeSync(fd);
  }
}

function journalPath(filePath: string): string {
  return `${filePath}.journal`;
}

function partialPath(filePath: string): string {
  return `${filePath}.journal.partial`;
}

function failInterrupted(): never {
  throw new KinDbError(
    'E_IO',
    'The save stopped before the file was safe. The previous data is still in the file.',
  );
}

function ioError(error: unknown): KinDbError {
  if (error instanceof KinDbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new KinDbError('E_IO', `Could not save the database file: ${message}`);
}
