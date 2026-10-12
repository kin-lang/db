/**
 * Publish this package to npm and open a GitHub release.
 *
 *   npm run release
 *
 * The version is package.json's version. The release notes are the matching
 * section of CHANGELOG.md. Move Unreleased notes into that section, commit,
 * and push before running this. The script asks for a GitHub personal access
 * token and an npm token, and does not write them into the repository.
 * A non-interactive shell can set GITHUB_TOKEN and NPM_TOKEN instead.
 *
 * GitHub token: classic `repo`, or a fine-grained token with Contents
 * read and write on kin-lang/db (creating the release also creates the tag).
 * npm token: permission to publish @kin-lang/db. An automation token does
 * not need a one-time code. A token that still uses 2FA will be asked for one.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseNotes } from './changelog.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const githubApi = 'https://api.github.com';

interface PackageJson {
  name: string;
  version: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function readPackage(): PackageJson {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  if (!pkg.name || !pkg.version) fail('package.json needs a name and a version.');
  return pkg;
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
  return (result.stdout ?? '').trim();
}

function assertCleanAndPushed(): string {
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    fail(
      'The working tree has uncommitted changes. Commit them, push this branch, then run the release again.',
    );
  }
  let upstream = '';
  const probe = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    fail('This branch does not track a remote. Push it with -u, then run the release again.');
  }
  upstream = probe.stdout.trim();
  const head = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', '@{u}']);
  if (head !== remote) {
    fail(`HEAD is not the same commit as ${upstream}. Push or pull, then run the release again.`);
  }
  return head;
}

function repoFromOrigin(): { owner: string; repo: string } {
  const url = git(['remote', 'get-url', 'origin']);
  const match = url.replace(/\.git$/, '').match(/github\.com[:/]([^/]+)\/([^/]+)$/);
  if (!match) fail(`origin is not a GitHub repository: ${url}`);
  return { owner: match[1], repo: match[2] };
}

function npmView(name: string, version: string): void {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    fail(`${name}@${version} is already on npm. Bump the version before releasing again.`);
  }
  if (!output.includes('E404')) {
    fail(`Could not check npm for ${name}@${version}.\n${output.trim()}`);
  }
}

async function githubReleaseExists(
  owner: string,
  repo: string,
  version: string,
  token?: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kin-lang-db-release',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${githubApi}/repos/${owner}/${repo}/releases/tags/v${version}`, { headers });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  const detail = await response.text();
  fail(`Could not check GitHub releases (${response.status}). ${redact(detail, token ? [token] : [])}`);
}

function runChecked(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed.`);
}

function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolvePromise) => {
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(answer.trim());
    });
  });
}

function askSecret(label: string, envName: string): Promise<string> {
  if (!stdin.isTTY) {
    const fromEnv = process.env[envName]?.trim();
    if (!fromEnv) fail(`Set ${envName} when stdin is not a terminal.`);
    return Promise.resolve(fromEnv);
  }
  return readHidden(`${label}: `).then((value) => {
    if (!value) fail(`${label} was empty.`);
    return value;
  });
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    stdout.write(prompt);
    if (typeof stdin.setRawMode !== 'function') {
      void askLine('').then(resolvePromise, reject);
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    let skipping = false;
    let settled = false;
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      if (settled) return;
      for (const char of chunk) {
        if (skipping) {
          if ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '~') skipping = false;
          continue;
        }
        if (char === '\u0003') {
          settled = true;
          cleanup();
          stdout.write('\n');
          reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' }));
          return;
        }
        if (char === '\u001b') {
          skipping = true;
          continue;
        }
        if (char === '\r') continue;
        if (char === '\n') {
          settled = true;
          cleanup();
          stdout.write('\n');
          resolvePromise(value.trim());
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char < ' ') continue;
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

function writeNpmrc(token: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kindb-release-'));
  const path = join(dir, 'npmrc');
  writeFileSync(path, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  return { dir, path };
}

function npmCaptured(
  args: string[],
  configPath: string,
  secrets: string[],
): { status: number; stdout: string; output: string } {
  const result = spawnSync('npm', [...args, '--userconfig', configPath], {
    cwd: root,
    encoding: 'utf8',
  });
  const stdoutText = redact(result.stdout ?? '', secrets).trim();
  const output = redact(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, secrets).trim();
  return { status: result.status ?? 1, stdout: stdoutText, output };
}

async function publish(pkg: PackageJson, notes: string, sha: string, owner: string, repo: string): Promise<void> {
  const githubToken = await askSecret('GitHub personal access token', 'GITHUB_TOKEN');
  const npmToken = await askSecret('npm token', 'NPM_TOKEN');
  let otp = '';
  if (stdin.isTTY) {
    otp = await readHidden('npm one-time code (Enter if your token does not use one): ');
  }

  const secrets = [githubToken, npmToken, otp].filter((value) => value.length > 0);
  const npmrc = writeNpmrc(npmToken);
  try {
    const who = npmCaptured(['whoami'], npmrc.path, secrets);
    if (who.status !== 0) fail(`npm rejected that token.\n${who.output}`);
    const user = who.stdout.split('\n').pop() || who.stdout;
    if (await githubReleaseExists(owner, repo, pkg.version, githubToken)) {
      fail(`GitHub already has a release named v${pkg.version}.`);
    }
    const repoCheck = await fetch(`${githubApi}/repos/${owner}/${repo}`, {
      headers: githubHeaders(githubToken),
    });
    if (!repoCheck.ok) {
      const detail = redact(await repoCheck.text(), secrets);
      fail(`GitHub rejected that token (${repoCheck.status}). ${detail}`);
    }

    if (stdin.isTTY) {
      const answer = await askLine(
        `Publish ${pkg.name}@${pkg.version} to npm as ${user}, and create https://github.com/${owner}/${repo}/releases/tag/v${pkg.version}? [y/N] `,
      );
      if (answer.toLowerCase() !== 'y') {
        stdout.write('Release cancelled. Nothing was published.\n');
        return;
      }
    } else if (process.env.RELEASE_CONFIRM !== 'yes') {
      fail('Set RELEASE_CONFIRM=yes to publish when stdin is not a terminal.');
    }

    const publishArgs = ['publish', '--access', 'public', '--userconfig', npmrc.path];
    const env = { ...process.env };
    if (otp) env.npm_config_otp = otp;
    const published = spawnSync('npm', publishArgs, { cwd: root, stdio: 'inherit', env });
    if ((published.status ?? 1) !== 0) {
      fail('npm publish failed. No GitHub release was created.');
    }
    stdout.write(`Published ${pkg.name}@${pkg.version} to npm.\n`);

    const release = await fetch(`${githubApi}/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { ...githubHeaders(githubToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: `v${pkg.version}`,
        target_commitish: sha,
        name: `v${pkg.version}`,
        body: notes,
        draft: false,
        prerelease: pkg.version.includes('-'),
      }),
    });
    if (!release.ok) {
      const detail = redact(await release.text(), secrets);
      fail(
        `npm publish succeeded, and the GitHub release did not.\nCreate https://github.com/${owner}/${repo}/releases/new?tag=v${pkg.version} with the ${pkg.version} notes from CHANGELOG.md.\n${detail}`,
      );
    }
    const created = (await release.json()) as { html_url?: string };
    stdout.write(`GitHub release: ${created.html_url ?? `v${pkg.version}`}\n`);
  } finally {
    rmSync(npmrc.dir, { recursive: true, force: true });
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'kin-lang-db-release',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function main(): Promise<void> {
  const pkg = readPackage();
  const notes = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), pkg.version);
  const sha = assertCleanAndPushed();
  const remote = repoFromOrigin();
  npmView(pkg.name, pkg.version);
  if (await githubReleaseExists(remote.owner, remote.repo, pkg.version)) {
    fail(`GitHub already has a release named v${pkg.version}.`);
  }
  stdout.write(`Checking ${pkg.name}@${pkg.version} before asking for tokens.\n`);
  runChecked('npm', ['test']);
  runChecked('npm', ['run', 'build']);
  await publish(pkg, notes, sha, remote.owner, remote.repo);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'CANCELLED') {
      process.exit(130);
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
