import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Database } from '../src/database';
import { PAGE_SIZE } from '../src/pager/format';
import { resetWriteMeter, writeMeter } from '../src/pager/journal';
import { Store } from '../src/store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kindb-perf-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function elapsed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('speed', () => {
  test('a small limit does not cost as much as reading the whole table', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, izina ijambo)');
    for (let id = 1; id <= 8000; id += 1) db.add({ collection: 't', data: { id, izina: `u${id}` } });

    expect(db.query('hitamo id muri t imipaka 3')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(db.query('hitamo id muri t aho id > 5 imipaka 2')).toEqual([{ id: 6 }, { id: 7 }]);
    expect(db.get({ collection: 't', where: { id: 4 }, limit: 1 })).toEqual([{ id: 4, izina: 'u4' }]);

    const beforeLimit = db.rowsRead;
    db.query('hitamo * muri t imipaka 5');
    expect(db.rowsRead - beforeLimit).toBeLessThan(20);
    const beforeFull = db.rowsRead;
    expect(db.query('hitamo id muri t')).toHaveLength(8000);
    expect(db.rowsRead - beforeFull).toBe(8000);
  });

  test('an equality join of a thousand rows does not build every pair', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, izina ijambo) kora itsinda s (id umubare, izina ijambo)');
    for (let id = 1; id <= 1000; id += 1) {
      db.add({ collection: 't', data: { id, izina: `u${id}` } });
      db.add({ collection: 's', data: { id, izina: `s${id}` } });
    }
    const beforeJoin = db.rowsRead;
    const rowsLimited = db.query('hitamo a.id, b.izina muri t a huza s b aho a.id = b.id imipaka 5');
    expect(rowsLimited).toEqual([
      { id: 1, izina: 's1' },
      { id: 2, izina: 's2' },
      { id: 3, izina: 's3' },
      { id: 4, izina: 's4' },
      { id: 5, izina: 's5' },
    ]);
    // A nested loop would decode about 1000 x 1000 rows. Hashing reads each side once.
    expect(db.rowsRead - beforeJoin).toBeLessThan(3000);
    const rows = db.query('hitamo a.id muri t a huza s b aho a.id = b.id');
    expect(rows).toHaveLength(1000);
    expect(rows[0]).toEqual({ id: 1 });
    expect(rows[999]).toEqual({ id: 1000 });
  });

  test('rollback snapshots share unchanged pages', () => {
    const store = Store.empty();
    store.createCollection('t', [
      { name: 'id', type: 'number' },
      { name: 'izina', type: 'string' },
    ]);
    const payload = 'z'.repeat(400);
    for (let id = 1; id <= 2500; id += 1) store.add('t', { id, izina: payload });
    const copying = elapsed(() => {
      let snapshot = store;
      for (let i = 0; i < 60; i += 1) snapshot = store.clone();
      store.add('t', { id: 99999, izina: 'x' });
      expect(snapshot.rows('t')).toHaveLength(2500);
      expect(store.rows('t')).toHaveLength(2501);
    });
    // Serializing this file on every clone took well over a second for 60 copies.
    expect(copying).toBeLessThan(1000);
  });

  test('repeated adds and updates write dirty pages, not the whole file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'fat.db');
    const db = Database.open(file, { create: true });
    const payload = 'z'.repeat(500);
    const lines = ['kora itsinda t (id umubare, izina ijambo)'];
    for (let id = 1; id <= 1200; id += 1) {
      lines.push(`shira muri t { id: ${id}, izina: "${payload}" }`);
    }
    db.execute(lines.join('\n'));
    expect(readFileSync(file).length).toBeGreaterThan(512 * 1024);

    resetWriteMeter();
    db.transaction(() => {
      for (let id = 1; id <= 80; id += 1) db.add({ collection: 't', data: { id: 5000 + id, izina: 'x' } });
    });
    const batched = writeMeter();
    expect(batched).toBeGreaterThan(0);
    expect(batched).toBeLessThan(readFileSync(file).length);
    resetWriteMeter();
    db.add({ collection: 't', data: { id: 9000, izina: 'x' } });
    expect(writeMeter()).toBeGreaterThan(0);
    expect(writeMeter()).toBeLessThan(readFileSync(file).length);

    for (let id = 1; id <= 20; id += 1) {
      db.set({ collection: 't', where: { id }, data: { izina: `v${id}` } });
    }
    for (let id = 21; id <= 40; id += 1) db.del({ collection: 't', where: { id } });

    const opened = Database.open(file);
    const rows = opened.get({ collection: 't' });
    expect(rows).toHaveLength(1200 + 80 + 1 - 20);
    expect(rows.find((row) => row.id === 1)?.izina).toBe('v1');
    expect(rows.find((row) => row.id === 21)).toBeUndefined();
    expect(rows.find((row) => row.id === 5080)?.izina).toBe('x');
    expect(readFileSync(file).length % PAGE_SIZE).toBe(0);
  });

  test('an index point lookup stays cheaper than reading the table', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, izina ijambo)');
    const payload = 'z'.repeat(400);
    for (let id = 1; id <= 4000; id += 1) db.add({ collection: 't', data: { id, izina: payload } });
    db.execute('kora urutonde t_id muri t (id)');

    const beforeScan = db.rowsRead;
    expect(db.query('hitamo id muri t')).toHaveLength(4000);
    const scanned = db.rowsRead - beforeScan;
    const beforeLookup = db.rowsRead;
    for (let i = 0; i < 8; i += 1) {
      const id = (i * 97) % 4000 + 1;
      expect(db.query(`hitamo id muri t aho id = ${id} imipaka 1`)).toEqual([{ id }]);
    }
    expect(db.rowsRead - beforeLookup).toBeLessThan(scanned);
  });

  test('a limited equality join probes the inner index', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t (id umubare)
      kora itsinda s (id umubare, izina ijambo)
    `);
    const payload = 'z'.repeat(500);
    for (let id = 1; id <= 2000; id += 1) {
      db.add({ collection: 't', data: { id } });
      db.add({ collection: 's', data: { id, izina: payload } });
    }
    db.execute('kora urutonde s_id muri s (id)');
    expect(db.query('hitamo a.id, b.izina muri t a huza s b aho a.id = b.id imipaka 1')).toEqual([
      { id: 1, izina: payload },
    ]);

    const beforeScan = db.rowsRead;
    expect(db.query('hitamo id muri s')).toHaveLength(2000);
    const scanned = db.rowsRead - beforeScan;
    const beforeJoin = db.rowsRead;
    for (let i = 0; i < 10; i += 1) {
      const rows = db.query('hitamo a.id muri t a huza s b aho a.id = b.id imipaka 5');
      expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    }
    expect(db.rowsRead - beforeJoin).toBeLessThan(scanned);
  });

  test('updating by an indexed column does not scan the table', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, izina ijambo, n umubare)');
    const payload = 'z'.repeat(400);
    for (let id = 1; id <= 3000; id += 1) {
      db.add({ collection: 't', data: { id, izina: payload, n: 0 } });
    }
    db.execute('kora urutonde t_id muri t (id)');

    const beforeScan = db.rowsRead;
    expect(db.query('hitamo id muri t')).toHaveLength(3000);
    const scanned = db.rowsRead - beforeScan;
    const beforeUpdate = db.rowsRead;
    for (let id = 1; id <= 30; id += 1) {
      db.execute(`hindura t shyira n = ${id} aho id = ${id}`);
    }
    expect(db.rowsRead - beforeUpdate).toBeLessThan(scanned);
    expect(db.get({ collection: 't', where: { id: 1 } })[0].n).toBe(1);
    expect(db.get({ collection: 't', where: { id: 30 } })[0].n).toBe(30);
  });

  test('inserts with one index stay linear', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare); kora urutonde t_id muri t (id)');
    const before = db.catalogLoads;
    const inserting = elapsed(() => {
      for (let id = 1; id <= 2000; id += 1) db.add({ collection: 't', data: { id } });
    });
    expect(db.catalogLoads).toBe(before);
    expect(inserting).toBeLessThan(2000);
    expect(db.get({ collection: 't', where: { id: 1 } })).toEqual([{ id: 1 }]);
    expect(db.get({ collection: 't', where: { id: 2000 } })).toEqual([{ id: 2000 }]);
    expect(db.query('hitamo id muri t aho id > 1990 kandi id < 1995').map((row) => row.id)).toEqual([
      1991, 1992, 1993, 1994,
    ]);
  });
});
