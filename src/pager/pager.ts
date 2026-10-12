import { commitPages } from './journal';
import { KinDbError } from '../errors';
import {
  blankLeaf,
  checksumOf,
  emptyHeader,
  freelistCapacity,
  MAGIC,
  PAGE_SIZE,
  pageDigest,
  readFreelist,
  readHeader,
  readStoredChecksum,
  stampChecksum,
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
  /** changeCounter last read from disk, or written by this pager. */
  private baseCounter: number;
  /**
   * Smallest row id in each index page's subtree.
   * It is not stored in the file. A snapshot copies it so a rollback
   * restores the same answers the pages describe.
   */
  private indexMins: Map<number, number>;
  /**
   * Number of index entries in each page's subtree.
   * Same lifetime as {@link indexMins}: memory only, copied by a snapshot.
   */
  private indexCounts: Map<number, number>;
  /** Per-page digests for the header checksum. A snapshot copies the array. */
  private digests: number[];
  private digestXor: number;

  private constructor(
    pages: Buffer[],
    header: FileHeader,
    dirty: Set<number>,
    headerDirty: boolean,
    baseCounter: number,
    indexMins: Map<number, number>,
    indexCounts: Map<number, number>,
    digests: number[] | null,
  ) {
    this.pages = pages;
    this.header = header;
    this.dirty = dirty;
    this.headerDirty = headerDirty;
    this.baseCounter = baseCounter;
    this.indexMins = indexMins;
    this.indexCounts = indexCounts;
    this.digests =
      digests && digests.length === pages.length
        ? digests
        : pages.map((page, index) => pageDigest(page, index === 0));
    this.digestXor = checksumOf(this.digests);
  }

  static create(): Pager {
    const pages = [Buffer.alloc(PAGE_SIZE), blankLeaf()];
    const header = emptyHeader(pages.length);
    const pager = new Pager(
      pages,
      header,
      new Set([1, 2]),
      true,
      header.changeCounter,
      new Map(),
      new Map(),
      null,
    );
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
    const digests: number[] = [];
    for (let i = 0; i < pageCount; i += 1) {
      const page = Buffer.from(bytes.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE));
      pages.push(page);
      digests.push(pageDigest(page, i === 0));
    }
    const expected = readStoredChecksum(pages[0]);
    if (expected !== null && expected !== checksumOf(digests)) {
      throw new KinDbError(
        'E_IO',
        'This database file does not match the last save. KinDB did not open it. Restore a backup, then try again.',
      );
    }
    return new Pager(pages, header, new Set(), false, header.changeCounter, new Map(), new Map(), digests);
  }

  /**
   * Copy-on-write snapshot. Unchanged page buffers are shared.
   * A later {@link put} replaces a buffer in this pager and leaves the snapshot's buffer in place.
   */
  snapshot(): Pager {
    this.syncHeader();
    return new Pager(
      this.pages.slice(),
      { ...this.header },
      new Set(this.dirty),
      false,
      this.baseCounter,
      new Map(this.indexMins),
      new Map(this.indexCounts),
      this.digests.slice(),
    );
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
    this.replaceDigest(pageNumber, page);
    this.dirty.add(pageNumber);
    this.touch();
  }

  /** Take a page from the freelist, or append a new page at the end of the file. */
  allocate(): number {
    if (this.header.freelistHead === 0) {
      const page = Buffer.alloc(PAGE_SIZE);
      this.pages.push(page);
      this.digests.push(0);
      this.replaceDigest(this.pages.length, page);
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

  /** Smallest row id cached for an index page, if this pager has computed one. */
  indexMinOf(pageNumber: number): number | undefined {
    return this.indexMins.get(pageNumber);
  }

  /** Record the smallest row id in an index page's subtree. */
  setIndexMin(pageNumber: number, min: number): void {
    this.indexMins.set(pageNumber, min);
  }

  /** Drop a cached index minimum. A freed page must not keep the old row id. */
  clearIndexMin(pageNumber: number): void {
    this.indexMins.delete(pageNumber);
  }

  /** Entries cached for an index page, if this pager has computed the subtree. */
  indexCountOf(pageNumber: number): number | undefined {
    return this.indexCounts.get(pageNumber);
  }

  /** Record how many index entries sit in this page's subtree. */
  setIndexCount(pageNumber: number, count: number): void {
    this.indexCounts.set(pageNumber, count);
  }

  /** Drop a cached entry count. A freed page must not answer for its old tree. */
  clearIndexCount(pageNumber: number): void {
    this.indexCounts.delete(pageNumber);
  }

  /** Return a page to the freelist trunk chain. */
  free(pageNumber: number): void {
    this.assertPage(pageNumber);
    this.indexMins.delete(pageNumber);
    this.indexCounts.delete(pageNumber);
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
   * A file another session has already grown or committed is left untouched.
   */
  writeTo(filePath: string, full: boolean): void {
    this.syncHeader();
    commitPages(filePath, this.pages, this.dirty, full, this.baseCounter);
    this.baseCounter = this.header.changeCounter;
    this.dirty.clear();
  }

  copy(): Pager {
    return this.snapshot();
  }

  private syncHeader(): void {
    if (!this.headerDirty) return;
    this.header.pageCount = this.pages.length;
    const page = Buffer.from(this.pages[0]);
    writeHeader(page, this.header);
    this.replaceDigest(1, page);
    stampChecksum(page, this.digestXor);
    this.pages[0] = page;
    this.dirty.add(1);
    this.headerDirty = false;
  }

  /** Keep the running XOR equal to the digest of `page`. Page 1 ignores its checksum field. */
  private replaceDigest(pageNumber: number, page: Buffer): void {
    const next = pageDigest(page, pageNumber === 1);
    const index = pageNumber - 1;
    const prev = this.digests[index] ?? 0;
    if (index === this.digests.length) this.digests.push(prev);
    this.digests[index] = next;
    this.digestXor = (this.digestXor ^ prev ^ next) >>> 0;
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


