// The release Terraform ships is packed by deploy/release/pack.sh from the tracked files of one
// commit (the D55 review): nothing untracked or ignored, such as .env, a .claude/ worktree, a
// nested .konjir or a *.tfvars file, can be in it; uncommitted tracked changes are refused; and
// the release id is the commit's tree, so it changes only when tracked content does. site/,
// konjir.com's files (D81), is left out of both the zip and the id.
import { afterAll, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACK = resolve(import.meta.dirname, '../../../deploy/release/pack.sh');
const dir = mkdtempSync(join(tmpdir(), 'konjir-pack-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const pack = (src: string, out: string) => spawnSync('bash', [PACK, src, out], { input: '{}', encoding: 'utf8' });
const names = (zip: string) => execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();

function repo(name: string, files: Record<string, string>) {
  const r = join(dir, name);
  mkdirSync(r, { recursive: true });
  git(r, 'init', '-q');
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(r, f, '..'), { recursive: true }); writeFileSync(join(r, f), text); }
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'one');
  return r;
}

test('only tracked files ship: untracked and ignored .env, .claude, .konjir and *.tfvars never do', () => {
  const r = repo('clean', { 'package.json': '{}', 'apps/a.ts': 'x', '.gitignore': '.konjir\n*.tfvars\n' });
  for (const [f, text] of Object.entries({ '.env': 'SECRET=1', '.claude/worktrees/w/x.ts': 'x', '.konjir/data': 'db', 'deploy/terraform/secret.tfvars': 'a = 1', 'apps/.env.local': 'x', 'apps/new.ts': 'untracked' })) {
    mkdirSync(join(r, f, '..'), { recursive: true });
    writeFileSync(join(r, f), text);
  }
  const out = join(dir, 'out', 'clean.zip');
  const p = pack(r, out);
  expect([p.status, p.stderr]).toStrictEqual([0, '']);
  const result = JSON.parse(p.stdout) as { path: string; release: string };
  expect(result).toStrictEqual({ path: out, release: git(r, 'rev-parse', 'HEAD^{tree}') });
  expect(names(out)).toStrictEqual(['.gitignore', 'apps/', 'apps/a.ts', 'package.json']);

  // The release id follows the tree, not the commit: an empty commit is the same release.
  git(r, 'commit', '-q', '--allow-empty', '-m', 'two');
  expect(JSON.parse(pack(r, out).stdout).release).toBe(result.release);
  writeFileSync(join(r, 'apps/a.ts'), 'y');
  git(r, 'commit', '-qam', 'three');
  expect(JSON.parse(pack(r, out).stdout).release).not.toBe(result.release);
});

test('site/ (konjir.com, D81) is no part of a release: not in the zip, and a site-only change is the same release', () => {
  const r = repo('site', { '.gitattributes': '/site export-ignore\n', 'apps/a.ts': 'x', 'site/index.html': '<p>one</p>', 'site/assets/site.0123456789.css': 'p{}', 'site/src/project/Main.dc.html': '<x-dc></x-dc>', 'site/src/images/0123.jpg': 'jpg', 'deploy/site/site.js': '1' });
  const out = join(dir, 'site.zip');
  const p = pack(r, out);
  expect([p.status, p.stderr]).toStrictEqual([0, '']);
  const release = (JSON.parse(p.stdout) as { release: string }).release;
  expect(names(out)).toStrictEqual(['.gitattributes', 'apps/', 'apps/a.ts', 'deploy/', 'deploy/site/', 'deploy/site/site.js']);

  // The id is the tree without site/: the tree the same commit would have had with no site/ at all.
  const bare = repo('site-bare', { '.gitattributes': '/site export-ignore\n', 'apps/a.ts': 'x', 'deploy/site/site.js': '1' });
  expect(release).toBe(git(bare, 'rev-parse', 'HEAD^{tree}'));
  expect(release).not.toBe(git(r, 'rev-parse', 'HEAD^{tree}'));

  // Editing, adding or removing site files alone: the same release, so Terraform's release
  // object and install association don't change and Kolab isn't reinstalled.
  writeFileSync(join(r, 'site/index.html'), '<p>two</p>');
  writeFileSync(join(r, 'site/new.txt'), 'x');
  writeFileSync(join(r, 'site/src/project/Main.dc.html'), '<x-dc><p>two</p></x-dc>'); // the page's source (D92)
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'site only');
  expect(JSON.parse(pack(r, out).stdout).release).toBe(release);
  git(r, 'rm', '-rq', 'site');
  git(r, 'commit', '-qm', 'no site');
  expect(JSON.parse(pack(r, out).stdout).release).toBe(release);

  // Anything else is a new release, deploy/site/ included (it is tracked deploy code, not site/).
  writeFileSync(join(r, 'deploy/site/site.js'), '2');
  git(r, 'commit', '-qam', 'deploy code');
  expect(JSON.parse(pack(r, out).stdout).release).not.toBe(release);
});

test('an uncommitted tracked change is refused, so a deploy is exactly a commit', () => {
  const r = repo('dirty', { 'a.ts': 'x' });
  writeFileSync(join(r, 'a.ts'), 'changed');
  const p = pack(r, join(dir, 'dirty.zip'));
  expect(p.status).not.toBe(0);
  expect(p.stderr).toMatch(/tracked changes aren't committed/);
});

test('a tracked file that must never ship is refused: .env, .claude, .playwright-mcp, .konjir, *.tfvars, Terraform state', () => {
  for (const f of ['.env', 'apps/.env.production', '.claude/settings.json', 'x/.playwright-mcp/a.png', 'apps/web/.konjir-demo/tokens.json', '.konjir/x',
    'deploy/terraform/prod.tfvars', 'deploy/terraform/x.tfvars.json', 'deploy/terraform/terraform.tfstate']) {
    const r = repo(`forbidden-${f.replace(/[^a-z]/gi, '')}`, { 'a.ts': 'x', [f]: 'secret' });
    const p = pack(r, join(dir, 'f.zip'));
    expect([f, p.status !== 0, /must never ship/.test(p.stderr)]).toStrictEqual([f, true, true]);
  }
  // Not a checkout at all: refused.
  mkdirSync(join(dir, 'plain'));
  expect(pack(join(dir, 'plain'), join(dir, 'p.zip')).stderr).toMatch(/not a git checkout/);
});

test('terraform init rewriting the provider lock is not a dirty checkout: the zip still holds the committed lock', () => {
  const r = repo('lock', { 'a.ts': 'x', 'deploy/terraform/.terraform.lock.hcl': 'provider "registry.terraform.io/hashicorp/external" {}\n' });
  writeFileSync(join(r, 'deploy/terraform/.terraform.lock.hcl'), 'provider "registry.terraform.io/hashicorp/archive" {}\nprovider "registry.terraform.io/hashicorp/external" {}\n');
  const out = join(dir, 'lock.zip');
  const p = pack(r, out);
  expect([p.status, p.stderr]).toStrictEqual([0, '']);
  expect(execFileSync('unzip', ['-p', out, 'deploy/terraform/.terraform.lock.hcl'], { encoding: 'utf8' })).not.toContain('hashicorp/archive');
  // Any other tracked change is still refused.
  writeFileSync(join(r, 'a.ts'), 'changed');
  expect(pack(r, out).stderr).toMatch(/tracked changes aren't committed/);
});
