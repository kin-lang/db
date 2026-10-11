# @kin-lang/db

KinDB is a small relational database you query in Kinyarwanda. Rows live in named tables. You can filter them, sort them, group them, and join two tables. The tables stay in memory while you work, and a `.db` file keeps them between runs.

You can use the same database from JavaScript, from the `kindb` command, or from a Kin program through `KIN_UBUBIKO`. A `.kindb` file is a script of statements. A typed handle for one table comes from `@kin-lang/db/orm`.

```bash
npm install @kin-lang/db
```

Node.js 18 or newer. `import` and `require('@kin-lang/db')` both work.

## Open a database

```ts
import { Database } from '@kin-lang/db'

const db = Database.open('./ishuri.db', { create: true })

db.execute(`
  kora itsinda abanyeshuri (id umubare, izina ijambo, amanota umubare, yize ukuri)
  shira muri abanyeshuri { id: 1, izina: "Aline", amanota: 88, yize: nibyo }
  shira muri abanyeshuri { id: 2, izina: "Keza", amanota: 41, yize: sibyo }
`)

const passed = db.query(
  'hitamo izina, amanota muri abanyeshuri aho amanota >= $amanota',
  { amanota: 50 },
)
```

`Database.open` loads a `.db` file. Pass `{ create: true }` when you want a missing file created. `execute` runs a script, including one that writes. `query` runs `hitamo` and returns the rows. If that script contains several `hitamo` statements, you get the rows from the last one. Every statement in `query` has to be `hitamo`, and KinDB checks that before it runs any of them.

`execute` also collects the rows from each `hitamo` in the script, along with how many rows were inserted, updated, and deleted.

`Database.memory()` stays off disk until you call `save(path)`.

To run a script you already have on disk:

```ts
const script = new URL('./examples/ishuri.kindb', import.meta.url)
Database.runFile(script, { db: './ishuri.db' })
```

## Write a statement

You can write keywords in any case. `#` and `--` comment out the rest of the line. A semicolon between statements is optional.

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
hitamo izina, amanota muri abanyeshuri tondeka amanota manuka imipaka 10
hitamo ishuri, bara(*) muri abanyeshuri koranya ishuri
hitamo a.izina, b.umwarimu muri abanyeshuri a huza abigisha b aho a.mwarimu = b.id

kora urutonde abanyeshuri_id muri abanyeshuri (id)
siba urutonde abanyeshuri_id
```

| Statement | What it does |
| --- | --- |
| `kora itsinda name` | Creates a table. Columns appear when you insert a row that uses them. |
| `kora itsinda name (col type, ...)` | Creates a table and declares each column's type. |
| `shira muri` | Inserts a row, either as a `{ ... }` object or as `(columns) agaciro (values)`. |
| `hitamo ... muri ...` | Reads rows. `aho` filters them. `imipaka` stops after that many rows. |
| `tondeka col` | Sorts. `zamuka` goes up, and it is the default. `manuka` goes down. |
| `koranya col` | Groups rows. `bara`, `teranya`, `nto`, and `nini` summarize each group. |
| `huza` | Joins another table and keeps the pairs that match. |
| `hindura ... shyira ... aho` | Updates the one row that matches. |
| `siba muri ... aho` | Deletes every row that matches. |
| `siba itsinda` | Drops a table, and the indexes on it. |
| `siba byose` | Drops every table. |
| `kora urutonde name muri table (column)` | Builds an index on one column. |
| `siba urutonde name` | Drops that index. |

On a `hitamo`, write the clauses in this order: `aho`, then `koranya`, then `tondeka`, then `imipaka`.

A name starts with a letter or `_`, then letters, digits, or `_`. A keyword such as `hitamo` or `aho` cannot be the name of a new table, column, index, or model field.

### Comparisons

Join comparisons with `kandi`. A join uses these same comparisons.

| You can write | Meaning |
| --- | --- |
| `=` or `==` | Equal. The number `1` also matches the string `"1"`. |
| `<` or `munsi` | Less than. |
| `<=` or `munsi_cyangwa` | Less than or equal. |
| `>` or `hejuru` | Greater than. |
| `>=` or `hejuru_cyangwa` | Greater than or equal. |
| `ni` | The same number. `1` matches `1`, and it stays distinct from `"1"`. |

A range comparison accepts a numeric string, so `"50" >= 50` matches. `ni` keeps the type.

Values are numbers, `"strings"`, `nibyo`, `sibyo`, and `ubusa` (null).

`hindura` and `siba` both need `aho`. `hindura` changes the fields you name and leaves the others as they are, type included. It expects one matching row. `siba` removes every match, and it reports `E_NOT_FOUND` when there is none.

### Column types

You can declare each column when you create the table:

| Type | Also written | Stores |
| --- | --- | --- |
| `umubare` | `number` | a number |
| `ijambo` | `string` | a string |
| `ukuri` | `boolean` | `nibyo` or `sibyo` |
| `ikintu` | `any` | any JSON value |

`ubusa` is allowed in every column. A declared column refuses a value of the wrong type.

Leave the column list out and the table grows columns as you insert. On an empty table like that, a `hitamo` that names a column you have never inserted tells you the column is not there yet. Once the table has columns, a missing name comes back with the list of columns that exist.

### Joining two tables

`huza` keeps the rows that match on both sides. Give each table an alias when you need to tell them apart, including when a table is joined to itself:

```sql
hitamo a.izina, b.umwarimu
muri abanyeshuri a
huza abigisha b
aho a.mwarimu = b.id
```

A comparison that names one table filters that table. A comparison that names both sides is how the rows pair up. A pair is skipped when the join columns are `ubusa`. To find nulls in one table, filter that table with `aho id = ubusa`.

For a large equality join, put an index on the column you match and add `imipaka`.

### Sorting

`tondeka` sorts the rows that matched. `ubusa` comes after every other value, in either direction. Rows that compare equal stay in stored order. `imipaka` applies after the sort, so this is the highest score:

```sql
hitamo izina, amanota muri abanyeshuri tondeka amanota manuka imipaka 1
```

On an indexed `umubare` or `ukuri` column, that `tondeka` with `imipaka` uses the index.

### Grouping

`koranya` groups rows. The summaries are calls, so you can still select a column that happens to be named `bara`.

| Call | Result name | Meaning |
| --- | --- | --- |
| `bara(*)` | `bara` | How many rows are in the group. |
| `bara(col)` | `bara_col` | How many of those rows have a value in `col`. `ubusa` is skipped. |
| `teranya(col)` | `teranya_col` | The sum of the numbers in `col`. |
| `nto(col)` | `nto_col` | The smallest value in `col`. |
| `nini(col)` | `nini_col` | The largest value in `col`. |

`hitamo bara(*) muri abanyeshuri` is one group. An empty table returns `{ bara: 0 }`. `koranya` on an empty table returns no rows. A plain column in that select list has to be one of the `koranya` columns.

```sql
hitamo ishuri, bara(*) muri abanyeshuri koranya ishuri
```

### Indexes

Create an index when you look up one value, or a short range, in a large table:

```sql
kora urutonde abanyeshuri_id muri abanyeshuri (id)
```

An index covers one column. Equality on that column finds the row directly. A range with `imipaka` uses the index and stops at that many rows. A range with no limit reads every match.

`collections()` returns your tables. Indexes stay on those tables, and dropping a table drops them too. Rows come back in stored order until you `tondeka`. An indexed lookup uses the comparison rules above, so `1` matches `"1"`, and `ni` keeps those two apart.

## How a save works

Opening a `.db` file loads it into memory.

Outside a transaction, `add`, `set`, `del`, and a successful `execute` each save when they finish. Each of those calls is its own save, so a long load belongs in `transaction`: one failure then puts the whole batch back. If any statement in an `execute` call fails, that whole call is undone in memory and the file is left as it was.

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

The callback receives a handle with the same methods. Until it returns, writes change memory only. That includes calls you make on `db` itself during the callback, and `kora`, `shira`, `hindura`, and `siba` on a model bound to that transaction. The file is written once, when the outermost callback returns.

If the callback throws, the database returns to where it was at the start of that callback, and the file stays as it was. Finish the work before the function returns. A promise is rolled back with `E_TRANSACTION`.

After the callback returns, that handle is closed. A later call on it throws `E_TRANSACTION`. The next unit of work is a new `transaction()`. `save()` inside a callback throws as well, because the transaction writes the file when the callback returns.

A nested `transaction()` is a savepoint. Catch its error and the outer changes remain. The file is written when the outermost callback succeeds. The inner handle closes when the inner callback returns.

If a save is interrupted, the file stays on the last finished version. The next open completes the recovery before it gives you the database.

A save holds the file for a moment. If another process is already saving it, the call fails with `E_IO` and asks you to close that session. If this handle was opened before some other session saved the same file, open the file again before you write.

Deleted rows leave space that later inserts reuse. The file keeps its size.

KinDB refuses a file that does not match its last finished save. It does open a `.db` from an older KinDB, including a JSON file shaped as `{ "kindb": 1, "db": { } }`. The next save writes the current format.

## Call it from JavaScript

```ts
db.add({ collection: 'abanyeshuri', data: { id: 3, izina: 'Kaliza', amanota: 70 } })
db.get({ collection: 'abanyeshuri', where: { amanota: { gte: 50 } }, limit: 10 })
db.set({ collection: 'abanyeshuri', where: { id: 1 }, data: { amanota: 91 } })
db.del({ collection: 'abanyeshuri', where: { id: 2 } })
db.delAll()
```

`add` inserts. `get` reads, and the objects it returns are copies, so changing one leaves the table alone. `set` updates the one row that matches. `del` deletes every match. `delAll` clears the database.

`where` is an object. A plain value means equal, with the same rule as `=`. Wrap a number when you want a range:

| In `where` | Same as |
| --- | --- |
| `lt`, `munsi` | `<` |
| `lte`, `munsi_cyangwa` | `<=` |
| `gt`, `hejuru` | `>` |
| `gte`, `hejuru_cyangwa` | `>=` |
| `eq`, `ni` | `ni`, so the stored value is already that number |

Several comparisons on one field all have to match. `get`, `set`, and `del` use an index the same way `hitamo` does.

`get` answers an unknown field with no rows. A `hitamo` that names a missing column tells you which columns exist.

`imipaka` and `limit` stop once that many rows have matched.

### Keep values out of the script text

Put a value in `$name` and pass it beside the script. `query` and `execute` both take that object, and the value is stored as data.

```ts
db.query('hitamo * muri abanyeshuri aho izina = $izina', { izina: userText })
```

When the statement itself has to be built as text, `sqlLiteral` quotes a value and `sqlName` quotes an identifier.

## A model for one table

`model` describes one collection. `on` binds that description to a database or to a transaction, and `kora`, `shira`, `hitamo`, `hindura`, and `siba` call that session.

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

Field types are `number`, `string`, `boolean`, and `any`. `umubare`, `ijambo`, `ukuri`, and `ikintu` name the same four. `null` is allowed in every field. `shira` and `hindura` accept the fields you listed, and a value has to match its field. Each key in `where` is a field on the model. The comparisons are the ones `Database.get` uses.

Call `kora()` once to create the table. A second call raises `E_COLLECTION_EXISTS`. The same `model(...)` value can be bound to more than one database. Inside `transaction()`, the model changes memory only, and the file is written once when the outermost callback returns.

## From the command line

```bash
npx kindb init ishuri.db
npx kindb run examples/ishuri.kindb --db ishuri.db
npx kindb exec "HITAMO * MURI abanyeshuri" --db ishuri.db
npx kindb repl --db ishuri.db
```

In the prompt, Enter runs the statement you just typed. A line that still has an open `{` waits for the rest. `.exit` leaves.

`exec`, `repl`, and `run` print each `hitamo` as a table. Numbers sit on the right. An empty cell is the word `null`.

```
┌────┬───────┬─────────┬───────┐
│ id │ izina │ amanota │ yize  │
├────┼───────┼─────────┼───────┤
│  1 │ Aline │      88 │ true  │
│  2 │ Keza  │      70 │ false │
└────┴───────┴─────────┴───────┘
(2 rows)
```

If `ishuri.db` has no tables yet and `ishuri.kindb` sits beside it, `exec` and `repl` run that script for you. `run` runs only the script you name. It creates a missing `--db` file. Pass `--no-create` when that file should already be there. Leave `--db` out and the script runs in memory, with each `hitamo` printed as a table.

`kindb help` prints the commands. `kindb version` prints the version.

## From Kin

With this package installed next to Kin, a `.kin` file opens the database like this:

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

`baza` runs a statement. `shira`, `hitamo`, `hindura`, and `siba` are the row operations. `igikorwa` groups those writes into one save, which happens when the function returns. `bika` inside `igikorwa` raises an error, because the transaction is already responsible for the save.

`icyitegererezo` is the model for one collection, the same idea as `@kin-lang/db/orm`. `kora`, `shira`, `hindura`, and `siba` on that model join an open `igikorwa`. In the example the collection already exists from `baza`, so the model goes straight to `shira`.

`KIN_UBUBIKO.mu_mutwe()` gives you a memory database. Paths are relative to the `.kin` file, the same way `KIN_INYANDIKO` resolves them. A longer example lives in `examples/ububiko` in the Kin repository.

## When a call fails

Failures throw `KinDbError`. The `code` tells you which case you hit. `isKinDbError` checks the type.

| Code | You will see it when |
| --- | --- |
| `E_SYNTAX` | The script does not parse. `incomplete` is true when the text stopped in the middle of a statement. |
| `E_COLLECTION_MISSING` | The table is not in the database. |
| `E_COLLECTION_EXISTS` | `kora itsinda` used a name that is already a table. |
| `E_INDEX_EXISTS` | That index name is taken, or that column already has an index. |
| `E_INDEX_MISSING` | `siba urutonde` named an index that is not there. |
| `E_MISSING_PARAM` | Something required was left out, such as `where` on `hindura` or `siba`. |
| `E_NOT_FOUND` | `hindura` or `siba` matched nothing. |
| `E_DUPLICATE` | `hindura` matched more than one row. |
| `E_OPERATOR` | The comparison is not `lt`, `lte`, `gt`, `gte`, `eq`, or one of their Kinyarwanda names. |
| `E_TYPE` | A value, a limit, a name, or a model field has the wrong shape. |
| `E_IO` | A `.db` or `.kindb` file could not be read or written, the save stopped, or another session has already saved this file. |
| `E_TRANSACTION` | `save()` ran inside a transaction, the callback returned a promise, or the handle is already finished. |

What changed in each release is listed in [CHANGELOG.md](./CHANGELOG.md).
