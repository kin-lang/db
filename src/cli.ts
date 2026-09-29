#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Database } from './database';
import { isKinDbError, KinDbError } from './errors';
import type { ExecuteResult } from './execute';
import { formatRows } from './format/table';
import { Store } from './store';

const HELP = `kindb — Kinyarwanda SQL for a small relational database

Usage
  kindb init [file.db]              Create an empty page file (default: database.db)
  kindb run <file.kindb> [options]  Run a .kindb script
  kindb exec "<sql>" [options]      Run one SQL string
  kindb repl [options]              Run each statement when Enter completes it
  kindb help
  kindb version

Options
  --db <file.db>    Load and save this database (run/exec/repl)
  --create          Create the .db file if it is missing (default for run)
  --no-create       Refuse to create a missing .db file

A .kindb file is a list of statements: KORA ITSINDA, SHIRA, HINDURA,
SIBA, SIBA BYOSE, HITAMO, HUZA. A .db file is 512-byte pages, starting
with "KinDB page v1". An older JSON .db file, or a json-base document,
still opens. The next save rewrites it as pages.

Press Enter to run the statement you just typed. A line that is still
open, such as a '{', keeps the ...> prompt. .exit leaves the prompt.

exec and repl load the .kindb beside a .db that has no collections yet.
run does not: it executes only the script you pass.

HITAMO prints a table. A null cell is the word null.
`;

interface Flags {
  db?: string;
  create: boolean;
  positionals: string[];
}

export interface ReplStep {
  prompt: string;
  output: string;
  error: string;
  exit: boolean;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'init':
        return init(rest[0] ?? 'database.db');
      case 'run':
        return run(parseFlags(rest));
      case 'exec':
        return exec(parseFlags(rest));
      case 'repl':
        return await repl(parseFlags(rest));
      case 'version':
      case '--version':
        process.stdout.write(`${readVersion()}\n`);
        return 0;
      case 'help':
      case '--help':
      case undefined:
        process.stdout.write(HELP);
        return 0;
      default:
        process.stderr.write(`Unknown command '${command}'.\n\n${HELP}`);
        return 1;
    }
  } catch (error) {
    return fail(error);
  }
}

/**
 * One line in, one step out. A finished statement runs immediately.
 * An unfinished one keeps the buffer and switches the prompt to `...> `.
 */
export function createReplSession(database: Database): {
  push: (line: string) => ReplStep;
} {
  seedIfEmpty(database);
  const buffer: string[] = [];
  return {
    push(line: string): ReplStep {
      if (buffer.length === 0 && line.trim() === '.exit') {
        return { prompt: 'kindb> ', output: '', error: '', exit: true };
      }
      buffer.push(line);
      const source = buffer.join('\n');
      try {
        const result = database.execute(source);
        buffer.length = 0;
        return { prompt: 'kindb> ', output: formatResult(result), error: '', exit: false };
      } catch (error) {
        if (isKinDbError(error) && error.incomplete) {
          return { prompt: '...> ', output: '', error: '', exit: false };
        }
        buffer.length = 0;
        return { prompt: 'kindb> ', output: '', error: formatError(error), exit: false };
      }
    },
  };
}

function init(filePath: string): number {
  const absolute = resolve(filePath);
  if (existsSync(absolute)) {
    throw new KinDbError('E_IO', `Database file already exists: ${absolute}`);
  }
  writeFileSync(absolute, Store.empty().toBytes());
  process.stdout.write(`Created ${absolute}\n`);
  return 0;
}

function run(flags: Flags): number {
  const script = flags.positionals[0];
  if (!script) throw new KinDbError('E_MISSING_PARAM', 'kindb run needs a .kindb file');
  const database = openFromFlags(flags);
  const source = readFileSync(resolve(script), 'utf8');
  printResult(database.execute(source));
  return 0;
}

function exec(flags: Flags): number {
  const source = flags.positionals.join(' ');
  if (!source.trim()) throw new KinDbError('E_MISSING_PARAM', 'kindb exec needs a SQL string');
  const database = openFromFlags(flags);
  seedIfEmpty(database);
  printResult(database.execute(source));
  return 0;
}

function repl(flags: Flags): Promise<number> {
  const session = createReplSession(openFromFlags(flags));
  process.stdout.write('kindb. Press Enter to run a statement. Exit with .exit\n');
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'kindb> ',
  });
  return new Promise((done) => {
    reader.prompt();
    reader.on('line', (line) => {
      const step = session.push(line);
      if (step.output) process.stdout.write(step.output);
      if (step.error) process.stderr.write(step.error);
      if (step.exit) {
        reader.close();
        return;
      }
      reader.setPrompt(step.prompt);
      reader.prompt();
    });
    reader.on('close', () => done(0));
  });
}

/** Apply `name.kindb` when `name.db` exists and still has no collections. */
function seedIfEmpty(database: Database): void {
  const filePath = database.path;
  if (!filePath || !filePath.toLowerCase().endsWith('.db')) return;
  const script = `${filePath.slice(0, -3)}.kindb`;
  if (!existsSync(script) || database.collections().length > 0) return;
  database.execute(readFileSync(script, 'utf8'));
}

function openFromFlags(flags: Flags): Database {
  if (!flags.db) return Database.memory();
  return Database.open(flags.db, { create: flags.create });
}

function parseFlags(args: string[]): Flags {
  const positionals: string[] = [];
  let db: string | undefined;
  let create = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--db') {
      const value = args[i + 1];
      if (!value) throw new KinDbError('E_MISSING_PARAM', '--db needs a file path');
      db = value;
      i += 1;
      continue;
    }
    if (arg === '--create') {
      create = true;
      continue;
    }
    if (arg === '--no-create') {
      create = false;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new KinDbError('E_SYNTAX', `Unknown option '${arg}'`);
    }
    positionals.push(arg);
  }
  return { db, create, positionals };
}

function printResult(result: ExecuteResult): void {
  const text = formatResult(result);
  if (text) process.stdout.write(text);
}

function formatResult(result: ExecuteResult): string {
  return result.rows.map((rows) => formatRows(rows)).join('\n');
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = isKinDbError(error) ? error.code : 'E_IO';
  return `${code}: ${message}\n`;
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function fail(error: unknown): number {
  process.stderr.write(formatError(error));
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      process.exit(fail(error));
    });
}
