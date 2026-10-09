import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { KinDbError } from '../errors';
import {
  blankLeaf,
  emptyHeader,
  freelistCapacity,
  MAGIC,
  PAGE_SIZE,
  readFreelist,
  readHeader,
  writeFreelist,
  writeHeader,
  type FileHeader,
} from './format';

/**
 * A database file is a sequence of fixed-size pages.
 * Page 1 holds the file header. Later pages are btree leaves, btree
 * interior pages, overflow chains, or freelist trunks.
 */
export class Pager {
  private pages: Buffer[];
  private header: FileHeader;
  /** Page numbers whose bytes differ from the last successful write. */
  private dirty: Set<number>;
  /** Header fields changed since page 1 was last rebuilt. */
  private headerDirty: boolean;

  private constructor(pages: Buffer[], header: FileHeader, dirty: Set<number>, headerDirty: boolean) {
    this.pages = pages;
    this.header = header;
    this.dirty = dirty;
    this.headerDirty = headerDirty;
  }

  static create(): Pager {
    const pages = [Buffer.alloc(PAGE_SIZE), blankLeaf()];
    const header = emptyHeader(pages.length);
    const pager = new Pager(pages, header, new Set([1, 2]), true);
    pager.syncHeader();
    return pager;
  }

  static open(bytes: Buffer): Pager {
    if (bytes.length < 16 || !bytes.subarray(0, 16).equals(MAGIC)) {
      throw new KinDbError('E_IO', 'Database file is not a KinDB page file');
    }
    if (bytes.length % PAGE_SIZE !== 0) {
      throw new KinDbError('E_IO', 'Database file length is not a multiple of the page size');
    }
    let header: FileHeader;
    try {
      header = readHeader(bytes.subarray(0, PAGE_SIZE));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KinDbError('E_IO', message);
    }
    const pageCount = bytes.length / PAGE_SIZE;
    if (header.pageCount !== pageCount) {
      throw new KinDbError('E_IO', 'Database header page count does not match the file');
    }
    const pages: Buffer[] = [];
    for (let i = 0; i < pageCount; i += 1) {
      pages.push(Buffer.from(bytes.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)));
    }
    return new Pager(pages, header, new Set(), false);
  }

  /**
   * Copy-on-write snapshot. Unchanged page buffers are shared.
   * A later {@link put} replaces a buffer in this pager and leaves the snapshot's buffer in place.
   */
  snapshot(): Pager {
    this.syncHeader();
    return new Pager(this.pages.slice(), { ...this.header }, new Set(this.dirty), false);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get freelistCount(): number {
    return this.header.freelistCount;
  }

  get schemaRoot(): number {
    return this.header.schemaRoot;
  }

  set schemaRoot(page: number) {
    this.header.schemaRoot = page;
    this.touch();
  }

  get schemaNext(): number {
    return this.header.schemaNext;
  }

  set schemaNext(value: number) {
    this.header.schemaNext = value;
    this.touch();
  }

  /** The returned buffer must not be edited. Replace the page with {@link put}. */
  get(pageNumber: number): Buffer {
    this.assertPage(pageNumber);
    return this.pages[pageNumber - 1];
  }

  put(pageNumber: number, page: Buffer): void {
    this.assertPage(pageNumber);
    if (page.length !== PAGE_SIZE) {
      throw new KinDbError('E_IO', 'A page write must be the fixed page size');
    }
    this.pages[pageNumber - 1] = page;
    this.dirty.add(pageNumber);
    this.touch();
  }

  /** Take a page from the freelist, or append a new page at the end of the file. */
  allocate(): number {
    if (this.header.freelistHead === 0) {
      this.pages.push(Buffer.alloc(PAGE_SIZE));
      this.header.pageCount = this.pages.length;
      this.dirty.add(this.pages.length);
      this.touch();
      return this.pages.length;
    }
    const trunkNumber = this.header.freelistHead;
    const trunk = readFreelist(this.get(trunkNumber));
    this.header.freelistCount -= 1;
    if (trunk.ids.length > 0) {
      const id = trunk.ids[trunk.ids.length - 1];
      this.put(trunkNumber, writeFreelist(trunk.next, trunk.ids.slice(0, -1)));
      this.put(id, Buffer.alloc(PAGE_SIZE));
      return id;
    }
    this.header.freelistHead = trunk.next;
    this.put(trunkNumber, Buffer.alloc(PAGE_SIZE));
    this.touch();
    return trunkNumber;
  }

  /** Return a page to the freelist trunk chain. */
  free(pageNumber: number): void {
    this.assertPage(pageNumber);
    if (pageNumber === 1) throw new KinDbError('E_IO', 'Page 1 cannot be freed');
    const capacity = freelistCapacity();
    if (this.header.freelistHead === 0) {
      this.put(pageNumber, writeFreelist(0, []));
      this.header.freelistHead = pageNumber;
      this.header.freelistCount = 1;
      this.touch();
      return;
    }
    const trunkNumber = this.header.freelistHead;
    const trunk = readFreelist(this.get(trunkNumber));
    if (trunk.ids.length < capacity) {
      this.put(trunkNumber, writeFreelist(trunk.next, [...trunk.ids, pageNumber]));
      this.header.freelistCount += 1;
      this.touch();
      return;
    }
    this.put(pageNumber, writeFreelist(trunkNumber, []));
    this.header.freelistHead = pageNumber;
    this.header.freelistCount += 1;
    this.touch();
  }

  toBuffer(): Buffer {
    this.syncHeader();
    return Buffer.concat(this.pages);
  }

  /**
   * Write dirty pages in place.
   * The whole file is written when `full` is set, when the path is new,
   * or when the existing bytes are not a page file of this length or shorter.
   */
  writeTo(filePath: string, full: boolean): void {
    this.syncHeader();
    const bytes = this.pages.length * PAGE_SIZE;
    if (full || !existsSync(filePath)) {
      this.writeAll(filePath);
      return;
    }
    const size = statSync(filePath).size;
    if (this.dirty.size === 0 && size === bytes) return;
    if (size % PAGE_SIZE !== 0 || size > bytes || !hasPageMagic(filePath, size)) {
      this.writeAll(filePath);
      return;
    }
    const fd = openSync(filePath, 'r+');
    try {
      const firstMissing = size / PAGE_SIZE + 1;
      for (let pageNumber = firstMissing; pageNumber <= this.pages.length; pageNumber += 1) {
        this.dirty.add(pageNumber);
      }
      for (const pageNumber of this.dirty) {
        writeSync(fd, this.pages[pageNumber - 1], 0, PAGE_SIZE, (pageNumber - 1) * PAGE_SIZE);
      }
    } finally {
      closeSync(fd);
    }
    this.dirty.clear();
  }

  copy(): Pager {
    return this.snapshot();
  }

  private writeAll(filePath: string): void {
    writeFileSync(filePath, Buffer.concat(this.pages));
    this.dirty.clear();
  }

  private syncHeader(): void {
    if (!this.headerDirty) return;
    this.header.pageCount = this.pages.length;
    const page = Buffer.from(this.pages[0]);
    writeHeader(page, this.header);
    this.pages[0] = page;
    this.dirty.add(1);
    this.headerDirty = false;
  }

  private touch(): void {
    this.header.changeCounter += 1;
    this.headerDirty = true;
    this.dirty.add(1);
  }

  private assertPage(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pages.length) {
      throw new KinDbError('E_IO', `Page ${pageNumber} is outside the file`);
    }
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
