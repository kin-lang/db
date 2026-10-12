/**
 * Append commit subjects that just landed on main to ## [Unreleased].
 *
 * GitHub Actions runs this on every push to main. The follow-up commit
 * is titled "Update changelog" and is ignored, so the next push stops.
 *
 *   node scripts/update-changelog.ts <previous-sha> <new-sha>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = join(root, 'CHANGELOG.md');
const skipSubject = /^(update changelog|merge pull request|merge branch|merge remote-tracking branch)\b/i;

export interface LandedCommit {
  hash: string;
  subject: string;
}

export function recordLandedCommits(
  markdown: string,
  commits: LandedCommit[],
): { markdown: string; added: string[] } {
  const heading = markdown.split(/\r?\n/).findIndex((line) => line === '## [Unreleased]');
  if (heading < 0) {
    throw new Error('CHANGELOG.md has no ## [Unreleased] section.');
  }
  const added: string[] = [];
  const bullets: string[] = [];
  for (const commit of commits) {
    const subject = commit.subject.trim().replace(/\s+/g, ' ');
    const hash = commit.hash.trim();
    if (!/^[0-9a-f]{7,}$/i.test(hash) || !subject || skipSubject.test(subject)) continue;
    if (added.includes(hash) || new RegExp(`\\b${hash}\\b`).test(markdown)) continue;
    bullets.push(`- \`${hash}\` ${subject}`);
    added.push(hash);
  }
  if (bullets.length === 0) return { markdown, added };

  const lines = markdown.split(/\r?\n/);
  const next = lines.findIndex((line, index) => index > heading && line.startsWith('## '));
  const end = next === -1 ? lines.length : next;
  const existing = lines.slice(heading + 1, end).join('\n').trim();
  const body = existing ? `${existing}\n\n${bullets.join('\n')}` : bullets.join('\n');
  const suffix = lines.slice(end).join('\n');
  const trailing = markdown.endsWith('\n') ? '\n' : '';
  const merged = `${lines.slice(0, heading + 1).join('\n')}\n\n${body}\n\n${suffix.replace(/^\n/, '')}`;
  return { markdown: merged.endsWith('\n') ? merged : merged + trailing, added };
}

function landedCommits(from: string, to: string): LandedCommit[] {
  const range = /^0+$/.test(from) ? [to] : [`${from}..${to}`];
  const result = spawnSync('git', ['log', '--no-merges', '--reverse', '--format=%h%x09%s', ...range], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || `git log ${range.join(' ')} failed`).trim());
  }
  const commits: LandedCommit[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    commits.push({ hash: line.slice(0, tab), subject: line.slice(tab + 1) });
  }
  return commits;
}

function main(): void {
  const from = process.argv[2] || process.env.CHANGELOG_FROM;
  const to = process.argv[3] || process.env.CHANGELOG_TO || 'HEAD';
  if (!from) {
    throw new Error('Pass the previous commit and the new one: update-changelog.ts <from> <to>');
  }
  const current = readFileSync(changelogPath, 'utf8');
  const next = recordLandedCommits(current, landedCommits(from, to));
  if (next.added.length === 0) {
    process.stdout.write('Changelog already covers these commits.\n');
    return;
  }
  writeFileSync(changelogPath, next.markdown);
  process.stdout.write(`Recorded ${next.added.join(', ')} under Unreleased.\n`);
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
