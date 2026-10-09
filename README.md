# @kin-lang/db

In-memory relational database with **Kinyarwanda SQL**. Records live in named tables. CRUD matches [`json-base`](https://www.npmjs.com/package/@ndzhwr/json-base): get (with `where` and `limit`), add, set, del, and delAll. The relational operators are selection (`aho`) and inner join (`huza`).

The package is standalone. It reads and writes a `.db` page file, runs a `.kindb` script, and is what Kin calls through `KIN_UBUBIKO`.

```bash
npm install @kin-lang/db
```

## Kinyarwanda SQL

Keywords are case-insensitive. `#` and `--` comment to the end of the line. Semicolons between statements are optional.

```sql
kora itsinda abanyeshuri (id umubare, izina ijambo, mwarimu umubare, yize ukuri)
kora itsinda abigisha (id umubare, umwarimu ijambo)
shira muri abanyeshuri { id: 1, izina: "Aline", mwarimu: 1, yize: nibyo }
shira muri abanyeshuri (id, izina) agaciro (2, "Keza")

hindura abanyeshuri shyira amanota = 90 aho id = 1
siba muri abanyeshuri aho id = 2
siba itsinda abanyeshuri
siba byose

hitamo * muri abanyeshuri
hitamo izina, amanota muri abanyeshuri aho amanota >= 50 kandi yize = nibyo imipaka 10
hitamo a.izina, b.umwarimu muri abanyeshuri a huza abigisha b aho a.mwarimu = b.id
```

| Statement | SQL | json-base |
| --- | --- | --- |
| `kora itsinda` | create table | a key under `db` |
| `kora itsinda name (col type, ...)` | create with column types | — |
| `shira muri` | `INSERT` | `add` |
| `hitamo ... muri ... aho ... imipaka` | selection, projection, limit | `get` |
| `hitamo ... muri ... huza ... aho` | inner join, then selection | — |
| `hindura ... shyira ... aho` | `UPDATE` | `set` (exactly one match) |
| `siba muri ... aho` | `DELETE` | `del` (every match) |
| `siba itsinda` | drop table | delete that key |
| `siba byose` | wipe | `delAll` |

`aho` comparisons are combined with `kandi` only.

| Form | Meaning |
| --- | --- |
| `=` or `==` | equality; the number `1` also matches the string `"1"` |
| `<` `munsi` | less than |
| `<=` `munsi_cyangwa` | less than or equal |
| `>` `hejuru` | greater than |
| `>=` `hejuru_cyangwa` | greater than or equal |
| `ni` | numeric equality (`1` matches `1`, not `"1"`) |

Values are numbers, `"strings"`, `nibyo`, `sibyo`, and `ubusa`.

`kora itsinda` may list columns and types: `umubare` (number), `ijambo` (string), `ukuri` (`nibyo` or `sibyo`), and `ikintu` (any JSON value). Without that list, columns appear when you insert. A declared column rejects a value of the wrong type. `null` (`ubusa`) is allowed in every column.

`huza` is an inner join. `aho` is selection. A predicate that names one table is applied to that table, and a predicate that names both sides is the join condition. Use an alias when the same table appears twice (`muri abanyeshuri a huza abanyeshuri b`). There is no `OR`, no outer join, no `ORDER BY`, and no `GROUP BY`.

`hindura` changes the fields you list and leaves the others in place. Numbers stay numbers.

## Files

A `.kindb` file is a script of those statements. A `.db` file is a page file, the same idea as SQLite scaled down to this package:

- every page is 512 bytes
- page 1 is the file header and starts with `KinDB page v1`
- each table is a btree of rows, addressed by an internal row id
- a value that does not fit in its cell continues on overflow pages
- pages released by delete sit on a freelist and are reused
- the file does not shrink; the freelist hands those pages out again
- a save writes the pages that changed. The whole file is written when it is created, when it is still JSON, or when `save` is pointed at a new path

An older JSON `.db` (`{ "kindb": 1, "db": { } }`) and a json-base file (`{ "$schema": "...", "db": { } }`) still open. The next save rewrites them as pages. `collections()` does not list the hidden schema table.

## JavaScript

`require('@kin-lang/db')` and `import` both work. Kin loads this package with `require`.

```ts
import { Database } from '@kin-lang/db'

const db = Database.open('./ishuri.db', { create: true })
db.execute(`
  kora itsinda abanyeshuri
  shira muri abanyeshuri { id: 1, izina: "Aline", amanota: 88 }
`)

const passed = db.query('hitamo izina muri abanyeshuri aho amanota >= 50')

db.add({ collection: 'abanyeshuri', data: { id: 2, izina: 'Keza', amanota: 41 } })
db.get({ collection: 'abanyeshuri', where: { amanota: { gte: 50 } }, limit: 10 })
db.set({ collection: 'abanyeshuri', where: { id: 1 }, data: { amanota: 91 } })
db.del({ collection: 'abanyeshuri', where: { id: 2 } })
db.delAll()
```

`Database.memory()` never touches the disk until `save(path)`. `execute` rolls the in-memory pages back when a statement fails, and it does not write the file in that case. The rollback keeps the previous page buffers; it does not copy the whole file. A statement that changes nothing does not rewrite the file. `add`, `set`, and `del` write the pages that changed. `get` returns copies of the rows. `imipaka` and `get(..., limit)` stop once that many rows have matched. An equality `huza` is hashed, so it does not build the cartesian product.

`where` accepts the json-base operators `lt`, `lte`, `gt`, `gte`, and `eq`, plus `munsi`, `munsi_cyangwa`, `hejuru`, `hejuru_cyangwa`, and `ni`.

```ts
const script = new URL('./examples/ishuri.kindb', import.meta.url)
Database.runFile(script, { db: './ishuri.db' })
```

## CLI

```bash
npx kindb init ishuri.db
npx kindb run examples/ishuri.kindb --db ishuri.db
npx kindb exec "HITAMO * MURI abanyeshuri" --db ishuri.db
npx kindb repl --db ishuri.db
```

Press Enter to run the statement you just typed. A line that still has an open `{` waits for the rest. `.exit` leaves the prompt.

`exec`, `repl`, and `run` print each `hitamo` as a table. Numbers are right-aligned. A null cell is the word `null`.

```
┌────┬───────┬─────────┬───────┐
│ id │ izina │ amanota │ yize  │
├────┼───────┼─────────┼───────┤
│  1 │ Aline │      88 │ true  │
│  2 │ Keza  │      70 │ false │
└────┴───────┴─────────┴───────┘
(2 rows)
```

`exec` and `repl` load `ishuri.kindb` automatically when `ishuri.db` exists beside it and still has no collections. `run` does not: it executes only the script you name. `run` creates a missing `--db` file. Pass `--no-create` to refuse. Without `--db`, the script runs in memory and each `hitamo` is still printed as a table.

## Kin

From a `.kin` file, after this package is installed next to Kin:

```kin
reka db = KIN_UBUBIKO.fungura("ishuri.db")
db.baza("KORA ITSINDA abanyeshuri")
db.shira("abanyeshuri", { id: 1, izina: "Aline", amanota: 88 })
reka abatsinze = db.hitamo("abanyeshuri", { amanota: { hejuru_cyangwa: 50 } })
tangaza_amakuru(abatsinze)
db.bika()
```

`KIN_UBUBIKO.mu_mutwe()` is a memory database. Paths are relative to the `.kin` file, same as `KIN_INYANDIKO`. See `examples/ububiko` in the Kin repository.

## Errors

Failures throw `KinDbError` with a `code`:

| Code | When |
| --- | --- |
| `E_SYNTAX` | The script does not parse. `incomplete` is true at EOF mid-statement. |
| `E_COLLECTION_MISSING` | The collection is not in the database. |
| `E_COLLECTION_EXISTS` | `kora itsinda` used an existing name. |
| `E_MISSING_PARAM` | `where` or another required piece is missing. |
| `E_NOT_FOUND` | `hindura` / `siba` matched nothing. |
| `E_DUPLICATE` | `hindura` matched more than one row. |
| `E_OPERATOR` | The comparison is not one of lt/gt/lte/gte/eq. |
| `E_TYPE` | A value, limit, or name has the wrong shape. |
| `E_IO` | The `.db` or `.kindb` file cannot be read or written. |

## Development

```bash
npm install
npm test
npm run build
```

The published entry is `dist/index.js`. The `kindb` binary is `dist/cli.js`.
