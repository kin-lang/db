import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Database } from '../src/database';
import { KinDbError } from '../src/errors';
import { model } from '../src/orm';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kindb-orm-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const Students = model('abanyeshuri', {
  id: 'number',
  izina: 'string',
  amanota: 'number',
  yize: 'boolean',
  note: 'any',
});

describe('orm', () => {
  test('creates a typed collection and reads it back with where and limit', () => {
    const db = Database.memory();
    const students = Students.on(db);
    students.kora();
    expect(students.shira({ id: 1, izina: 'Aline', amanota: 88, yize: true, note: null })).toEqual({
      id: 1,
      izina: 'Aline',
      amanota: 88,
      yize: true,
      note: null,
    });
    students.shira({ id: 2, izina: 'Keza', amanota: 40, yize: false, note: { text: 'see' } });
    students.hindura({ where: { id: 1 }, data: { amanota: 90 } });
    expect(students.hitamo({ where: { amanota: { gte: 50 } }, limit: 10 })).toEqual([
      { id: 1, izina: 'Aline', amanota: 90, yize: true, note: null },
    ]);
    expect(students.hitamo({ where: { id: '1' } })).toEqual([
      { id: 1, izina: 'Aline', amanota: 90, yize: true, note: null },
    ]);
    expect(students.siba({ where: { id: 2 } })).toBe(1);
    expect(students.hitamo()).toEqual([
      { id: 1, izina: 'Aline', amanota: 90, yize: true, note: null },
    ]);
    expect(() => students.kora()).toThrow(/already exists/);
  });

  test('normalizes Kinyarwanda and English field names to column types', () => {
    const defined = model('abanyeshuri', {
      a: 'number',
      b: 'umubare',
      c: 'string',
      d: 'ijambo',
      e: 'boolean',
      f: 'ukuri',
      g: 'any',
      h: 'ikintu',
      i: 'Umubare',
      j: 'NUMBER',
    });
    expect(defined.collection).toBe('abanyeshuri');
    expect(defined.columns).toEqual([
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
      { name: 'c', type: 'string' },
      { name: 'd', type: 'string' },
      { name: 'e', type: 'boolean' },
      { name: 'f', type: 'boolean' },
      { name: 'g', type: 'any' },
      { name: 'h', type: 'any' },
      { name: 'i', type: 'number' },
      { name: 'j', type: 'number' },
    ]);
  });

  test('rejects a bad description, an unknown field, and a value of the wrong type', () => {
    expect(() => model('abanyeshuri', { id: 'itaribyo' as 'number' })).toThrow(/itaribyo/);
    expect(() => model('1bad', { id: 'number' })).toThrow(/Collection name/);
    expect(() => model('t', { '1id': 'number' })).toThrow(/Field '1id'/);
    expect(() => model('t', { id: 1 as unknown as 'number' })).toThrow(/has type '1'/);
    expect(() => model('t', ['number'] as unknown as { id: 'number' })).toThrow(
      /object of field types/,
    );

    const db = Database.memory();
    const students = model('abanyeshuri', { id: 'number', izina: 'string', yize: 'ukuri' }).on(db);
    students.kora();
    expect(() => students.shira({ id: 1, extra: true } as { id: number })).toThrow(/not on model/);
    expect(() => students.shira({ id: '1' } as { id: number })).toThrow(/expects a number/);
    expect(() => students.shira({ id: 1, yize: 'yes' } as { id: number })).toThrow(/nibyo or sibyo/);
    students.shira({ id: 1, izina: 'Aline' });
    expect(() => students.hindura({ where: { id: 1 }, data: { id: 'x' } as { id: number } })).toThrow(
      /expects a number/,
    );
    expect(students.hitamo()).toEqual([{ id: 1, izina: 'Aline' }]);
    expect(db.get({ collection: 'abanyeshuri' })).toEqual([{ id: 1, izina: 'Aline' }]);
  });

  test('where must name a field on the model', () => {
    const db = Database.memory();
    const students = model('abanyeshuri', { id: 'number' }).on(db);
    students.kora();
    students.shira({ id: 1 });
    expect(() => students.hitamo({ where: { izina: 'Aline' } as { id: number } })).toThrow(
      /not on model/,
    );
    expect(() => students.siba({ where: { izina: 'Aline' } as { id: number } })).toThrow(
      /not on model/,
    );
    let code = '';
    try {
      students.siba({ where: { id: 9 } });
    } catch (error) {
      expect(error).toBeInstanceOf(KinDbError);
      code = (error as KinDbError).code;
    }
    expect(code).toBe('E_NOT_FOUND');
    expect(students.hitamo()).toEqual([{ id: 1 }]);
  });

  test('one model definition binds to two databases', () => {
    const first = Database.memory();
    const second = Database.memory();
    Students.on(first).kora();
    Students.on(second).kora();
    Students.on(first).shira({ id: 1, izina: 'Aline' });
    expect(Students.on(second).hitamo()).toEqual([]);
    expect(Students.on(first).hitamo({ where: { id: 1 } })).toEqual([
      { id: 1, izina: 'Aline' },
    ]);
  });

  test('an empty field list stores an empty row', () => {
    const db = Database.memory();
    const logs = model('logs', {}).on(db);
    logs.kora();
    expect(logs.shira({})).toEqual({});
    expect(logs.hitamo()).toEqual([{}]);
  });

  test('a repository opened before the transaction writes the file once', () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    const db = Database.open(file, { create: true });
    const students = Students.on(db);
    students.kora();
    const before = readFileSync(file);

    db.transaction(() => {
      students.shira({ id: 1, izina: 'Aline', amanota: 88 });
      students.hindura({ where: { id: 1 }, data: { amanota: 90 } });
      expect(readFileSync(file)).toEqual(before);
      expect(Database.open(file).get({ collection: 'abanyeshuri' })).toEqual([]);
    });

    expect(Database.open(file).get({ collection: 'abanyeshuri' })).toEqual([
      { id: 1, izina: 'Aline', amanota: 90 },
    ]);
  });

  test('a repository on the transaction writes once, and a failure rolls back', () => {
    const dir = tempDir();
    const file = path.join(dir, 'ishuri.db');
    const db = Database.open(file, { create: true });
    const before = readFileSync(file);

    db.transaction((tx) => {
      const students = Students.on(tx);
      students.kora();
      students.shira({ id: 1, izina: 'Aline', amanota: 88 });
      students.siba({ where: { id: 1 } });
      expect(readFileSync(file)).toEqual(before);
    });
    expect(Database.open(file).collections()).toEqual(['abanyeshuri']);
    expect(Database.open(file).get({ collection: 'abanyeshuri' })).toEqual([]);

    const afterCreate = readFileSync(file);
    expect(() =>
      db.transaction((tx) => {
        Students.on(tx).shira({ id: 2, izina: 'Keza', amanota: 40 });
        Students.on(tx).siba({ where: { id: 9 } });
      }),
    ).toThrow(KinDbError);
    expect(readFileSync(file)).toEqual(afterCreate);
    expect(db.get({ collection: 'abanyeshuri' })).toEqual([]);
  });
});
