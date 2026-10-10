import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Database } from '../src/database';
import { KinDbError } from '../src/errors';
import { encodeIndexKey } from '../src/pager/index-key';
import { planAccess, planRead } from '../src/relational/planner';
import { Store } from '../src/store';
import type { Predicate } from '../src/value';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kindb-index-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function before(left: number | string | boolean | null, right: number | string | boolean | null): void {
  const encodedLeft = encodeIndexKey(left);
  const encodedRight = encodeIndexKey(right);
  expect(encodedLeft).not.toBeNull();
  expect(encodedRight).not.toBeNull();
  expect(Buffer.compare(encodedLeft!, encodedRight!)).toBeLessThan(0);
}

describe('index keys and the planner', () => {
  test('numbers sort, and numeric strings share a number key', () => {
    before(-2, -1);
    before(-1, 0);
    before(-0.5, -0.1);
    before(0, 0.1);
    before(0.1, 1);
    before(1, 1.5);
    before(1.5, 2);
    before(null, false);
    before(false, true);
    before(true, 0);
    before(1, 'hello');
    expect(encodeIndexKey(-0)!.equals(encodeIndexKey(0)!)).toBe(true);
    expect(encodeIndexKey(1)!.equals(encodeIndexKey('1')!)).toBe(true);
    expect(encodeIndexKey('1')!.equals(encodeIndexKey('1.0')!)).toBe(true);
    expect(encodeIndexKey('-0')!.equals(encodeIndexKey(0)!)).toBe(true);
    expect(encodeIndexKey({ a: 1 })).toBeNull();
    expect(encodeIndexKey([1])).toBeNull();
  });

  test('equality beats a range, and a contradiction matches nothing', () => {
    const name: Predicate = { op: 'loose', field: 'name', value: 'keza' };
    const low: Predicate = { op: 'gt', field: 'score', value: 1 };
    const high: Predicate = { op: 'lt', field: 'score', value: 10 };
    const chosen = planAccess([low, name], ['score', 'name'], 't');
    expect(chosen.kind).toBe('point');
    if (chosen.kind === 'point') {
      expect(chosen.column).toBe('name');
      expect(chosen.key.equals(encodeIndexKey('keza')!)).toBe(true);
    }

    expect(
      planAccess(
        [
          { op: 'loose', field: 'id', value: 1 },
          { op: 'loose', field: 'id', value: 2 },
        ],
        ['id'],
        't',
      ).kind,
    ).toBe('empty');
    expect(
      planAccess(
        [
          { op: 'gt', field: 'id', value: 5 },
          { op: 'lt', field: 'id', value: 3 },
        ],
        [],
        't',
      ).kind,
    ).toBe('empty');
    expect(
      planAccess(
        [
          { op: 'loose', field: 'id', value: 'hello' },
          { op: 'gt', field: 'id', value: 1 },
        ],
        ['id'],
        't',
      ).kind,
    ).toBe('empty');
    expect(
      planAccess(
        [
          { op: 'eq', field: 'id', value: 1 },
          { op: 'loose', field: 'id', value: '1' },
        ],
        ['id'],
        't',
      ).kind,
    ).toBe('point');

    const open = planAccess([{ op: 'gt', field: 'id', value: 5 }], ['id'], 't');
    expect(open.kind).toBe('range');
    if (open.kind === 'range') expect(open.bothSides).toBe(false);
    expect(planRead([{ op: 'gt', field: 'id', value: 5 }], ['id'], 't').kind).toBe('scan');

    const closed = planRead(
      [
        { op: 'gt', field: 'id', value: 1 },
        { op: 'lt', field: 'id', value: 4 },
      ],
      ['id'],
      't',
    );
    expect(closed.kind).toBe('range');
    if (closed.kind === 'range') expect(closed.bothSides).toBe(true);

    const qualified = planAccess(
      [{ op: 'loose', field: 'id', qualifier: 'a', value: 1 }],
      ['id'],
      'a',
    );
    expect(qualified.kind).toBe('point');
    expect(
      planAccess([{ op: 'loose', field: 'id', qualifier: 'a', value: 1 }], ['id'], 'b').kind,
    ).toBe('scan');
  });
});

describe('simple indexes', () => {
  test('indexes one column and keeps stored order', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t (id umubare, izina ijambo)
      shira muri t { id: 10, izina: "a" }
      shira muri t { id: 1, izina: "b" }
      shira muri t { id: 7, izina: "c" }
      shira muri t { id: 3, izina: "d" }
      shira muri t { id: 5, izina: "e" }
      kora urutonde t_id muri t (id)
    `);
    expect(db.collections()).toEqual(['t']);
    expect(db.query('hitamo id muri t aho id = 7')).toEqual([{ id: 7 }]);
    expect(db.query('hitamo id muri t aho id = 4')).toEqual([]);
    // Open range with a limit stays in table order: 10, then 7.
    expect(db.query('hitamo id muri t aho id > 2 imipaka 2')).toEqual([{ id: 10 }, { id: 7 }]);
    // A bounded range uses the index, then restores table order: 7, 3, 5.
    expect(db.query('hitamo id muri t aho id > 2 kandi id < 8')).toEqual([
      { id: 7 },
      { id: 3 },
      { id: 5 },
    ]);
    expect(db.get({ collection: 't', where: { id: 3 } })).toEqual([{ id: 3, izina: 'd' }]);
  });

  test('keeps loose equality and ni, including zero', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      kora urutonde t_id muri t (id)
      shira muri t { id: "1", tag: "str" }
      shira muri t { id: "1.0", tag: "dot" }
      shira muri t { id: 1, tag: "num" }
      shira muri t { id: "0", tag: "zero-str" }
      shira muri t { id: "-0", tag: "neg-str" }
      shira muri t { id: 0, tag: "zero" }
    `);
    expect(db.query('hitamo tag muri t aho id = 1').map((row) => row.tag)).toEqual([
      'str',
      'dot',
      'num',
    ]);
    expect(db.query('hitamo tag muri t aho id = "1"').map((row) => row.tag)).toEqual(['str', 'num']);
    expect(db.query('hitamo tag muri t aho id = "1.0"').map((row) => row.tag)).toEqual([
      'dot',
      'num',
    ]);
    expect(db.query('hitamo tag muri t aho id ni 1').map((row) => row.tag)).toEqual(['num']);
    expect(db.query('hitamo tag muri t aho id = "-0"').map((row) => row.tag)).toEqual([
      'neg-str',
      'zero',
    ]);
    expect(db.query('hitamo tag muri t aho id ni 0').map((row) => row.tag)).toEqual(['zero']);
    // "1" fails id = "1.0". "1.0" and 1 each satisfy both comparisons.
    expect(db.query('hitamo tag muri t aho id = 1 kandi id = "1.0"').map((row) => row.tag)).toEqual([
      'dot',
      'num',
    ]);
    expect(db.query('hitamo tag muri t aho id = 1 kandi id = 2')).toEqual([]);
  });

  test('indexes booleans, null, strings, and values added later', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t (urutonde umubare)
      kora urutonde t_flag muri t (flag)
      kora urutonde t_name muri t (izina)
      shira muri t { urutonde: 1, flag: nibyo, izina: "keza" }
      shira muri t { urutonde: 2, flag: sibyo, izina: "aline" }
      shira muri t { urutonde: 3, flag: ubusa, izina: "keza" }
      shira muri t { urutonde: 4, flag: nibyo }
    `);
    expect(db.collections()).toEqual(['t']);
    expect(db.query('hitamo urutonde muri t aho flag = nibyo').map((row) => row.urutonde)).toEqual([
      1, 4,
    ]);
    expect(db.query('hitamo urutonde muri t aho flag = ubusa')).toEqual([{ urutonde: 3 }]);
    expect(db.query('hitamo urutonde muri t aho izina = "keza"').map((row) => row.urutonde)).toEqual([
      1, 3,
    ]);
    expect(db.query('hitamo urutonde muri t aho izina = "aline" imipaka 1')).toEqual([
      { urutonde: 2 },
    ]);
  });

  test('rejects a second column, a duplicate index, and a missing table', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, izina ijambo)');
    expect(() => db.execute('kora urutonde i muri t (id, izina)')).toThrow(/one column/);
    expect(() => db.execute('siba urutonde i')).toThrow(/not found/);
    expect(db.collections()).toEqual(['t']);
    db.execute('KORA URUTONDE t_id MURI t (id)');
    expect(() => db.execute('kora urutonde t_id muri t (izina)')).toThrow(/already in use/);
    expect(() => db.execute('kora urutonde t_id_2 muri t (id)')).toThrow(/already exists/);
    expect(() => db.execute('kora urutonde t muri t (izina)')).toThrow(/already in use/);
    expect(() => db.execute('kora urutonde missing_i muri missing (id)')).toThrow(
      /was not found/,
    );
    const error = (() => {
      try {
        db.execute('kora urutonde i muri t (id, izina)');
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(KinDbError);
    expect((error as KinDbError).code).toBe('E_SYNTAX');
  });

  test('updates and deletes keep the index, including a changed key', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      shira muri t { id: 1, izina: "a" }
      shira muri t { id: 2, izina: "b" }
      shira muri t { id: 1, izina: "c" }
      kora urutonde t_id muri t (id)
    `);
    expect(() => db.execute('hindura t shyira izina = "z" aho id = 1')).toThrow(/More than one/);
    expect(db.query('hitamo izina muri t aho id = 1').map((row) => row.izina)).toEqual(['a', 'c']);

    db.execute('hindura t shyira id = 9 aho izina = "b"');
    expect(db.query('hitamo * muri t aho id = 2')).toEqual([]);
    expect(db.query('hitamo izina muri t aho id = 9')).toEqual([{ izina: 'b' }]);
    db.execute('hindura t shyira izina = "bb" aho t.id = 9');
    expect(db.get({ collection: 't', where: { id: 9 } })).toEqual([{ id: 9, izina: 'bb' }]);

    expect(db.execute('siba muri t aho id = 1').deleted).toBe(2);
    expect(db.query('hitamo * muri t aho id = 1')).toEqual([]);
    expect(db.query('hitamo izina muri t')).toEqual([{ izina: 'bb' }]);
    expect(() => db.execute('siba muri t aho id = 1')).toThrow(/No record/);

    db.set({ collection: 't', where: { id: 9 }, data: { id: 4, izina: 'set' } });
    expect(db.get({ collection: 't', where: { id: 9 } })).toEqual([]);
    expect(db.get({ collection: 't', where: { id: 4 } })).toEqual([{ id: 4, izina: 'set' }]);
    expect(db.del({ collection: 't', where: { id: { gte: 4, lt: 5 } } })).toBe(1);
    expect(db.get({ collection: 't' })).toEqual([]);
  });

  test('drops an index with its table, and a failed script rolls back', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      shira muri t { id: 1, izina: "a" }
      kora urutonde ix muri t (id)
    `);
    expect(() =>
      db.execute(`
        shira muri t { id: 2, izina: "b" }
        siba itsinda missing
      `),
    ).toThrow(/was not found/);
    expect(db.query('hitamo * muri t aho id = 2')).toEqual([]);
    expect(db.query('hitamo izina muri t aho id = 1')).toEqual([{ izina: 'a' }]);

    db.execute('siba urutonde ix');
    expect(db.query('hitamo izina muri t aho id = 1')).toEqual([{ izina: 'a' }]);
    expect(() => db.execute('siba urutonde ix')).toThrow(/not found/);

    db.execute('kora urutonde ix muri t (id)');
    db.execute('siba itsinda t');
    expect(db.collections()).toEqual([]);
    expect(() => db.execute('siba urutonde ix')).toThrow(/not found/);
    db.execute('kora itsinda ix');
    expect(db.collections()).toEqual(['ix']);

    db.execute('siba byose');
    expect(db.collections()).toEqual([]);
    db.execute('kora itsinda t; kora urutonde ix muri t (id); shira muri t { id: 3, izina: "c" }');
    expect(db.query('hitamo izina muri t aho id = 3')).toEqual([{ izina: 'c' }]);
  });

  test('a saved index still answers after the file is opened again', () => {
    const dir = tempDir();
    const file = path.join(dir, 't.db');
    const db = Database.open(file, { create: true });
    db.execute(`
      kora itsinda t
      shira muri t { id: 1, izina: "a" }
      shira muri t { id: 2, izina: "b" }
      kora urutonde ix muri t (id)
    `);
    const opened = Database.open(file);
    expect(opened.query('hitamo izina muri t aho id = 2')).toEqual([{ izina: 'b' }]);
    opened.execute('shira muri t { id: 99, izina: "z" }');
    opened.execute('siba muri t aho id = 1');
    expect(opened.query('hitamo izina muri t aho id = 1')).toEqual([]);
    expect(opened.query('hitamo izina muri t aho id = 99')).toEqual([{ izina: 'z' }]);
    opened.execute('siba urutonde ix');
    expect(opened.query('hitamo izina muri t aho id = 99')).toEqual([{ izina: 'z' }]);
    expect(opened.collections()).toEqual(['t']);
  });

  test('a tall index survives splits, deletes, and key changes', () => {
    const db = Database.memory();
    db.execute('kora itsinda t (id umubare, izina ijambo)');
    const ids: number[] = [];
    for (let id = 1; id <= 500; id += 1) {
      const value = (id % 2 === 0 ? 1 : -1) * ((id * 17) % 500);
      ids.push(value);
      db.add({ collection: 't', data: { id: value, izina: `u${id}` } });
    }
    db.execute('kora urutonde t_id muri t (id)');
    for (const value of ids) {
      expect(db.query(`hitamo izina muri t aho id = ${value}`)).toHaveLength(1);
    }
    const removed = new Set<number>();
    for (let index = 0; index < ids.length; index += 3) {
      removed.add(ids[index]);
      db.execute(`siba muri t aho id = ${ids[index]} kandi izina = "u${index + 1}"`);
    }
    for (let index = 0; index < ids.length; index += 1) {
      const found = db.query(`hitamo izina muri t aho id = ${ids[index]}`);
      expect(found).toHaveLength(removed.has(ids[index]) ? 0 : 1);
    }
    for (const value of removed) {
      db.add({ collection: 't', data: { id: value, izina: 'back' } });
    }
    for (const value of ids) {
      expect(db.query(`hitamo * muri t aho id = ${value}`).length).toBeGreaterThan(0);
    }
    // A deleted row is inserted again with a new row id, so it sorts after the rows that stayed.
    const inBand = (value: number): boolean => value > 10 && value < 40;
    expect(db.query('hitamo id muri t aho id > 10 kandi id < 40').map((row) => row.id)).toEqual([
      ...ids.filter((value, index) => index % 3 !== 0 && inBand(value)),
      ...ids.filter((value, index) => index % 3 === 0 && inBand(value)),
    ]);

    db.execute('hindura t shyira id = 90000 aho izina = "u2"');
    expect(db.query('hitamo id muri t aho id = 90000')).toEqual([{ id: 90000 }]);
    expect(db.query(`hitamo * muri t aho id = ${ids[1]} kandi izina = "u2"`)).toEqual([]);
  });

  test('duplicate keys stay in row order and a limit stops there', () => {
    const db = Database.memory();
    db.execute('kora itsinda t; kora urutonde t_id muri t (id)');
    for (let seq = 1; seq <= 80; seq += 1) {
      db.add({ collection: 't', data: { id: seq % 5, seq } });
    }
    expect(db.query('hitamo seq muri t aho id = 3 imipaka 3').map((row) => row.seq)).toEqual([
      3, 8, 13,
    ]);
    expect(db.query('hitamo seq muri t aho id = 3').map((row) => row.seq)).toEqual(
      Array.from({ length: 16 }, (_, index) => 3 + index * 5),
    );
  });

  test('long string keys round-trip through overflow', () => {
    const db = Database.memory();
    db.execute('kora itsinda t; kora urutonde t_name muri t (izina)');
    const fat = 'k'.repeat(1000);
    for (let id = 1; id <= 30; id += 1) {
      db.add({ collection: 't', data: { id, izina: id === 7 ? fat : `s${id}` } });
    }
    expect(db.query('hitamo id muri t aho izina = "s3"')).toEqual([{ id: 3 }]);
    expect(db.get({ collection: 't', where: { izina: fat } })).toEqual([{ id: 7, izina: fat }]);
    db.execute('siba muri t aho id > 10 kandi id < 20');
    expect(db.query('hitamo id muri t aho izina = "s12"')).toEqual([]);
    expect(db.query('hitamo id muri t aho izina = "s20"')).toEqual([{ id: 20 }]);
    expect(db.get({ collection: 't', where: { izina: fat } })).toEqual([{ id: 7, izina: fat }]);
  });

  test('an object column is skipped by the index and does not break lookup', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      kora urutonde t_meta muri t (meta)
      kora urutonde t_id muri t (id)
    `);
    db.add({ collection: 't', data: { id: 1, meta: { a: 1 } } });
    db.add({ collection: 't', data: { id: 2, meta: 'plain' } });
    db.add({ collection: 't', data: { id: 3, meta: [1, 2] } });
    expect(db.query('hitamo id, meta muri t')).toEqual([
      { id: 1, meta: { a: 1 } },
      { id: 2, meta: 'plain' },
      { id: 3, meta: [1, 2] },
    ]);
    expect(db.query('hitamo id muri t aho id = 1')).toEqual([{ id: 1 }]);
    expect(db.query('hitamo id muri t aho meta = "plain"')).toEqual([{ id: 2 }]);
    // A decoded array is a new value, so equality cannot match it. The planner returns nothing.
    expect(db.get({ collection: 't', where: { meta: [1, 2] } })).toEqual([]);
    expect(planAccess([{ op: 'loose', field: 'meta', value: { a: 1 } }], ['meta'], 't').kind).toBe(
      'empty',
    );
  });

  test('negative bounds stay in table order', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      shira muri t { id: 1 }
      shira muri t { id: -5 }
      shira muri t { id: 3 }
      shira muri t { id: -1 }
      shira muri t { id: 0 }
      kora urutonde t_id muri t (id)
    `);
    // Stored order of the matches is 1, then -1, then 0.
    expect(db.query('hitamo id muri t aho id >= -1 kandi id < 3').map((row) => row.id)).toEqual([
      1, -1, 0,
    ]);
  });

  test('free index pages are reused', () => {
    const store = Store.empty();
    store.createCollection('t', [{ name: 'id', type: 'number' }]);
    for (let id = 1; id <= 200; id += 1) store.add('t', { id });
    store.createIndex('i', 't', 'id');
    const pages = store.pageCount;
    store.dropIndex('i');
    expect(store.freelistCount).toBeGreaterThan(0);
    expect(store.pageCount).toBe(pages);
    store.createIndex('j', 't', 'id');
    expect(store.pageCount).toBe(pages);
    expect(store.get('t', { id: 200 })).toEqual([{ id: 200 }]);
    expect(store.names()).toEqual(['t']);
  });

  test('an equality join probes the inner index and keeps pair order', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      kora itsinda s
      shira muri t { id: 2 }
      shira muri t { id: 1 }
      shira muri s { id: 1, izina: "a" }
      shira muri s { id: 1, izina: "b" }
      shira muri s { id: 2, izina: "c" }
      shira muri s { id: 2, izina: "d" }
      kora urutonde s_id muri s (id)
    `);
    const full = [
      { id: 2, izina: 'c' },
      { id: 2, izina: 'd' },
      { id: 1, izina: 'a' },
      { id: 1, izina: 'b' },
    ];
    expect(
      db.query('hitamo t.id, s.izina muri t huza s aho t.id = s.id'),
    ).toEqual(full);
    expect(
      db.query('hitamo t.id, s.izina muri t huza s aho t.id = s.id imipaka 3'),
    ).toEqual(full.slice(0, 3));

    db.execute('kora itsinda u; shira muri u { id: "1", izina: "str" }');
    expect(
      db.query('hitamo s.izina muri u huza s aho u.id = s.id imipaka 5').map((row) => row.izina),
    ).toEqual(['a', 'b']);
    expect(db.query('hitamo u.izina muri u huza s aho u.id ni s.id imipaka 5')).toEqual([]);
  });

  test('a three-table limited join streams through both indexes', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda a
      kora itsinda b
      kora itsinda c
      shira muri a { id: 1 }
      shira muri a { id: 2 }
      shira muri b { id: 1, n: "p" }
      shira muri b { id: 1, n: "q" }
      shira muri b { id: 2, n: "r" }
      shira muri c { id: 1 }
      shira muri c { id: 2 }
      kora urutonde b_id muri b (id)
      kora urutonde c_id muri c (id)
    `);
    const sql = `
      hitamo a.id, b.n, c.id
      muri a
      huza b
      huza c
      aho a.id = b.id kandi b.id = c.id
    `;
    const full = [
      { 'a.id': 1, n: 'p', 'c.id': 1 },
      { 'a.id': 1, n: 'q', 'c.id': 1 },
      { 'a.id': 2, n: 'r', 'c.id': 2 },
    ];
    expect(db.query(sql)).toEqual(full);
    expect(db.query(`${sql} imipaka 2`)).toEqual(full.slice(0, 2));
  });
});
