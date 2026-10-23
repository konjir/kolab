// deploy/site/build.mjs builds konjir.com's site/ from its source in site/src/ (D92). These run it
// on a copy of the repository's site in a scratch git repository: a rebuild never prunes the assets
// main's pages use (what production serves), a rebuild of a committed build changes nothing, and
// the build never writes outside its own files in site/.
import { afterAll, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'konjir-site-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const build = (r: string) => spawnSync(process.execPath, [join(r, 'deploy/site/build.mjs')], { cwd: r, encoding: 'utf8' });
const assetsOf = (r: string) => [...readFileSync(join(r, 'site/index.html'), 'utf8').matchAll(/\/assets\/(site\.[0-9a-f]{10}\.(?:css|js))/g)].map((m) => m[1]).sort();
const artboard = (r: string) => join(r, 'site/src/project/Main.dc.html');

function copy(name: string) {
  const r = join(dir, name);
  for (const p of ['deploy/site', 'site/src', 'brand/konjir-mark-tile.svg']) cpSync(join(ROOT, p), join(r, p), { recursive: true });
  git(r, 'init', '-q', '-b', 'main');
  return r;
}

function commitBuild(r: string, message: string) {
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', message);
}

// A change to the artboard that changes the stylesheet, so the CSS gets a new hash.
const restyle = (r: string, from: string, to: string) => {
  const text = readFileSync(artboard(r), 'utf8');
  expect(text).toContain(from);
  writeFileSync(artboard(r), text.replace(from, to));
};

test("a rebuild on a branch keeps main's assets, even after the branch's first build is committed, and changes nothing twice", () => {
  const r = copy('branch');
  commitBuild(r, 'main');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const main = assetsOf(r);

  git(r, 'checkout', '-qb', 'change');
  restyle(r, 'padding: 0 22px; color: var(--on-accent); font-weight: 600; font-size: 15px;', 'padding: 0 20px; color: var(--on-accent); font-weight: 600; font-size: 15px;');
  commitBuild(r, 'first build');
  const first = assetsOf(r);
  expect(first).not.toStrictEqual(main);

  // A fix-up: HEAD is now the branch's first build, but main's assets stay.
  restyle(r, 'padding: 0 20px;', 'padding: 0 18px;');
  commitBuild(r, 'fix-up');
  for (const a of [...main, ...first, ...assetsOf(r)]) expect(existsSync(join(r, 'site/assets', a))).toBe(true);

  // Building a committed build again changes nothing.
  for (let i = 0; i < 2; i++) {
    expect(build(r).status).toBe(0);
    expect(git(r, 'status', '--porcelain')).toBe('');
  }

  // Without an origin/main, HEAD alone: main's CSS, which only main's pages used, goes.
  git(r, 'update-ref', '-d', 'refs/remotes/origin/main');
  expect(build(r).status).toBe(0);
  const mainCss = main.find((a) => a.endsWith('.css'))!;
  expect(existsSync(join(r, 'site/assets', mainCss))).toBe(false);
});

test('the build refuses to write outside its own files: a path with .. is refused, and site/src/ is untouched', () => {
  const r = copy('escape');
  const name = '../../src/evil-OFL.txt';
  mkdirSync(join(r, 'deploy/src'), { recursive: true });
  writeFileSync(join(r, 'deploy/src/evil-OFL.txt'), 'x');
  const manifestPath = join(r, 'deploy/site/fonts/source.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> };
  manifest.files[name] = createHash('sha256').update('x').digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const b = build(r);
  expect(b.status).toBe(1);
  expect(b.stderr).toContain(`refusing to write site/assets/fonts/${name}`);
  expect(existsSync(join(r, 'site/src/evil-OFL.txt'))).toBe(false);
});
