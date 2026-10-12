import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Database, type Transaction } from '../src/database';
import { setWriteFault } from '../src/pager/journal';
import { model } from '../src/orm';
import { sqlLiteral, sqlName } from '../src/sql';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kindb-hard-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  setWriteFault(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parameters and finished transactions', () => {
  test('a placeholder stores user text and does not run it', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (izina ijambo)');
    db.add({ collection: 't', data: { izina: 'ok' } });
    const evil = 'x" } siba byose kora itsinda t shira muri t { izina: "owned';
    expect(db.query('hitamo izina muri t aho izina = $izina', { izina: evil })).toEqual([]);
    expect(db.get({ collection: 't' })).toEqual([{ izina: 'ok' }]);
    db.execute('shira muri t { izina: $izina }', { izina: evil });
    expect(db.get({ collection: 't' }).map((row) => row.izina)).toEqual(['ok', evil]);
    expect(db.collections()).toEqual(['t']);
  });

  test('query refuses a script that does not end with HITAMO before it runs', () => {
    const db = Database.memory();
    db.execute('kora itsinda t; shira muri t { id: 1 }');
    expect(() => db.query('siba byose')).toThrow(/HITAMO/);
    expect(db.get({ collection: 't' })).toEqual([{ id: 1 }]);
    expect(() => db.query('shira muri t { id: 2 } hitamo * muri t')).toThrow(/only reads/);
    expect(() => db.query('siba muri t aho id = 1 hitamo * muri t')).toThrow(/only reads/);
    expect(db.get({ collection: 't' })).toEqual([{ id: 1 }]);
  });

  test('a missing parameter names the placeholder', () => {
    const db = Database.memory();
    db.execute('kora itsinda t');
    expect(() => db.query('hitamo * muri t aho id = $id')).toThrow(/\$id/);
  });

  test('sqlLiteral round-trips quotes and sqlName rejects a keyword', () => {
    const db = Database.memory();
    const text = 'a"b\n\t\\';
    db.execute(`kora itsinda t (izina ijambo); shira muri t { izina: ${sqlLiteral(text)} }`);
    expect(db.get({ collection: 't' })[0].izina).toBe(text);
    expect(sqlName('izina')).toBe('izina');
    expect(() => sqlName('hitamo')).toThrow(/KinDB word/);
  });

  test('a finished transaction handle no longer reads or writes', () => {
    const db = Database.memory();
    let handle: Transaction | undefined;
    db.transaction((tx) => {
      handle = tx;
      tx.execute('kora itsinda t');
      tx.add({ collection: 't', data: { id: 1 } });
    });
    expect(() => handle!.add({ collection: 't', data: { id: 2 } })).toThrow(/finished/);
    expect(() => handle!.execute('shira muri t { id: 3 }')).toThrow(/finished/);
    expect(() => handle!.get({ collection: 't' })).toThrow(/finished/);
    expect(() => handle!.save()).toThrow(/finished/);
    expect(db.get({ collection: 't' })).toEqual([{ id: 1 }]);

    let failed: Transaction | undefined;
    expect(() =>
      db.transaction((tx) => {
        failed = tx;
        tx.add({ collection: 't', data: { id: 9 } });
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(() => failed!.set({ collection: 't', where: { id: 1 }, data: { id: 8 } })).toThrow(/finished/);
    expect(db.get({ collection: 't' })).toEqual([{ id: 1 }]);

    let inner: Transaction | undefined;
    db.transaction((tx) => {
      tx.transaction((nested) => {
        inner = nested;
        nested.add({ collection: 't', data: { id: 4 } });
      });
      expect(() => inner!.add({ collection: 't', data: { id: 5 } })).toThrow(/finished/);
      tx.add({ collection: 't', data: { id: 6 } });
    });
    expect(db.get({ collection: 't' }).map((row) => row.id)).toEqual([1, 4, 6]);
  });
});

describe('atomic saves', () => {
  test('a save that stops keeps the previous rows', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.execute('kora itsinda t (id umubare); shira muri t { id: 1 }');
    setWriteFault('during-pages');
    expect(() => db.execute('shira muri t { id: 2 }')).toThrow(/previous data/);
    setWriteFault(null);
    const opened = Database.open(file);
    expect(opened.get({ collection: 't' })).toEqual([{ id: 1 }]);
    expect(existsSync(`${file}.journal`)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);

    setWriteFault('after-journal');
    expect(() => opened.execute('shira muri t { id: 3 }')).toThrow(/previous data/);
    setWriteFault(null);
    expect(Database.open(file).get({ collection: 't' })).toEqual([{ id: 1 }]);
    expect(existsSync(`${file}.journal`)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test('a second handle cannot replace rows another session already saved', () => {
    const file = path.join(tempDir(), 't.db');
    const first = Database.open(file, { create: true });
    first.execute('kora itsinda t (id umubare); shira muri t { id: 1 }');
    const second = Database.open(file);
    first.add({ collection: 't', data: { id: 2 } });
    expect(() => second.add({ collection: 't', data: { id: 3 } })).toThrow(/another session/);
    expect(Database.open(file).get({ collection: 't' }).map((row) => row.id)).toEqual([1, 2]);
  });

  test('a save that grows the file and stops keeps the previous rows', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.transaction(() => {
      db.execute('kora itsinda t (id umubare, izina ijambo)');
      for (let id = 1; id <= 40; id += 1) {
        db.add({ collection: 't', data: { id, izina: 'z'.repeat(80) } });
      }
    });
    setWriteFault('during-pages');
    expect(() =>
      db.transaction(() => {
        for (let id = 41; id <= 80; id += 1) {
          db.add({ collection: 't', data: { id, izina: 'z'.repeat(80) } });
        }
      }),
    ).toThrow(/previous data/);
    setWriteFault(null);
    const opened = Database.open(file);
    expect(opened.get({ collection: 't' })).toHaveLength(40);
    expect(opened.get({ collection: 't', where: { id: 41 } })).toEqual([]);
    expect(existsSync(`${file}.journal`)).toBe(false);
  });

  test('a successful save leaves no journal', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.execute('kora itsinda t; shira muri t { id: 1 }');
    expect(existsSync(`${file}.journal`)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(`${file}.journal.partial`)).toBe(false);
  });
});

describe('reads, catalogs, sorting, and grouping', () => {
  test('a limited range reads a few index pages', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare); kora urutonde t_id muri t (id)');
    db.transaction(() => {
      for (let id = 1; id <= 4000; id += 1) db.add({ collection: 't', data: { id } });
    });
    const beforeWide = db.rowsRead;
    const beforeIndex = db.indexVisits;
    expect(db.query('hitamo id muri t aho id >= 1 kandi id <= 4000 imipaka 1')).toEqual([{ id: 1 }]);
    expect(db.rowsRead - beforeWide).toBeLessThan(10);
    expect(db.indexVisits - beforeIndex).toBeGreaterThan(0);
    expect(db.indexVisits - beforeIndex).toBeLessThan(40);

    const beforeNarrow = db.rowsRead;
    const narrowIndex = db.indexVisits;
    expect(db.query('hitamo id muri t aho id > 3990 imipaka 1')).toEqual([{ id: 3991 }]);
    expect(db.rowsRead - beforeNarrow).toBeLessThan(20);
    expect(db.indexVisits - narrowIndex).toBeGreaterThan(0);
    expect(db.indexVisits - narrowIndex).toBeLessThan(40);
  });

  test('inserts into many tables do not reread the catalog', () => {
    const db = Database.memory();
    for (let table = 0; table < 40; table += 1) db.createCollection(`t${table}`);
    const loads = db.catalogLoads;
    for (let table = 0; table < 40; table += 1) {
      for (let row = 0; row < 15; row += 1) db.add({ collection: `t${table}`, data: { row } });
    }
    expect(db.catalogLoads).toBe(loads);
    expect(db.get({ collection: 't39' })).toHaveLength(15);
  });

  test('ni joins equal strings and still skips a number paired with its text', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda a
      kora itsinda b
      shira muri a { izina: "Aline", id: "1" }
      shira muri b { izina: "Aline", id: 1 }
    `);
    expect(db.query('hitamo a.izina muri a huza b aho a.izina ni b.izina')).toEqual([{ izina: 'Aline' }]);
    expect(db.query('hitamo a.izina muri a huza b aho a.id ni b.id')).toEqual([]);
  });

  test('tondeka and koranya sort, group, and count', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t (id umubare, izina ijambo, amanota umubare)
      shira muri t { id: 1, izina: "b", amanota: 10 }
      shira muri t { id: 2, izina: "a", amanota: 30 }
      shira muri t { id: 3, izina: "c", amanota: 20 }
      shira muri t { id: 4, izina: "a", amanota: ubusa }
    `);
    expect(db.query('hitamo id muri t tondeka amanota manuka imipaka 1')).toEqual([{ id: 2 }]);
    expect(db.query('hitamo id muri t tondeka amanota').map((row) => row.id)).toEqual([1, 3, 2, 4]);
    expect(db.query('hitamo id muri t tondeka amanota manuka').map((row) => row.id)).toEqual([2, 3, 1, 4]);
    expect(db.query('hitamo izina, bara(*) muri t koranya izina tondeka izina')).toEqual([
      { izina: 'a', bara: 2 },
      { izina: 'b', bara: 1 },
      { izina: 'c', bara: 1 },
    ]);
    expect(db.query('hitamo bara(*) muri t')).toEqual([{ bara: 4 }]);
    expect(db.query('hitamo teranya(amanota), nto(amanota), nini(amanota) muri t')).toEqual([
      { teranya_amanota: 60, nto_amanota: 10, nini_amanota: 30 },
    ]);
    expect(db.query('hitamo bara(amanota) muri t')).toEqual([{ bara_amanota: 3 }]);

    db.execute('kora itsinda e');
    expect(db.query('hitamo bara(*) muri e')).toEqual([{ bara: 0 }]);
    expect(db.query('hitamo * muri e')).toEqual([]);
    expect(() => db.query('hitamo nope muri e')).toThrow(/was not found/);
    expect(() => db.query('hitamo izina, bara(*) muri e koranya izina')).toThrow(/was not found/);
    expect(() => db.query('hitamo id, izina muri t koranya izina')).toThrow(/KORANYA/);
    expect(() => db.query('hitamo * muri t koranya izina')).toThrow(/KORANYA/);
    expect(() => db.query('hitamo * muri t imipaka 1 tondeka id')).toThrow(/TONDEKA/);
    expect(() => db.query('hitamo teranya(izina) muri t')).toThrow(/TERANYA/);
    expect(() => db.query('hitamo * muri t aho nope = 1')).toThrow(/was not found/);
  });

  test('a reopened table keeps assigning new row ids', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.transaction(() => {
      db.execute('kora itsinda t (id umubare)');
      for (let id = 1; id <= 30; id += 1) db.add({ collection: 't', data: { id } });
    });
    const opened = Database.open(file);
    opened.add({ collection: 't', data: { id: 31 } });
    const ids = opened.get({ collection: 't' }).map((row) => row.id);
    expect(ids).toHaveLength(31);
    expect(new Set(ids).size).toBe(31);
    expect(ids).toContain(31);
  });

  test('a misspelled column in a where clause explains the known columns', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare); shira muri t { id: 1 }');
    expect(() => db.execute('hitamo * muri missing')).toThrow(/kora itsinda missing/);
    expect(() => db.execute('kora itsinda u (id integer)')).toThrow(/not umubare/);
    db.execute('kora itsinda e (id number)');
    expect(db.collections()).toContain('e');
    expect(() => db.execute('hitamo * muri t imipaka -1')).toThrow(/whole number/);
    expect(() => db.execute('hitamo * muri t aho id != 1')).toThrow(/Compare with/);
    expect(() => db.execute('siba muri t')).toThrow(/SIBA needs AHO/);
    expect(() => db.execute('hitamo nope muri t')).toThrow(/was not found/);
    expect(() => db.createCollection('hitamo')).toThrow(/KinDB word/);
    expect(() => model('hitamo', { id: 'umubare' })).toThrow(/KinDB word/);
    expect(() => model('t2', { hitamo: 'umubare' })).toThrow(/KinDB word/);
    expect(() => db.execute('hitamo * muri t aho id <> 1')).toThrow(/<>/);
    expect(() => db.execute('hitamo * muri t aho id = 1 cyangwa id = 2')).toThrow(/KANDI/);
    expect(() => db.execute('hitamo * muri t aho id = 1 or id = 2')).toThrow(/KANDI/);
    expect(() => db.execute('hitamo * muri t aho id = id + 1')).toThrow(/no '\+'/);
    expect(() => db.execute('hitamo * muri t aho id = 1 | id = 2')).toThrow(/KANDI/);
    expect(() => db.execute('hitamo * muri t aho id = - -1')).toThrow(/one minus/);
    expect(() => db.execute('hindura t shyira id = 2')).toThrow(/HINDURA needs AHO/);
    expect(() => db.execute('kora itsinda z (id)')).toThrow(/needs a type/);
    expect(() => db.execute('siba muri t aho')).toThrow(/AHO needs a comparison/);
    expect(db.query('hitamo * muri t imipaka -0')).toEqual([]);
    expect(() => db.query('hitamo * muri t tondeka bara(*) manuka')).toThrow(/bara\(\*\)/);
  });

  test('a rejected row does not poison the file', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.execute('kora itsinda t (id umubare)');
    expect(() => db.add({ collection: 't', data: { id: 'bad', extra: 1 } })).toThrow(/number/);
    db.transaction(() => {
      try {
        db.add({ collection: 't', data: { id: 'bad', extra: 1 } });
      } catch {
        /* the bad value is refused and the callback continues */
      }
      db.add({ collection: 't', data: { id: 1, extra: 2 } });
    });
    const opened = Database.open(file);
    expect(opened.get({ collection: 't' })).toEqual([{ id: 1, extra: 2 }]);
    opened.add({ collection: 't', data: { id: 2 } });
    expect(opened.get({ collection: 't' })).toHaveLength(2);
  });

  test('a late limit and a duplicate key do not walk the whole table', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, k umubare, izina ijambo, flag ukuri)');
    db.execute('kora urutonde t_id muri t (id)');
    db.execute('kora urutonde t_k muri t (k)');
    db.execute('kora urutonde t_izina muri t (izina)');
    db.execute('kora urutonde t_flag muri t (flag)');
    db.transaction(() => {
      for (let id = 1; id <= 2000; id += 1) {
        db.add({
          collection: 't',
          data: { id, k: 7, izina: `n${id}`, flag: id % 2 === 0 },
        });
      }
    });

    const beforeLate = db.rowsRead;
    const lateIndex = db.indexVisits;
    expect(db.query('hitamo id muri t aho id >= 1500 imipaka 1')).toEqual([{ id: 1500 }]);
    expect(db.rowsRead - beforeLate).toBeLessThan(5);
    expect(db.indexVisits - lateIndex).toBeGreaterThan(0);
    expect(db.indexVisits - lateIndex).toBeLessThan(40);

    const beforeDup = db.rowsRead;
    const dupIndex = db.indexVisits;
    expect(db.query('hitamo id muri t aho k >= 7 kandi k <= 7 imipaka 1')).toEqual([{ id: 1 }]);
    expect(db.rowsRead - beforeDup).toBeLessThan(5);
    expect(db.indexVisits - dupIndex).toBeLessThan(20);

    const beforeText = db.rowsRead;
    const textIndex = db.indexVisits;
    expect(db.query('hitamo id muri t aho izina > 0 imipaka 1')).toEqual([]);
    expect(db.rowsRead - beforeText).toBeLessThan(5);
    expect(db.indexVisits - textIndex).toBeLessThan(20);

    const beforeFlag = db.indexVisits;
    expect(db.query('hitamo id muri t aho flag < 1 imipaka 1')).toEqual([]);
    expect(db.indexVisits - beforeFlag).toBeLessThan(20);

    const beforeSort = db.rowsRead;
    const sortIndex = db.indexVisits;
    expect(db.query('hitamo id muri t aho id > 1900 tondeka id manuka imipaka 1')).toEqual([{ id: 2000 }]);
    expect(db.rowsRead - beforeSort).toBeLessThan(5);
    expect(db.indexVisits - sortIndex).toBeGreaterThan(0);
    expect(db.indexVisits - sortIndex).toBeLessThan(20);

    db.add({ collection: 't', data: { id: 1e15, k: 7, izina: 'huge', flag: false } });
    const beforeOutlier = db.indexVisits;
    const outlierRows = db.rowsRead;
    expect(db.query('hitamo id muri t aho id >= 1 kandi id <= 2000 imipaka 1')).toEqual([{ id: 1 }]);
    expect(db.indexVisits - beforeOutlier).toBeLessThan(40);
    expect(db.rowsRead - outlierRows).toBeLessThan(5);
    const beforeLateOutlier = db.indexVisits;
    const lateOutlierRows = db.rowsRead;
    expect(db.query('hitamo id muri t aho id >= 1500 imipaka 1')).toEqual([{ id: 1500 }]);
    expect(db.indexVisits - beforeLateOutlier).toBeLessThan(40);
    expect(db.rowsRead - lateOutlierRows).toBeLessThan(5);

    db.add({ collection: 't', data: { id: 2001, k: 7, izina: 'z', flag: false, rare: 1 } });
    db.execute('kora urutonde t_rare muri t (rare)');
    const beforeRare = db.rowsRead;
    expect(
      db.query('hitamo id muri t aho id >= 1 kandi id <= 2001 kandi rare >= 1 kandi rare <= 1 imipaka 1'),
    ).toEqual([{ id: 2001 }]);
    expect(db.rowsRead - beforeRare).toBeLessThan(10);

    const beforeSecond = db.rowsRead;
    const secondIndex = db.indexVisits;
    expect(db.query('hitamo id muri t aho k = 7 kandi rare = 1 imipaka 1')).toEqual([{ id: 2001 }]);
    expect(db.rowsRead - beforeSecond).toBeLessThan(5);
    expect(db.indexVisits - secondIndex).toBeLessThan(20);
    const beforeFirst = db.rowsRead;
    expect(db.query('hitamo id muri t aho rare = 1 kandi k = 7 imipaka 1')).toEqual([{ id: 2001 }]);
    expect(db.rowsRead - beforeFirst).toBeLessThan(5);

    const beforePoint = db.indexVisits;
    expect(
      db.query('hitamo id muri t aho k >= 7 kandi k <= 7 kandi id >= 50 kandi id <= 50 imipaka 1'),
    ).toEqual([{ id: 50 }]);
    expect(db.indexVisits - beforePoint).toBeLessThan(20);
    const beforeReverse = db.indexVisits;
    expect(
      db.query('hitamo id muri t aho id >= 50 kandi id <= 50 kandi k >= 7 kandi k <= 7 imipaka 1'),
    ).toEqual([{ id: 50 }]);
    expect(db.indexVisits - beforeReverse).toBeLessThan(20);

    const beforeOrder = db.rowsRead;
    expect(db.query('hitamo id muri t tondeka id imipaka 1')).toEqual([{ id: 1 }]);
    expect(db.rowsRead - beforeOrder).toBeLessThan(5);
    const beforeDesc = db.rowsRead;
    expect(db.query('hitamo id muri t tondeka id manuka imipaka 1')).toEqual([{ id: 1e15 }]);
    expect(db.rowsRead - beforeDesc).toBeLessThan(5);
    const beforeSortedOutlier = db.rowsRead;
    expect(db.query('hitamo id muri t aho id >= 1500 tondeka id imipaka 1')).toEqual([{ id: 1500 }]);
    expect(db.rowsRead - beforeSortedOutlier).toBeLessThan(5);

    db.add({ collection: 't', data: { k: 7, izina: 'missing', flag: false } });
    db.add({ collection: 't', data: { id: null, k: 7, izina: 'empty', flag: false } });
    expect(db.query('hitamo izina muri t tondeka id imipaka 1')).toEqual([{ izina: 'n1' }]);
    const nullsLast = db.query('hitamo izina muri t tondeka id manuka');
    expect(nullsLast[nullsLast.length - 1].izina === 'missing' || nullsLast[nullsLast.length - 1].izina === 'empty').toBe(
      true,
    );
    expect(nullsLast[nullsLast.length - 2].izina === 'missing' || nullsLast[nullsLast.length - 2].izina === 'empty').toBe(
      true,
    );
    expect(nullsLast[0].izina).toBe('huge');
  });
});

describe('joins, literals, and damaged files', () => {
  test('an equality join probes an index on the left table', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare) kora itsinda u (id umubare)');
    db.transaction(() => {
      for (let id = 1; id <= 400; id += 1) {
        db.add({ collection: 't', data: { id } });
        db.add({ collection: 'u', data: { id: 401 - id } });
      }
    });
    db.execute('kora urutonde t_id muri t (id)');
    const before = db.rowsRead;
    const visits = db.indexVisits;
    expect(db.query('hitamo a.id, b.id muri t a huza u b aho a.id = b.id imipaka 1')).toEqual([
      { 'a.id': 400, 'b.id': 400 },
    ]);
    expect(db.rowsRead - before).toBeLessThan(10);
    expect(db.indexVisits - visits).toBeGreaterThan(0);
  });

  test('null does not match null in a join, with or without an index', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id ikintu, tag ijambo) kora itsinda u (id ikintu, tag ijambo)');
    db.execute(`
      shira muri t { id: ubusa, tag: "tn" }
      shira muri t { id: 1, tag: "t1" }
      shira muri u { id: ubusa, tag: "un" }
      shira muri u { id: 1, tag: "u1" }
      shira muri u { id: "1", tag: "us" }
    `);
    const pairs = [
      { 'a.tag': 't1', 'b.tag': 'u1' },
      { 'a.tag': 't1', 'b.tag': 'us' },
    ];
    const sql = 'hitamo a.tag, b.tag muri t a huza u b aho a.id = b.id';
    expect(db.query(sql)).toEqual(pairs);
    expect(db.query('hitamo tag muri t aho id = ubusa')).toEqual([{ tag: 'tn' }]);
    db.execute('kora urutonde u_id muri u (id)');
    expect(db.query(sql)).toEqual(pairs);
    expect(db.query(`${sql} imipaka 5`)).toEqual(pairs);
    db.execute('kora urutonde t_id muri t (id)');
    expect(db.query(sql)).toEqual(pairs);
    expect(db.query(`${sql} imipaka 1`)).toEqual([{ 'a.tag': 't1', 'b.tag': 'u1' }]);
    expect(db.query('hitamo a.tag, b.tag muri t a huza u b aho a.id ni b.id')).toEqual([
      { 'a.tag': 't1', 'b.tag': 'u1' },
    ]);
  });

  test('sqlLiteral writes exponents and negative zero', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, note ijambo)');
    const big = 1e21;
    const small = 1e-7;
    const fine = 0.0000001;
    expect(sqlLiteral(big)).not.toMatch(/e/i);
    expect(sqlLiteral(-0)).toBe('-0');
    db.execute(
      `shira muri t { id: ${sqlLiteral(big)}, note: "big" }
       shira muri t { id: ${sqlLiteral(small)}, note: "small" }
       shira muri t { id: ${sqlLiteral(fine)}, note: "fine" }
       shira muri t { id: ${sqlLiteral(-0)}, note: "neg" }`,
    );
    const rows = db.get({ collection: 't' });
    expect(rows.find((row) => row.note === 'big')?.id).toBe(big);
    expect(rows.find((row) => row.note === 'small')?.id).toBe(small);
    expect(rows.find((row) => row.note === 'fine')?.id).toBe(fine);
    expect(Object.is(rows.find((row) => row.note === 'neg')?.id, -0)).toBe(true);
  });

  test('a stopped save restores the file before it returns', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.transaction(() => {
      db.execute('kora itsinda t (id umubare, izina ijambo)');
      for (let id = 1; id <= 30; id += 1) db.add({ collection: 't', data: { id, izina: `r${id}` } });
    });
    const before = readFileSync(file);
    const stale = Database.open(file);
    setWriteFault('during-pages');
    expect(() =>
      db.transaction(() => {
        for (let id = 1; id <= 10; id += 1) {
          db.set({ collection: 't', where: { id }, data: { izina: `U${id}` } });
        }
      }),
    ).toThrow(/previous data/);
    setWriteFault(null);
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(`${file}.journal`)).toBe(false);
    stale.set({ collection: 't', where: { id: 30 }, data: { izina: 'STALE30' } });
    const rows = Database.open(file).get({ collection: 't' });
    expect(rows.filter((row) => String(row.izina).startsWith('U'))).toEqual([]);
    expect(rows.find((row) => row.id === 30)?.izina).toBe('STALE30');
    expect(rows.find((row) => row.id === 1)?.izina).toBe('r1');
  });

  test('a live pid in a plain lock file is not stolen', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.execute('kora itsinda t (id umubare); shira muri t { id: 1, izina: "keep" }');
    let pid1Alive = false;
    try {
      process.kill(1, 0);
      pid1Alive = true;
    } catch (error) {
      pid1Alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (pid1Alive) {
      writeFileSync(`${file}.lock`, '1');
      expect(() => db.add({ collection: 't', data: { id: 2 } })).toThrow(/being saved by process 1/);
      expect(readFileSync(`${file}.lock`, 'utf8')).toBe('1');
      rmSync(`${file}.lock`);
    }
    writeFileSync(`${file}.lock`, String(process.pid));
    expect(() => db.add({ collection: 't', data: { id: 3 } })).toThrow(/being saved by process/);
    rmSync(`${file}.lock`);
    writeFileSync(`${file}.lock`, '');
    db.add({ collection: 't', data: { id: 4 } });
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(Database.open(file).get({ collection: 't' })).toEqual([
      { id: 1, izina: 'keep' },
      { id: 4 },
    ]);
  });

  test('parallel saves do not lose a row or throw ENOENT', async () => {
    const dir = tempDir();
    const file = path.join(dir, 't.db');
    const db = Database.open(file, { create: true });
    db.execute('kora itsinda t (id umubare)');
    db.add({ collection: 't', data: { id: 1 } });
    const script = path.join(dir, 'child.js');
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
    writeFileSync(
      script,
      `'use strict';
const { Database, KinDbError } = require(${JSON.stringify(entry)});
const id = Number(process.argv[2]);
try {
  Database.open(process.argv[3]).add({ collection: 't', data: { id } });
  console.log(JSON.stringify({ ok: true, id }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, id, message: error.message, kin: error instanceof KinDbError }));
}
`,
    );
    const runs = await Promise.all(
      [2, 3, 4, 5, 6, 7, 8, 9].map(
        (id) =>
          new Promise<string>((resolve) => {
            const child = spawn(process.execPath, [script, String(id), file], { stdio: ['ignore', 'pipe', 'pipe'] });
            let text = '';
            child.stdout.on('data', (chunk) => {
              text += chunk;
            });
            child.on('exit', () => resolve(text));
          }),
      ),
    );
    const messages = runs.join('\n');
    expect(messages).not.toMatch(/ENOENT/);
    const rows = Database.open(file).get({ collection: 't' });
    const ids = new Set(rows.map((row) => row.id));
    expect(ids.has(1)).toBe(true);
    for (const text of runs) {
      const parsed = JSON.parse(text) as { ok: boolean; id: number };
      if (parsed.ok) expect(ids.has(parsed.id)).toBe(true);
    }
  });

  test('a killed worker does not leave a torn file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 't.db');
    const flag = path.join(dir, 'flag');
    const db = Database.open(file, { create: true });
    db.execute('kora itsinda t (id umubare, izina ijambo)');
    db.add({ collection: 't', data: { id: 1, izina: 'keep' } });
    const worker = new Worker(
      `
      const fs = require('fs');
      const { parentPort, workerData } = require('worker_threads');
      const { Database } = require(workerData.entry);
      const orig = fs.writeSync;
      let seen = 0;
      fs.writeSync = function () {
        const wrote = orig.apply(this, arguments);
        const buf = arguments[1];
        const pos = arguments[4];
        if (typeof pos === 'number' && Buffer.isBuffer(buf) && buf.length >= 512) {
          seen += 1;
          if (seen === 1) {
            fs.writeFileSync(workerData.flag, 'wrote');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
          }
        }
        return wrote;
      };
      const opened = Database.open(workerData.file);
      opened.transaction(() => {
        for (let id = 10; id <= 25; id += 1) {
          opened.add({ collection: 't', data: { id, izina: 'W'.repeat(180) } });
        }
      });
      parentPort.postMessage('saved');
      `,
      {
        eval: true,
        workerData: {
          file,
          flag,
          entry: path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/database.js'),
        },
      },
    );
    const start = Date.now();
    while (!existsSync(flag)) {
      if (Date.now() - start > 8000) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    await worker.terminate();
    expect(existsSync(flag)).toBe(true);
    expect(Database.open(file).get({ collection: 't' })).toEqual([{ id: 1, izina: 'keep' }]);
    expect(existsSync(`${file}.journal`)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test('a flipped payload byte is refused', () => {
    const file = path.join(tempDir(), 't.db');
    const db = Database.open(file, { create: true });
    db.execute('kora itsinda t (id umubare, izina ijambo)');
    db.add({ collection: 't', data: { id: 1, izina: `PAYLOAD${'A'.repeat(180)}` } });
    const bytes = readFileSync(file);
    expect(bytes[48]).toBe(1);
    const flipped = Buffer.from(bytes);
    const at = flipped.indexOf(Buffer.from('PAYLOAD'));
    expect(at).toBeGreaterThan(0);
    flipped[at + 'PAYLOAD'.length] = 'B'.charCodeAt(0);
    writeFileSync(file, flipped);
    expect(() => Database.open(file)).toThrow(/does not match the last save/);
  });
});
