/**
 * Print why TypeScript pulled a file into this package.
 *
 * Same idea as Vitest's scripts/explain-types.ts: read the text from
 * `tsc --explainFiles` and walk "Imported via ... from file ..." edges.
 * Vitest prints `src/client`. This package prints `src/index.ts`,
 * `src/orm.ts`, and `src/cli.ts` unless you name other roots.
 *
 *   npm run explain-types
 *   node scripts/explain-types.ts /tmp/explain.txt src/store.ts
 *
 * A path inside node_modules is listed once and not expanded.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRoots = ['src/index.ts', 'src/orm.ts', 'src/cli.ts'];

export function parseExplain(content: string): Record<string, string[]> {
  const dependencies: Record<string, string[]> = {};
  const lines = content.split(/\r?\n/);
  let lastKey = lines[0] ?? '';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(' ')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('Imported via')) continue;
      const match =
        (trimmed.includes(' with ')
          ? /Imported via '(.*)' from file '(.*)' with/.exec(trimmed)
          : /Imported via '(.*)' from file '(.*)'/.exec(trimmed)) ?? [];
      const from = match[2];
      if (!from) continue;
      dependencies[from] ??= [];
      if (!dependencies[from].includes(lastKey)) dependencies[from].push(lastKey);
    } else if (line.length > 0) {
      lastKey = line;
    }
  }
  return dependencies;
}

/** Fail when a root is missing or the trace recorded no imports for it. */
export function assertExplained(text: string, roots: string[]): void {
  const blocks = new Map<string, string>();
  let current: string | null = null;
  const body: string[] = [];
  const flush = (): void => {
    if (current) blocks.set(current, body.join('\n'));
    body.length = 0;
  };
  for (const line of text.split('\n')) {
    if (line.length > 0 && !line.startsWith(' ')) {
      flush();
      current = line;
    } else if (current) {
      body.push(line);
    }
  }
  flush();
  for (const rootName of roots) {
    const recorded = blocks.get(rootName);
    if (recorded === undefined) {
      throw new Error(`explain-types did not print ${rootName}.`);
    }
    if (!recorded.trim() || recorded.includes('(no imports recorded')) {
      throw new Error(`${rootName} has no recorded imports. The type trace did not include it.`);
    }
  }
}

export function renderTrees(dependencies: Record<string, string[]>, roots: string[]): string {
  const chunks: string[] = [];
  for (const key of roots) {
    chunks.push(key);
    const direct = dependencies[key];
    if (!direct || direct.length === 0) {
      chunks.push('  (no imports recorded in the trace)');
      continue;
    }
    chunks.push(renderBranch(dependencies, direct, 1, new Set()));
  }
  return chunks.filter((chunk) => chunk.length > 0).join('\n');
}

function renderBranch(
  dependencies: Record<string, string[]>,
  deps: string[],
  depth: number,
  seen: Set<string>,
): string {
  const lines: string[] = [];
  for (const dep of deps) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    lines.push(`${'  '.repeat(depth)}${dep}`);
    const nested = dependencies[dep];
    if (nested && !dep.includes('node_modules')) {
      const child = renderBranch(dependencies, nested, depth + 1, seen);
      if (child) lines.push(child);
    }
  }
  return lines.join('\n');
}

function explainFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function explainFromCompiler(): string {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(
    process.execPath,
    [tsc, '--explainFiles', '--pretty', 'false', '--noEmit'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(detail || `tsc --explainFiles exited ${result.status}`);
  }
  return result.stdout ?? '';
}

function main(): void {
  const args = process.argv.slice(2);
  let trace: string;
  let roots: string[];
  if (args[0] && args[0] !== '--') {
    const path = resolve(args[0]);
    if (!existsSync(path)) {
      throw new Error(
        `No trace at ${path}. Run npm run explain-types, or pass a file from tsc --explainFiles.`,
      );
    }
    trace = explainFile(path);
    roots = args.slice(1);
  } else {
    trace = explainFromCompiler();
    roots = args[0] === '--' ? args.slice(1) : args;
  }
  if (roots.length === 0) roots = defaultRoots;
  const tree = `${renderTrees(parseExplain(trace), roots)}\n`;
  assertExplained(tree, roots);
  process.stdout.write(tree);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
