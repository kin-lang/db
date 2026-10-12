# Changelog

All notable changes to `@kin-lang/db` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How to record a change

Add bullets under `## [Unreleased]` as the work lands. Group them as `### Added`, `### Changed`, or `### Fixed`. Write what a caller can do or what a save, query, or error does now.

A push to `main`, including a merge, appends each new commit subject under `## [Unreleased]`. The commit titled `Update changelog` is ignored, so that follow-up push does not record itself.

To release the version in `package.json`:

1. Move the Unreleased notes into `## [x.y.z] - YYYY-MM-DD`. Leave the Unreleased heading in place, with an empty body.
2. Set `"version"` in `package.json` to that same `x.y.z`.
3. Commit, and push the branch that `origin` tracks.
4. Run `npm run release`.

`npm run release` asks for a GitHub personal access token and an npm token. It publishes the package, then creates the GitHub release `vX.Y.Z` whose notes are that changelog section. It does not store the tokens. It refuses a dirty tree, a commit that is not on the remote, a version that is already on npm, and a changelog that still has Unreleased notes.

Nothing was published before 0.1.0, so the notes below are the whole history of this tree, including durability, sorting, and the release scripts.

## [Unreleased]

## [0.1.0] - 2026-10-11

### Added

- Kinyarwanda SQL over 512-byte page files: `kora itsinda`, `shira muri`, `hindura`, `siba muri`, `siba itsinda`, `siba byose`, `hitamo ... muri ... aho ... kandi ... imipaka`, and `huza`. Column types are `umubare`, `ijambo`, `ukuri`, and `ikintu`. An older `{ "kindb": 1, "db": ... }` file and a json-base file still open.
- JavaScript CRUD that matches json-base: `get` (with `where` and `limit`), `add`, `set`, `del`, and `delAll`. `Database.open`, `Database.memory`, and `Database.runFile`. `KinDbError` carries a `code`.
- The `kindb` CLI: `init`, `run`, `exec`, and `repl`. `hitamo` prints as a table. `exec` and `repl` load a sibling `.kindb` when the `.db` file still has no collections.
- GitHub Actions builds the package and runs the tests on pull requests and on `main`.
- One-column indexes with `kora urutonde name muri table (column)` and `siba urutonde name`. Equality, a bounded comparison, and a limited join use the index. Writes keep it up to date.
- `db.transaction(callback)`. `add`, `set`, `del`, and `execute` change memory until the outermost callback returns, then the file is written once. A throw restores those pages and leaves the file untouched. A nested callback is a savepoint. The callback has to finish synchronously.
- Collection models at `@kin-lang/db/orm`. `model` and `on` describe a table. `kora`, `shira`, `hitamo`, `hindura`, and `siba` run against a database or a transaction.
- `tondeka col zamuka|manuka` sorts. `ubusa` sorts last in both directions, and ties stay in row id order. On an indexed `umubare` or `ukuri` column, `tondeka` with `imipaka` stops after enough rows.
- `koranya` groups rows. `bara(*)` counts rows, `bara(col)` skips `ubusa`, `teranya(col)` sums numbers, and `nto(col)` / `nini(col)` are the minimum and maximum. Result names are `bara`, `bara_col`, `teranya_col`, `nto_col`, and `nini_col`.
- `$name` placeholders for `query` and `execute`. The value is stored as data. `sqlLiteral` and `sqlName` are for the rare statement that has to be built as text, including quotes, line separators, and negative zero.
- A checksum in the page header. A file that does not match the last save is not opened. A file written before checksums still opens, and the next save adds one.
- A journal beside the database file. A save writes the previous pages, flushes them, then writes the new pages. A save that stops restores the previous file before the error returns. The next open finishes a journal that was left behind.
- A lock held only for the duration of the save. A live other process keeps its lock. A lock whose owner is gone is recovered, including a worker that was terminated in this process. An empty lock does not block the next save.
- `npm run explain-types` prints the TypeScript import tree for `src/index.ts`, `src/orm.ts`, and `src/cli.ts` from `tsc --explainFiles`. CI runs that command and fails when one of those files has no recorded imports. A push to `main` appends the landed commit subjects under Unreleased. `npm run release` publishes to npm and opens the GitHub release from this file.

### Changed

- A limited read stops once `imipaka` rows have matched, including a wide range on an indexed column. `id >= 1 imipaka 1` and `id >= 50000 imipaka 1` both stop at the next stored rows.
- The catalog is read once and kept. Inserts into many tables do not reread it on every statement.
- Rollback shares the page buffers that did not change. A save writes the dirty pages, not the whole file, except when the file is created, is still JSON, or `save` is pointed at a new path.
- An equality `huza` with `imipaka` probes an index on either table. The table that is not probed is walked in stored order. When both tables have the index, the left table is walked. A join with no limit reads each table once.
- `ubusa` does not match `ubusa` in a join. `aho id = ubusa` still finds nulls in one table. `=` still matches `1` with `"1"`. `ni` keeps the type, so `1` stays distinct from `"1"`.
- `query()` only reads. Every statement has to be `hitamo`, and that check happens before anything runs. A write belongs in `execute`.
- The transaction handle closes when its callback returns. Later calls throw `E_TRANSACTION`. `save()` inside a callback throws. A second open handle cannot overwrite a file another session has already saved; open the file again before writing.
- A KinDB word cannot be a new table, index, column, or model field. Dropping a name that is already stored still works.
- Common mistakes name the fix: an unknown comparison, `or`, a second minus, a limit that is not a whole number, `hindura` or `siba` without `aho`, a column without a type, and a column the table does not have. An empty schemaless table says the column is not there yet.

### Fixed

- A limit of one row on a large table no longer walks every page in the range.
- A save that stopped halfway no longer left a mix of old and new pages.
- Null join keys agree with and without an index, including `imipaka`.
- Parallel saves no longer delete each other's lock or journal, and a raw missing-file error from that race is not reported to the caller.
- A planted lock whose pid still exists is not stolen. `EPERM` from `kill(pid, 0)` means that process is alive.

[Unreleased]: https://github.com/kin-lang/db/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kin-lang/db/releases/tag/v0.1.0
