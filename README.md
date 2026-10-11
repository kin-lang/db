# @kin-lang/db

In-memory relational database with **Kinyarwanda SQL**. Records live in named tables. CRUD matches [`json-base`](https://www.npmjs.com/package/@ndzhwr/json-base): get (with `where` and `limit`), add, set, del, and delAll. The relational operators are selection (`aho`) and inner join (`huza`).

The package is standalone. It reads and writes a `.db` page file, runs a `.kindb` script, and is what Kin calls through `KIN_UBUBIKO`. Collection models are imported from `@kin-lang/db/orm`.

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

kora urutonde abanyeshuri_id muri abanyeshuri (id)
siba urutonde abanyeshuri_id
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
| `kora urutonde name muri table (column)` | index on one column | — |
| `siba urutonde name` | drop that index | — |

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

`kora urutonde` builds an index on one column. An index cannot list two columns. `collections()` does not list indexes. Dropping a table drops the indexes on it. The planner uses an index for an equality lookup and for a bounded comparison such as `amanota > 50 kandi amanota < 90`. An equality `huza` probes the inner index when the query has `imipaka`, or when the outer side is itself an equality. A full equality join with no limit stays hashed. Rows come back in stored order. The original predicate is checked again, so `1` still matches `"1"` and `ni` still does not.

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

```ts
const rows = db.transaction((tx) => {
  tx.createCollection('abanyeshuri')
  tx.add({ collection: 'abanyeshuri', data: { id: 1, izina: 'Aline', amanota: 88 } })
  tx.add({ collection: 'abanyeshuri', data: { id: 2, izina: 'Keza', amanota: 41 } })
  tx.set({ collection: 'abanyeshuri', where: { id: 1 }, data: { amanota: 95 } })
  tx.del({ collection: 'abanyeshuri', where: { id: 2 } })
  return tx.get({ collection: 'abanyeshuri' })
})
```

`Database.memory()` never touches the disk until `save(path)`. `execute` rolls the in-memory pages back when a statement fails, and it does not write the file in that case. The rollback keeps the previous page buffers; it does not copy the whole file. A statement that changes nothing does not rewrite the file. Outside a transaction, `add`, `set`, and `del` write the pages that changed. `get` returns copies of the rows. `imipaka` and `get(..., limit)` stop once that many rows have matched. An equality `huza` is hashed, so it does not build the cartesian product.

`transaction(callback)` is the explicit way to group those writes. The callback receives a transaction handle with the same methods. `add`, `set`, `del`, `execute`, and the other mutating methods — on that handle or on the database — change memory only while the callback runs. They do not each write the file. A model from `@kin-lang/db/orm` joins that transaction through `kora`, `shira`, `hindura`, and `siba`. The file is written once when the outermost callback returns. A throw restores the pages from the start of that callback and leaves the file untouched. The callback must finish synchronously; a returned promise is rejected and the changes are rolled back. `save()` inside a callback throws `E_TRANSACTION`. A nested `transaction()` is a savepoint: catching its error keeps the outer changes, and only the outermost success writes the file.

`where` accepts the json-base operators `lt`, `lte`, `gt`, `gte`, and `eq`, plus `munsi`, `munsi_cyangwa`, `hejuru`, `hejuru_cyangwa`, and `ni`. `get`, `set`, and `del` use the same planner as `hitamo`, so an equality on an indexed column does not walk the table.

```ts
const script = new URL('./examples/ishuri.kindb', import.meta.url)
Database.runFile(script, { db: './ishuri.db' })
```

## ORM

`import { model } from '@kin-lang/db/orm'` describes one collection. `on` binds that description to a database or a transaction. `kora`, `shira`, `hitamo`, `hindura`, and `siba` call that session. Inside `transaction()`, those calls change memory only, and the file is written once when the outermost callback returns.

Field types are `number`, `string`, `boolean`, and `any`. The Kinyarwanda names `umubare`, `ijambo`, `ukuri`, and `ikintu` name the same types. `null` is allowed in every field. `shira` and `hindura` accept the listed fields, and a value has to match its field. `where` uses the same comparisons as `Database.get`. Each key has to be a field on the model.

```ts
import { Database } from '@kin-lang/db'
import { model } from '@kin-lang/db/orm'

const Abanyeshuri = model('abanyeshuri', {
  id: 'number',
  izina: 'string',
  amanota: 'number',
  yize: 'boolean',
})

const db = Database.open('./ishuri.db', { create: true })
const abanyeshuri = Abanyeshuri.on(db)
abanyeshuri.kora()
abanyeshuri.shira({ id: 1, izina: 'Aline', amanota: 88, yize: true })
abanyeshuri.shira({ id: 2, izina: 'Keza', amanota: 41, yize: false })
abanyeshuri.hitamo({ where: { amanota: { gte: 50 } }, limit: 10 })
abanyeshuri.hindura({ where: { id: 1 }, data: { amanota: 90 } })
abanyeshuri.siba({ where: { id: 2 } })

const rows = db.transaction((tx) => {
  const scoped = Abanyeshuri.on(tx)
  scoped.shira({ id: 3, izina: 'Kaliza', amanota: 70, yize: true })
  scoped.hindura({ where: { id: 1 }, data: { amanota: 95 } })
  return scoped.hitamo()
})
```

`kora` fails when the collection already exists. The same `model(...)` value can be bound to more than one database.

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
db.shira("abanyeshuri", { id: 2, izina: "Keza", amanota: 41 })
reka abatsinze = db.hitamo("abanyeshuri", { amanota: { hejuru_cyangwa: 50 } })
tangaza_amakuru(abatsinze)

porogaramu_ntoya andika(tx) {
  tx.shira("abanyeshuri", { id: 3, izina: "Kaliza", amanota: 70 })
  tx.hindura("abanyeshuri", { id: 1 }, { amanota: 95 })
  tx.siba("abanyeshuri", { id: 2 })
}
db.igikorwa(andika)

reka Abanyeshuri = db.icyitegererezo("abanyeshuri", {
  id: "umubare",
  izina: "ijambo",
  amanota: "umubare"
})
Abanyeshuri.shira({ id: 4, izina: "Kaliza", amanota: 70 })
reka batsinze = Abanyeshuri.hitamo({ amanota: { hejuru_cyangwa: 50 } })
```

`igikorwa` is `transaction`. `shira`, `hindura`, and `siba` inside it do not write on their own. The file is written once when the function returns. `bika` inside `igikorwa` is an error. `icyitegererezo` is the model for one collection, imported in JavaScript from `@kin-lang/db/orm`. `kora`, `shira`, `hindura`, and `siba` on that model join an open `igikorwa`. The collection already exists from `baza`, so this model does not call `kora`.

`KIN_UBUBIKO.mu_mutwe()` is a memory database. Paths are relative to the `.kin` file, same as `KIN_INYANDIKO`. See `examples/ububiko` in the Kin repository.

## Errors

Failures throw `KinDbError` with a `code`:

| Code | When |
| --- | --- |
| `E_SYNTAX` | The script does not parse. `incomplete` is true at EOF mid-statement. |
| `E_COLLECTION_MISSING` | The collection is not in the database. |
| `E_COLLECTION_EXISTS` | `kora itsinda` used an existing name. |
| `E_INDEX_EXISTS` | The index name is taken, or that column already has an index. |
| `E_INDEX_MISSING` | `siba urutonde` named an index that is not there. |
| `E_MISSING_PARAM` | `where` or another required piece is missing. |
| `E_NOT_FOUND` | `hindura` / `siba` matched nothing. |
| `E_DUPLICATE` | `hindura` matched more than one row. |
| `E_OPERATOR` | The comparison is not one of lt/gt/lte/gte/eq. |
| `E_TYPE` | A value, limit, name, or model field has the wrong shape. |
| `E_IO` | The `.db` or `.kindb` file cannot be read or written. |
| `E_TRANSACTION` | `save()` ran inside a transaction, or the callback returned a promise. |

## Development

```bash
npm install
npm test
npm run build
```

The published entries are `dist/index.js` and `dist/orm.js` (`@kin-lang/db/orm`). The `kindb` binary is `dist/cli.js`.
