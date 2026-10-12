/**
 * Read Keep a Changelog sections. The release script publishes the version
 * in package.json and uses the matching section as the GitHub release notes.
 */

export interface ChangelogSection {
  id: string;
  date: string | null;
  body: string;
}

const HEADING = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  const lines: string[] = [];

  function flush(): void {
    if (!current) return;
    current.body = clean(lines.join('\n'));
    sections.push(current);
    lines.length = 0;
  }

  for (const line of markdown.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      current = { id: match[1], date: match[2] ?? null, body: '' };
      continue;
    }
    if (current) lines.push(line);
  }
  flush();
  return sections;
}

function clean(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^\[[^\]]+\]: /.test(line))
    .join('\n')
    .trim();
}

export function hasNotes(body: string): boolean {
  return body.trim().length > 0;
}

/**
 * Notes for one published version. Refuses while Unreleased still has text,
 * so a release cannot ship changes that were never moved into a version.
 */
export function releaseNotes(markdown: string, version: string): string {
  if (!VERSION.test(version)) {
    throw new Error(`Version '${version}' is not a semantic version. Example: 0.2.0`);
  }
  const sections = parseChangelog(markdown);
  const unreleased = sections.find((section) => section.id.toLowerCase() === 'unreleased');
  if (unreleased && hasNotes(unreleased.body)) {
    throw new Error(
      `CHANGELOG.md still has notes under Unreleased. Move them into ## [${version}] - YYYY-MM-DD, then run the release again.`,
    );
  }
  const section = sections.find((item) => item.id === version);
  if (!section || !hasNotes(section.body)) {
    throw new Error(
      `CHANGELOG.md has no notes for ${version}. Add ## [${version}] - YYYY-MM-DD with what changed.`,
    );
  }
  if (!section.date) {
    throw new Error(`The ${version} section needs a date. Example: ## [${version}] - 2026-10-11`);
  }
  return section.body;
}
