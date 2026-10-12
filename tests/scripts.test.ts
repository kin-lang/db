import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { hasNotes, parseChangelog, releaseNotes } from '../scripts/changelog.ts';
import { assertExplained, parseExplain, renderTrees } from '../scripts/explain-types.ts';
import { recordLandedCommits } from '../scripts/update-changelog.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

describe('changelog', () => {
  test('the shipping notes cover the work already in this tree', () => {
    const notes = releaseNotes(changelog, '0.1.0');
    for (const phrase of [
      'transaction',
      '@kin-lang/db/orm',
      'tondeka',
      'koranya',
      'sqlLiteral',
      'checksum',
      'journal',
      'explain-types',
      'ubusa',
    ]) {
      expect(notes).toContain(phrase);
    }
    expect(notes).not.toContain('[0.1.0]:');
  });

  test('Unreleased is empty so 0.1.0 can be cut', () => {
    const unreleased = parseChangelog(changelog).find((section) => section.id === 'Unreleased');
    expect(unreleased?.body ?? '').toBe('');
    expect(hasNotes(unreleased?.body ?? '')).toBe(false);
  });

  test('notes still under Unreleased block the release', () => {
    const markdown = `# Changelog

## [Unreleased]

### Fixed

- A save stopped halfway.

## [0.2.0] - 2026-10-11

### Fixed

- Nothing else.
`;
    expect(() => releaseNotes(markdown, '0.2.0')).toThrow(/Unreleased/);
  });

  test('a version without a date or a body is refused', () => {
    expect(() => releaseNotes('## [Unreleased]\n\n## [1.0.0]\n\n### Added\n\n- x\n', '1.0.0')).toThrow(/date/);
    expect(() => releaseNotes('## [Unreleased]\n\n## [1.0.0] - 2026-10-11\n', '1.0.0')).toThrow(/no notes/);
    expect(() => releaseNotes('## [Unreleased]\n\n## [1.2.3] - 2026-10-11\n\n- ok\n', 'next')).toThrow(
      /semantic version/,
    );
  });
});

describe('explain-types', () => {
  test('walks Imported via edges and does not expand node_modules', () => {
    const trace = [
      'src/database.ts',
      "  Imported via './database' from file 'src/index.ts'",
      'src/store.ts',
      "  Imported via './store' from file 'src/database.ts'",
      "  Imported via './store' from file 'src/index.ts'",
      'node_modules/@types/node/index.d.ts',
      "  Imported via 'node:fs' from file 'src/store.ts' with packageId '@types/node/index.d.ts@1'",
      'node_modules/@types/node/fs.d.ts',
      "  Imported via './fs' from file 'node_modules/@types/node/index.d.ts'",
      '',
    ].join('\n');
    const tree = renderTrees(parseExplain(trace), ['src/index.ts']);
    expect(tree).toBe(
      [
        'src/index.ts',
        '  src/database.ts',
        '    src/store.ts',
        '      node_modules/@types/node/index.d.ts',
      ].join('\n'),
    );
    expect(tree).not.toContain('fs.d.ts');
    expect(() => assertExplained(`${tree}\n`, ['src/index.ts'])).not.toThrow();
    expect(() => assertExplained('src/index.ts\n  (no imports recorded in the trace)\n', ['src/index.ts'])).toThrow(
      /no recorded imports/,
    );
  });
});

describe('changelog on main', () => {
  const sample = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-10-11

### Added

- The engine.

[0.1.0]: https://github.com/kin-lang/db/releases/tag/v0.1.0
`;

  test('a push to main records the commit under Unreleased', () => {
    const next = recordLandedCommits(sample, [
      { hash: 'abc1234', subject: 'Journal saves and stop limit-1 reads early' },
      { hash: 'def5678', subject: 'Update changelog' },
      { hash: 'abc1234', subject: 'Journal saves and stop limit-1 reads early' },
    ]);
    expect(next.added).toEqual(['abc1234']);
    expect(next.markdown).toContain('## [Unreleased]\n\n- `abc1234` Journal saves and stop limit-1 reads early\n\n## [0.1.0]');
    expect(next.markdown).toContain('The engine.');
    expect(next.markdown).not.toContain('Update changelog');
    const again = recordLandedCommits(next.markdown, [
      { hash: 'abc1234', subject: 'Journal saves and stop limit-1 reads early' },
    ]);
    expect(again.added).toEqual([]);
    expect(again.markdown).toBe(next.markdown);
  });

  test('hand-written Unreleased notes stay above the landed commits', () => {
    const noted = sample.replace('## [Unreleased]\n\n', '## [Unreleased]\n\n### Fixed\n\n- A save stopped halfway.\n\n');
    const next = recordLandedCommits(noted, [{ hash: 'aaa1111', subject: 'Explain the type graph in CI' }]);
    expect(next.markdown.indexOf('A save stopped halfway.')).toBeLessThan(next.markdown.indexOf('aaa1111'));
    expect(next.markdown).toContain('## [0.1.0] - 2026-10-11');
  });
});
