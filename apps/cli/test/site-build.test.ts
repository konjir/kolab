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

test("the hands-on tutorial is built into hands-on/index.html, inside the home page's header and footer, with its stylesheet and script and nothing the CSP would block", () => {
  const r = copy('hands-on');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const home = readFileSync(join(r, 'site/index.html'), 'utf8');
  const page = readFileSync(join(r, 'site/hands-on/index.html'), 'utf8');
  expect(page).toContain('<article class="ho" aria-labelledby="ho-title">');
  expect(page).toMatch(/<h1 id="ho-title">Write a spec, then build it with a team of agents<\/h1>/);
  expect(page).toMatch(/<title>Hands-on: [^<]+: Konjir<\/title>/);
  // The same stylesheet and script as the home page, and no other script, style or inline style.
  expect(assetsOf(r)).toStrictEqual([...page.matchAll(/\/assets\/(site\.[0-9a-f]{10}\.(?:css|js))/g)].map((m) => m[1]).sort());
  expect([...page.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toStrictEqual([...home.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]));
  expect(page).not.toMatch(/\sstyle\s*=|<style\b/i);
  // The header's in-page links go home; the article's own contents stay on the page.
  expect(page).toContain('href="/#how"');
  expect(page).not.toMatch(/href="#(how|circle|agents|kolabs|signup|top)"/);
  expect(page).toMatch(/<nav class="toc" aria-label="Steps">[\s\S]*href="#before-you-start"/);
  // Code is escaped and kept as written, `$` and all, in a labelled box.
  expect(page).toContain('<figure class="code text"><figcaption>Prompt</figcaption>');
  expect(page).toContain('--kolab $KOLAB');
  expect(page).toContain('&lt;you&gt;-spec-writer');
  // The home page links to it.
  expect(home).toContain('href="https://konjir.com/hands-on/"');
});

test("the build refuses a tutorial with Markdown it doesn't render, rather than guess, and escapes any HTML in its text", () => {
  const r = copy('hands-on-refusals');
  const md = join(r, 'site/src/hands-on.md');
  const original = readFileSync(md, 'utf8');
  for (const [add, why] of [
    ['<script src="/x.js"></script>', "a line this renderer doesn't handle"],
    ['See [this](javascript:alert(1)).', 'only https://, /path and #anchor links'],
    ['```js\nalert(1)\n```', 'a code block of kind "js"'],
    ['```sh\nnever closed', 'an unclosed code block'],
    ['#### Too deep', 'a level-4 heading'],
    ['Some *emphasis* here.', "Markdown this renderer doesn't handle"],
    ['See [this](/\\evil.example).', 'only https://, /path and #anchor links'],
    ['See [this](https://x.example/a\\b).', 'no "\\", "(" or ")" in a link'],
    ['See [this](https://x.example/(y)).', 'no "\\", "(" or ")" in a link'],
  ]) {
    writeFileSync(md, `${original}\n${add}\n`);
    const b = build(r);
    expect([b.status, add]).toStrictEqual([1, add]);
    expect(b.stderr).toContain('site/src/hands-on.md');
    expect(b.stderr).toContain(why);
  }
  writeFileSync(md, `${original}\nA paragraph with <img src=x onerror=alert(1)> in it.\n`);
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const page = readFileSync(join(r, 'site/hands-on/index.html'), 'utf8');
  expect(page).toContain('A paragraph with &lt;img src=x onerror=alert(1)&gt; in it.');
  expect(page).not.toContain('<img src=x');
});

test("a tutorial title holding markup is escaped wherever it goes, <title> included, and the finished page holds no tag the build didn't write", () => {
  const r = copy('hands-on-title');
  const md = join(r, 'site/src/hands-on.md');
  const original = readFileSync(md, 'utf8');
  for (const title of [
    'Tutorial </title><script src="https://evil.example/x.js"></script><title>',
    'Tutorial </title><meta http-equiv="refresh" content="0;url=https://evil.example/"><title>',
  ]) {
    writeFileSync(md, original.replace(/^# .*$/m, `# ${title}`));
    const b = build(r);
    expect([b.status, b.stderr]).toStrictEqual([0, '']);
    const page = readFileSync(join(r, 'site/hands-on/index.html'), 'utf8');
    expect(page).not.toContain('evil.example/x.js"></script>');
    expect(page).not.toMatch(/<meta http-equiv/i);
    expect([...page.matchAll(/<title>/g)]).toHaveLength(1);
    expect(page).toMatch(/<title>Hands-on: Tutorial &lt;\/title&gt;&lt;(script|meta) [^<]*: Konjir<\/title>/);
    expect(page).toContain('<h1 id="ho-title">Tutorial &lt;/title&gt;&lt;');
  }
});

test('the build checks each finished page whole: a description holding markup is refused, not written', () => {
  const r = copy('page-check');
  const md = join(r, 'site/src/hands-on.md');
  const original = readFileSync(md, 'utf8');
  // A lead paragraph can't hold markup (it is escaped), so make page() itself write some: a stand-in
  // for a future source of text the renderer doesn't escape.
  const buildPath = join(r, 'deploy/site/build.mjs');
  const script = readFileSync(buildPath, 'utf8');
  writeFileSync(buildPath, script.replace("handsOn, tutorial.lead)", "handsOn, tutorial.lead + '\"><meta http-equiv=\"refresh\" content=\"0\">')"));
  writeFileSync(md, original);
  const b = build(r);
  expect(b.status).toBe(1);
  expect(b.stderr).toContain("site/hands-on/index.html would have a <head> other than the one the build writes");
  expect(existsSync(join(r, 'site/hands-on/index.html'))).toBe(false);
});
