import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createReplSession, main } from '../src/cli';
import { Database } from '../src/database';
import { KinDbError } from '../src/errors';
import { formatRows } from '../src/format/table';
import { PAGE_SIZE } from '../src/pager/format';
import { Store } from '../src/store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kindb-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCRIPT = `
# ishuri
kora itsinda abanyeshuri
kora itsinda abigisha

shira muri abanyeshuri { id: 1, izina: "Aline", amanota: 88, yize: nibyo }
shira muri abanyeshuri (id, izina, amanota, yize) agaciro (2, "Keza", 41, sibyo)
shira muri abigisha { id: 1, izina: "Mukama", umurimo: ubusa }

hindura abanyeshuri shyira amanota = 70 aho id = 2
hitamo izina, amanota muri abanyeshuri aho amanota >= 50 kandi yize = nibyo imipaka 10
`;

describe('Kinyarwanda SQL', () => {
  test('creates, inserts, updates, and selects', () => {
    const db = Database.memory();
    const result = db.execute(SCRIPT);
    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(1);
    expect(result.last).toEqual({
      kind: 'select',
      rows: [{ izina: 'Aline', amanota: 88 }],
    });
    expect(db.get({ collection: 'abanyeshuri', where: { id: 2 } })).toEqual([
      { id: 2, izina: 'Keza', amanota: 70, yize: false },
    ]);
    expect(db.get({ collection: 'abigisha' })[0].umurimo).toBeNull();
  });

  test('accepts uppercase keywords, comments, and semicolons', () => {
    const db = Database.memory();
    db.execute(`
      KORA ITSINDA abakoresha;
      SHIRA MURI abakoresha { id: 1, izina: "Pacifique" };
      -- comment
      HITAMO * MURI abakoresha AHO izina = "Pacifique"
    `);
    expect(db.collections()).toEqual(['abakoresha']);
    expect(db.query('HITAMO izina MURI abakoresha')).toEqual([{ izina: 'Pacifique' }]);
  });

  test('comparison words match lt gt lte gte eq', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda abanyeshuri
      shira muri abanyeshuri { id: 1, amanota: 10 }
      shira muri abanyeshuri { id: 2, amanota: 20 }
      shira muri abanyeshuri { id: 3, amanota: 30 }
    `);
    const rows = db.query(`
      hitamo id muri abanyeshuri
      aho amanota munsi 30 kandi amanota hejuru 10 kandi id ni 2
    `);
    expect(rows).toEqual([{ id: 2 }]);
    expect(
      db.get({
        collection: 'abanyeshuri',
        where: { amanota: { lt: 30, gt: 10 } },
        limit: 1,
      }),
    ).toEqual([{ id: 2, amanota: 20 }]);
  });

  test('loose equality matches a number to its numeric string', () => {
    const db = Database.memory();
    db.createCollection('users');
    db.add({ collection: 'users', data: { id: '1', username: 'leerob' } });
    expect(db.get({ collection: 'users', where: { id: 1 } })).toEqual([
      { id: '1', username: 'leerob' },
    ]);
    expect(db.get({ collection: 'users', where: { id: { eq: 1 } } })).toEqual([]);
  });

  test('projects missing columns as null and applies limit', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      shira muri t { id: 1 }
      shira muri t { id: 2 }
      shira muri t { id: 3 }
    `);
    expect(db.query('hitamo id, izina muri t imipaka 2')).toEqual([
      { id: 1, izina: null },
      { id: 2, izina: null },
    ]);
    expect(db.query('hitamo * muri t imipaka 0')).toEqual([]);
  });

  test('deletes every match and refuses an empty where', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda t
      shira muri t { id: 1, kind: "a" }
      shira muri t { id: 2, kind: "a" }
      shira muri t { id: 3, kind: "b" }
    `);
    expect(db.execute('siba muri t aho kind = "a"').deleted).toBe(2);
    expect(db.get({ collection: 't' })).toEqual([{ id: 3, kind: 'b' }]);
    expect(() => db.del({ collection: 't', where: {} })).toThrow(KinDbError);
  });

  test('update requires exactly one row and keeps unrelated fields', () => {
    const db = Database.memory();
    db.createCollection('users');
    db.add({
      collection: 'users',
      data: { id: 1, username: 'leerob', email: 'lee@rob.io' },
    });
    db.add({ collection: 'users', data: { id: 2, username: 'leerob', email: 'x' } });
    expect(() =>
      db.set({
        collection: 'users',
        where: { username: 'leerob' },
        data: { email: 'new@kin.rw' },
      }),
    ).toThrow(/More than one record/);
    db.set({
      collection: 'users',
      where: { id: 1 },
      data: { email: 'leerobin@gmail.com' },
    });
    expect(db.get({ collection: 'users', where: { id: 1 } })[0]).toEqual({
      id: 1,
      username: 'leerob',
      email: 'leerobin@gmail.com',
    });
  });

  test('rolls back a script when a later statement fails', () => {
    const db = Database.memory();
    expect(() =>
      db.execute(`
        kora itsinda t
        shira muri t { id: 1 }
        siba muri t aho id = 9
      `),
    ).toThrow(/No record/);
    expect(db.collections()).toEqual([]);
  });

  test('siba byose removes every collection', () => {
    const db = Database.memory();
    db.execute('kora itsinda t shira muri t { id: 1 }');
    db.delAll();
    expect(db.collections()).toEqual([]);
    expect(() => db.get({ collection: 't' })).toThrow(/was not found/);
  });

  test('rejects duplicate collections, bad operators, and syntax', () => {
    const db = Database.memory();
    db.createCollection('t');
    expect(() => db.createCollection('t')).toThrow(/already exists/);
    expect(() => db.get({ collection: 't', where: { id: { like: 1 } as never } })).toThrow(
      /not supported/,
    );
    expect(() => db.execute('hitamo muri t')).toThrow(KinDbError);
  });
});

describe('.db and .kindb files', () => {
  test('round-trips a .db file and reads a json-base document', () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    const db = Database.open(file, { create: true });
    db.execute(SCRIPT);
    const reopened = Database.open(file);
    expect(reopened.get({ collection: 'abanyeshuri' })).toHaveLength(2);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 13).toString('utf8')).toBe('KinDB page v1');
    expect(bytes.length % PAGE_SIZE).toBe(0);
    expect(reopened.get({ collection: 'abanyeshuri', where: { id: 2 } })[0].amanota).toBe(70);
    expect(reopened.get({ collection: 'abanyeshuri', where: { id: 1 } })[0].yize).toBe(true);

    const legacy = path.join(dir, 'database.json');
    writeFileSync(
      legacy,
      JSON.stringify({
        $schema: 'http://json-schema.org/draft-04/schema#',
        db: { users: [{ id: '1', username: 'leerob' }] },
      }),
    );
    const fromJsonBase = Database.open(legacy);
    expect(fromJsonBase.get({ collection: 'users', where: { username: 'leerob' } })).toEqual([
      { id: '1', username: 'leerob' },
    ]);
    fromJsonBase.execute('hitamo id muri users');
    expect(readFileSync(legacy).subarray(0, 13).toString('utf8')).toBe('KinDB page v1');
    expect(Database.open(legacy).get({ collection: 'users' })[0].id).toBe('1');
  });

  test('runFile executes a .kindb script into a .db file', () => {
    const dir = tempDir();
    const script = path.join(dir, 'ishuri.kindb');
    const file = path.join(dir, 'ishuri.db');
    writeFileSync(script, SCRIPT);
    const result = Database.runFile(script, { db: file });
    expect(result.rows[0]).toEqual([{ izina: 'Aline', amanota: 88 }]);
    expect(Database.open(file).collections().sort()).toEqual(['abanyeshuri', 'abigisha']);
  });

  test('does not write the file when a script fails', () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    const db = Database.open(file, { create: true });
    db.createCollection('t');
    expect(() => db.execute('shira muri t { id: 1 } siba muri missing aho id = 1')).toThrow(
      /was not found/,
    );
    expect(Database.open(file).get({ collection: 't' })).toEqual([]);
  });
});

describe('kindb cli', () => {
  test('init, exec, and run', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    const script = path.join(dir, 'query.kindb');
    writeFileSync(script, 'hitamo * muri abanyeshuri');
    const logs: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(['init', file])).toBe(0);
      expect(readFileSync(file).length).toBe(PAGE_SIZE * 2);
      expect(readFileSync(file).subarray(0, 13).toString('utf8')).toBe('KinDB page v1');
      expect(await main(['init', file])).toBe(1);
      expect(
        await main([
          'exec',
          'kora itsinda abanyeshuri shira muri abanyeshuri { id: 1, izina: "Aline" }',
          '--db',
          file,
        ]),
      ).toBe(0);
      expect(await main(['run', script, '--db', file, '--no-create'])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(logs.join('')).toContain('Aline');
    expect(Database.open(file).get({ collection: 'abanyeshuri' })).toHaveLength(1);
  });

  test('exec applies the .kindb beside an empty .db before the query', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    writeFileSync(path.join(dir, 'ishuri.kindb'), SCRIPT);
    writeFileSync(file, '{ "kindb": 1, "db": {} }\n');
    const logs: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(['exec', 'hitamo * muri abanyeshuri', '--db', file])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    const printed = logs.join('');
    expect(printed).toContain('Aline');
    expect(printed.startsWith('┌') || printed.includes('\n┌')).toBe(true);
    expect(printed).toContain('(2 rows)');
    expect(printed).not.toContain('"izina"');
    expect(Database.open(file).collections().sort()).toEqual(['abanyeshuri', 'abigisha']);
  });

  test('repl runs a finished statement on one Enter', () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    writeFileSync(path.join(dir, 'ishuri.kindb'), SCRIPT);
    writeFileSync(file, '{ "kindb": 1, "db": {} }\n');
    const seeded = Database.open(file);
    seeded.execute(SCRIPT);
    const session = createReplSession(Database.open(file));
    const step = session.push('hitamo * muri abanyeshuri');
    expect(step.exit).toBe(false);
    expect(step.prompt).toBe('kindb> ');
    expect(step.output).toContain('Aline');
    expect(step.output).toContain('Keza');
    expect(step.output.startsWith('┌')).toBe(true);
    expect(step.output).toContain('(2 rows)');
    expect(step.output).not.toContain('"izina"');

    const open = session.push('shira muri abanyeshuri {');
    expect(open.prompt).toBe('...> ');
    expect(open.output).toBe('');
    const done = session.push('id: 3, izina: "Kaliza", amanota: 75, yize: nibyo }');
    expect(done.prompt).toBe('kindb> ');
    expect(done.error).toBe('');
    expect(Database.open(file).get({ collection: 'abanyeshuri' })).toHaveLength(3);
  });

  test('run does not apply the .kindb beside an empty .db', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    const script = path.join(dir, 'query.kindb');
    writeFileSync(path.join(dir, 'ishuri.kindb'), SCRIPT);
    writeFileSync(file, '{ "kindb": 1, "db": {} }\n');
    writeFileSync(script, 'hitamo * muri abanyeshuri');
    expect(await main(['run', script, '--db', file])).toBe(1);
    expect(Database.open(file).collections()).toEqual([]);
  });
});

describe('pages, types, and join', () => {
  test('declares column types and still allows a schemaless collection', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda abanyeshuri (id umubare, izina ijambo, yize ukuri)
      shira muri abanyeshuri { id: 1, izina: "Aline", yize: nibyo, extra: 1 }
    `);
    expect(db.get({ collection: 'abanyeshuri' })).toEqual([
      { id: 1, izina: 'Aline', yize: true, extra: 1 },
    ]);
    expect(() => db.execute('shira muri abanyeshuri { id: "1", izina: "Keza" }')).toThrow(
      /expects a number/,
    );
    expect(() => db.execute('kora itsinda t (id umubare, id ijambo)')).toThrow(/Duplicate column/);
    expect(() => db.execute('kora itsinda u (id integer)')).toThrow(/not umubare/);
    db.execute('kora itsinda w shira muri w { id: 1 }');
    expect(db.get({ collection: 'w' })).toEqual([{ id: 1 }]);
  });

  test('inner join with selection', () => {
    const db = Database.memory();
    db.execute(`
      kora itsinda abanyeshuri (id umubare, izina ijambo, mwarimu umubare)
      kora itsinda abigisha (id umubare, umwarimu ijambo)
      shira muri abanyeshuri { id: 1, izina: "Aline", mwarimu: 1 }
      shira muri abanyeshuri { id: 2, izina: "Keza", mwarimu: 2 }
      shira muri abigisha { id: 1, umwarimu: "Mukama" }
      shira muri abigisha { id: 2, umwarimu: "Kalisa" }
    `);
    expect(
      db.query(`
        hitamo a.izina, b.umwarimu
        muri abanyeshuri a
        huza abigisha b
        aho a.mwarimu = b.id kandi a.id = 1
      `),
    ).toEqual([{ izina: 'Aline', umwarimu: 'Mukama' }]);
    expect(
      db.query('hitamo a.id, b.id muri abanyeshuri a huza abanyeshuri b aho a.id < b.id'),
    ).toEqual([{ 'a.id': 1, 'b.id': 2 }]);
    expect(
      db.query(`
        hitamo *
        muri abanyeshuri a
        huza abigisha b
        aho a.mwarimu = b.id kandi a.id = 1
      `)[0],
    ).toMatchObject({ izina: 'Aline', umwarimu: 'Mukama', 'a.id': 1, 'b.id': 1 });
    expect(() => db.query('hitamo * muri abanyeshuri huza abanyeshuri')).toThrow(/already in use/);
    expect(() =>
      db.query('hitamo id muri abanyeshuri a huza abigisha b aho a.mwarimu = b.id'),
    ).toThrow(/ambiguous/);
  });

  test('a tall btree keeps row order, spills overflow, and reuses the freelist', () => {
    const store = Store.empty();
    store.createCollection('t', [
      { name: 'id', type: 'number' },
      { name: 'izina', type: 'string' },
    ]);
    const fat = 'z'.repeat(300);
    for (let id = 1; id <= 800; id += 1) {
      store.add('t', { id, izina: id === 400 ? fat : `u${id}` });
    }
    expect(store.pageCount).toBeGreaterThan(4);
    expect(store.pageCount).toBeLessThan(400);

    const opened = Store.fromBytes(store.toBytes());
    expect(opened.rows('t').map((row) => row.id)).toEqual(range(1, 800));
    expect(opened.rows('t')[399].izina).toBe(fat);

    store.updateWhere('t', [{ op: 'eq', field: 'id', value: 100 }], { izina: 'hindutse' });
    store.deleteWhere('t', [{ op: 'eq', field: 'id', value: 400 }]);
    store.deleteWhere('t', [{ op: 'lt', field: 'id', value: 100 }]);
    const kept = store.rows('t');
    expect(kept.map((row) => row.id)).toEqual([...range(100, 399), ...range(401, 800)]);
    expect(kept.find((row) => row.id === 100)?.izina).toBe('hindutse');

    const high = store.pageCount;
    store.deleteWhere('t', [{ op: 'gte', field: 'id', value: 1 }]);
    expect(store.rows('t')).toEqual([]);
    expect(store.freelistCount).toBeGreaterThan(0);
    expect(store.pageCount).toBe(high);
    for (let id = 1; id <= 800; id += 1) {
      store.add('t', { id, izina: `u${id}` });
    }
    expect(store.pageCount).toBe(high);
    expect(store.rows('t').map((row) => row.id)).toEqual(range(1, 800));

    store.dropCollection('t');
    expect(store.names()).toEqual([]);
    store.createCollection('t');
    store.add('t', { id: 1, izina: 'Aline' });
    expect(Store.fromBytes(store.toBytes()).rows('t')).toEqual([{ id: 1, izina: 'Aline' }]);
  });
});

describe('table output', () => {
  test('renders rows as a bordered table', () => {
    expect(
      formatRows([
        { id: 1, izina: 'Aline', yize: true },
        { id: 2, izina: 'Keza', yize: false },
      ]),
    ).toBe(
      [
        '┌────┬───────┬───────┐',
        '│ id │ izina │ yize  │',
        '├────┼───────┼───────┤',
        '│  1 │ Aline │ true  │',
        '│  2 │ Keza  │ false │',
        '└────┴───────┴───────┘',
        '(2 rows)',
        '',
      ].join('\n'),
    );
    expect(formatRows([{ id: 1, note: null }])).toBe(
      ['┌────┬──────┐', '│ id │ note │', '├────┼──────┤', '│  1 │ null │', '└────┴──────┘', '(1 row)', ''].join(
        '\n',
      ),
    );
    expect(formatRows([])).toBe('(0 rows)\n');
  });

  test('exec prints the table for every hitamo', async () => {
    const dir = tempDir();
    const logs: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(
        await main([
          'exec',
          'kora itsinda t shira muri t { id: 1, izina: "Aline" } shira muri t { id: 2, izina: "Keza" } hitamo izina muri t imipaka 1 hitamo id muri t',
        ]),
      ).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    const printed = logs.join('');
    expect(printed).toContain('(1 row)');
    expect(printed).toContain('(2 rows)');
    expect(printed).not.toContain('"izina"');
    expect(printed.match(/┌/g)).toHaveLength(2);
  });
});

function range(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += 1) values.push(value);
  return values;
}
