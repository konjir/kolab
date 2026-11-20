// The Release CLI workflow sets kolab's version with apps/cli/scripts/release-version.mjs (W2.6).
// On 2026-11-20 a patch release after kolab@0.9.0 came out as 0.8.1: nx.json's
// "conventionalCommits": false made nx release drop its "currentVersionResolver": "git-tag", so it
// bumped apps/cli/package.json's 0.8.0, which the workflow never commits, and nothing refused a
// version at or below a release already made. These run the script, with this checkout's nx.json
// and version actions, in a workspace of its own whose tags and npm versions each test chooses:
// a bump goes from the semver-highest kolab@* tag (package.json's version only before the first),
// and any version not above every kolab@* tag, konjir@* tag and npm version is refused, naming it.
import { afterAll, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'konjir-release-version-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REAL_NPM = execFileSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

let n = 0;
// A workspace with apps/cli/package.json at `manifest`, a commit per entry of `tags` carrying those
// tags (in order, so the last is the newest by date), and an npm that has `npm` (null: no package).
function workspace(manifest: string, tags: string[][], npm: string[] | null) {
  const w = join(dir, `w${++n}`);
  mkdirSync(join(w, 'apps/cli/scripts'), { recursive: true });
  mkdirSync(join(w, 'bin'));
  writeFileSync(join(w, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['apps/*'] }));
  writeFileSync(join(w, 'apps/cli/package.json'), `${JSON.stringify({ name: '@konjir/kolab', version: manifest, private: true }, null, 2)}\n`);
  copyFileSync(join(ROOT, 'nx.json'), join(w, 'nx.json'));
  for (const f of ['version-actions.cjs', 'release-version.mjs']) copyFileSync(join(ROOT, 'apps/cli/scripts', f), join(w, 'apps/cli/scripts', f));
  symlinkSync(join(ROOT, 'node_modules'), join(w, 'node_modules'), 'dir');
  writeFileSync(join(w, '.gitignore'), 'node_modules\n.nx\nbin\n');
  // npm view answers from the test; anything else is the real npm.
  const view = npm === null
    ? `echo '{"error":{"code":"E404","summary":"Not Found"}}'; echo 'npm error code E404' >&2; exit 1`
    : `echo '${JSON.stringify(npm)}'`;
  writeFileSync(join(w, 'bin/npm'), `#!/bin/sh\nif [ "$1" = view ]; then ${view}; exit 0; fi\nexec "${REAL_NPM}" "$@"\n`);
  chmodSync(join(w, 'bin/npm'), 0o755);
  git(w, 'init', '-q', '-b', 'main');
  git(w, 'add', '-A');
  git(w, 'commit', '-qm', 'start');
  tags.forEach((group, i) => {
    if (i > 0) {
      writeFileSync(join(w, `change-${i}`), `${i}\n`);
      git(w, 'add', '-A');
      git(w, 'commit', '-qm', `change ${i}`);
    }
    for (const tag of group) git(w, 'tag', tag);
  });
  return w;
}

function release(w: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['apps/cli/scripts/release-version.mjs', ...args], {
    cwd: w,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(w, 'bin')}:${process.env.PATH}`, NX_DAEMON: 'false', NX_NO_CLOUD: 'true', NX_TUI: 'false', CI: 'true', GITHUB_ACTIONS: '' },
    timeout: 120_000,
  });
  const lines = r.stdout.trim().split('\n');
  return { status: r.status, out: r.stdout, err: r.stderr, version: lines[lines.length - 1] };
}

const manifestVersion = (w: string) => JSON.parse(readFileSync(join(w, 'apps/cli/package.json'), 'utf8')).version;

// As on 2026-11-20 before the bad release: kolab@0.9.0 tags a commit whose package.json says 0.8.0.
const NPM = ['0.0.0-stage', '0.0.1', '0.9.0'];

test('patch after kolab@0.9.0, with package.json at 0.8.0, is 0.9.1; a dry run prints it and writes nothing', () => {
  const w = workspace('0.8.0', [['konjir@0.8.0', 'kolab@0.9.0']], NPM);
  const r = release(w, 'patch', '--dry-run');
  expect(r.status).toBe(0);
  expect(r.version).toBe('0.9.1');
  expect(r.out).toContain('kolab 0.9.1 (from 0.9.0), above kolab@0.9.0, konjir@0.8.0, @konjir/kolab@0.9.0; dry run, nothing written');
  expect(manifestVersion(w)).toBe('0.8.0');
}, 120_000);

test('the semver-highest kolab@* tag counts, not the newest by date: patch with kolab@0.8.1 tagged after kolab@0.9.0 is still 0.9.1, and is written', () => {
  const w = workspace('0.8.0', [['konjir@0.8.0', 'kolab@0.9.0'], ['kolab@0.8.1']], [...NPM, '0.8.1']);
  const r = release(w, 'patch');
  expect(r.status).toBe(0);
  expect(r.version).toBe('0.9.1');
  expect(manifestVersion(w)).toBe('0.9.1');
}, 120_000);

test('tags compare as semver: minor after kolab@0.10.0 and kolab@0.9.0 is 0.11.0', () => {
  const w = workspace('0.8.0', [['kolab@0.10.0'], ['kolab@0.9.0']], null);
  const r = release(w, 'minor', '--dry-run');
  expect(r.status).toBe(0);
  expect(r.version).toBe('0.11.0');
}, 120_000);

test('before the first kolab@* tag a bump goes from package.json: minor from 0.8.0 is 0.9.0, with only npm\'s placeholders', () => {
  const w = workspace('0.8.0', [['konjir@0.7.0', 'konjir@0.8.0']], ['0.0.0-stage', '0.0.1']);
  const r = release(w, 'minor', '--dry-run');
  expect(r.status).toBe(0);
  expect(r.version).toBe('0.9.0');
}, 120_000);

test.each(['0.8.1', '0.9.0'])('the exact version %s is refused when kolab@0.9.0 exists, naming the tag', (version) => {
  const w = workspace('0.8.0', [['konjir@0.8.0', 'kolab@0.9.0']], ['0.0.1']);
  const r = release(w, version);
  expect(r.status).toBe(1);
  expect(r.err).toContain(`${version} isn't above the newest kolab@* tag, kolab@0.9.0`);
  expect(r.err).not.toContain('konjir@0.8.0');
  expect(r.err).not.toContain('on npm,');
  expect(manifestVersion(w)).toBe('0.8.0');
}, 120_000);

test('a bump that lands at or below a release is refused: patch from package.json\'s 0.8.0 with konjir@0.8.1 tagged', () => {
  const w = workspace('0.8.0', [['konjir@0.8.1']], null);
  const r = release(w, 'patch');
  expect(r.status).toBe(1);
  expect(r.err).toContain("0.8.1 isn't above the newest konjir@* tag, konjir@0.8.1");
  expect(manifestVersion(w)).toBe('0.8.0');
}, 120_000);

test('a version npm has is refused though no tag has it, naming npm', () => {
  const w = workspace('0.8.0', [['kolab@0.9.0']], ['0.0.1', '0.9.0', '0.9.1']);
  const r = release(w, 'patch');
  expect(r.status).toBe(1);
  expect(r.err).toContain("0.9.1 isn't above the newest version of @konjir/kolab on npm, @konjir/kolab@0.9.1");
  expect(manifestVersion(w)).toBe('0.8.0');
}, 120_000);

test('the workflow sets the version with the script, before it builds anything', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release-cli.yml'), 'utf8');
  const set = workflow.indexOf('node apps/cli/scripts/release-version.mjs "$SPECIFIER"');
  expect(set).toBeGreaterThan(-1);
  expect(set).toBeLessThan(workflow.indexOf('npx nx run-many -t bundle compile'));
});
