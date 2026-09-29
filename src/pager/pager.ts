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

  private constructor(pages: Buffer[], header: FileHeader) {
    this.pages = pages;
    this.header = header;
  }

  static create(): Pager {
    const pages = [Buffer.alloc(PAGE_SIZE), blankLeaf()];
    const header = emptyHeader(pages.length);
    const pager = new Pager(pages, header);
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
    return new Pager(pages, header);
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
    this.touch();
  }

  /** Take a page from the freelist, or append a new page at the end of the file. */
  allocate(): number {
    if (this.header.freelistHead === 0) {
      this.pages.push(Buffer.alloc(PAGE_SIZE));
      this.header.pageCount = this.pages.length;
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
    return Buffer.concat(this.pages.map((page) => Buffer.from(page)));
  }

  copy(): Pager {
    return Pager.open(this.toBuffer());
  }

  private syncHeader(): void {
    this.header.pageCount = this.pages.length;
    const page = Buffer.from(this.pages[0]);
    writeHeader(page, this.header);
    this.pages[0] = page;
  }

  private touch(): void {
    this.header.changeCounter += 1;
    this.syncHeader();
  }

  private assertPage(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pages.length) {
      throw new KinDbError('E_IO', `Page ${pageNumber} is outside the file`);
    }
  }
}
