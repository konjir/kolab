// deploy/site/build.mjs builds www.konjir.com's site/ from its source in site/src/ (D92), one section
// per product. These run it on a copy of the repository's site in a scratch git repository: a
// rebuild never prunes the assets main's pages use (what production serves), a rebuild of a
// committed build changes nothing, the build never writes outside its own files in site/, and every
// page shares one header and carries its canonical URL and Open Graph tags.
import { afterAll, expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'konjir-site-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const build = (r: string) => spawnSync(process.execPath, [join(r, 'deploy/site/build.mjs')], { cwd: r, encoding: 'utf8' });
const assetsOf = (r: string) => [...readFileSync(join(r, 'site/index.html'), 'utf8').matchAll(/\/assets\/(site\.[0-9a-f]{10}\.(?:css|js))/g)].map((m) => m[1]).sort();
const kolabPage = (r: string) => join(r, 'site/src/kolab/main.html');
const read = (r: string, page: string) => readFileSync(join(r, 'site', page), 'utf8');
// Every page the build writes, by its file in site/ and its URL.
const PAGES: [string, string][] = [
  ['index.html', 'https://www.konjir.com/'],
  ['kolab/index.html', 'https://www.konjir.com/kolab/'],
  ['kolab/how-it-works/index.html', 'https://www.konjir.com/kolab/how-it-works/'],
  ['kolab/hands-on/index.html', 'https://www.konjir.com/kolab/hands-on/'],
  ['konnect/index.html', 'https://www.konjir.com/konnect/'],
  ['konnect/guide/index.html', 'https://www.konjir.com/konnect/guide/'],
  ['privacy/index.html', 'https://www.konjir.com/privacy/'],
];
const headerOf = (html: string) => /<header\b[^>]*>[\s\S]*?<\/header>/.exec(html)![0];
// Every file under a folder, by its path from that folder.
const filesIn = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(d, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));

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

// A change to Kolab's page that changes the stylesheet, so the CSS gets a new hash.
const restyle = (r: string, from: string, to: string) => {
  const text = readFileSync(kolabPage(r), 'utf8');
  expect(text).toContain(from);
  writeFileSync(kolabPage(r), text.replace(from, to));
};

test("a rebuild on a branch keeps main's assets, even after the branch's first build is committed, and changes nothing twice", () => {
  const r = copy('branch');
  commitBuild(r, 'main');
  git(r, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const main = assetsOf(r);

  git(r, 'checkout', '-qb', 'change');
  restyle(r, 'padding: 0 26px; color: var(--on-accent); font-weight: 600;', 'padding: 0 25px; color: var(--on-accent); font-weight: 600;');
  commitBuild(r, 'first build');
  const first = assetsOf(r);
  expect(first).not.toStrictEqual(main);

  // A fix-up: HEAD is now the branch's first build, but main's assets stay.
  restyle(r, 'padding: 0 25px;', 'padding: 0 24px;');
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

test("the messages guide is built into konnect/guide/index.html as the tutorial is, under its own kicker, and the Kolab page's footer links to it", () => {
  const r = copy('messages');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  expect(b.stdout).toContain('site/: index.html, kolab/index.html, kolab/how-it-works/index.html, kolab/hands-on/index.html, konnect/index.html, konnect/guide/index.html, privacy/index.html, konnect/app/oauth/index.html, konnect/app/preview/oauth/index.html, 404.html');
  const home = read(r, 'kolab/index.html');
  const page = read(r, 'konnect/guide/index.html');
  expect(page).toContain('<header><p class="kicker">Guide</p><h1 id="ho-title">Chat for your team\'s people and their AI agents</h1></header>');
  expect(page).toMatch(/<title>Guide: Chat for your team's people and their AI agents: Konjir<\/title>/);
  expect(page).toMatch(/<nav class="toc" aria-label="Sections">[\s\S]*href="#common-uses"/);
  // The same stylesheet and script as the home page, and nothing the CSP would block.
  expect(assetsOf(r)).toStrictEqual([...page.matchAll(/\/assets\/(site\.[0-9a-f]{10}\.(?:css|js))/g)].map((m) => m[1]).sort());
  expect(page).not.toMatch(/\sstyle\s*=|<style\b/i);
  // It teaches konnect: the tools an agent gets are konnect mcp's own, and the top of man konnect is shown as it renders.
  for (const tool of ['konnect_send', 'konnect_receive', 'konnect_history', 'konnect_channel_list', 'konnect_team_list', 'konnect_lease_list', 'konnect_lease_claim', 'konnect_lease_release']) expect(page).toContain(`<code>${tool}</code>`);
  expect(page).toContain('KONNECT(1)');
  expect(page).toContain('konnect agent run laptop claude');
  expect(home).toContain('<a href="/konnect/guide/">Messaging with konnect</a>');
  expect(read(r, 'kolab/hands-on/index.html')).toContain('<p class="kicker">Hands-on</p>');
  // The pages that moved aren't written where they were: CloudFront redirects from there.
  expect(existsSync(join(r, 'site/hands-on'))).toBe(false);
  expect(existsSync(join(r, 'site/messages'))).toBe(false);
});

test("the hands-on tutorial is built into kolab/hands-on/index.html, inside the shared header and the Kolab page's footer, with its stylesheet and script and nothing the CSP would block", () => {
  const r = copy('hands-on');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const home = read(r, 'kolab/index.html');
  const page = read(r, 'kolab/hands-on/index.html');
  expect(page).toContain('<article class="ho" aria-labelledby="ho-title">');
  expect(page).toMatch(/<h1 id="ho-title">Write a spec, then build it with a team of agents<\/h1>/);
  expect(page).toMatch(/<title>Hands-on: [^<]+: Konjir<\/title>/);
  // The same stylesheet and script as the home page, and no other script, style or inline style.
  expect(assetsOf(r)).toStrictEqual([...page.matchAll(/\/assets\/(site\.[0-9a-f]{10}\.(?:css|js))/g)].map((m) => m[1]).sort());
  expect([...page.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toStrictEqual([...home.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]));
  expect(page).not.toMatch(/\sstyle\s*=|<style\b/i);
  // The header's links stay within Kolab's section; the footer's in-page links go to the Kolab
  // page; the article's own contents stay on the page.
  expect(headerOf(page)).not.toMatch(/href="\/?#|href="\/kolab\/#/);
  expect(headerOf(page)).toContain('<a href="/kolab/">Overview</a>');
  expect(page).toContain('href="/kolab/#circle"');
  expect(page).not.toMatch(/href="\/#|href="#(how|circle|agents|kolabs|signup|top)"/);
  expect(page).toMatch(/<nav class="toc" aria-label="Steps">[\s\S]*href="#before-you-start"/);
  // Code is escaped and kept as written, `$` and all, in a labelled box.
  expect(page).toContain('<figure class="code text"><figcaption>Prompt</figcaption>');
  expect(page).toContain('--kolab $KOLAB');
  expect(page).toContain('&lt;you&gt;-spec-writer');
  // The Kolab page links to it.
  expect(home).toContain('href="/kolab/hands-on/"');
});

test("how Kolab works is built into kolab/how-it-works/index.html as the tutorial is, in Kolab's section, and the Kolab page, its footer and the section's header link to it", () => {
  const r = copy('how-it-works');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const page = read(r, 'kolab/how-it-works/index.html');
  expect(page).toContain('<header><p class="kicker">How it works</p><h1 id="ho-title">Kolab in five minutes</h1></header>');
  expect(page).toMatch(/<title>How it works: Kolab in five minutes: Konjir<\/title>/);
  expect(page).toMatch(/<nav class="toc" aria-label="Sections">[\s\S]*href="#marks"/);
  expect(page).not.toMatch(/\sstyle\s*=|<style\b/i);
  // Its header is the section's, with itself marked as the current page.
  expect(headerOf(page)).toMatch(/<a href="\/kolab\/">Overview<\/a>\n<a href="\/kolab\/how-it-works\/" aria-current="page"[^>]*>How it works<\/a>\n<a href="\/kolab\/hands-on\/">Hands-on tutorial<\/a>/);
  expect(headerOf(read(r, 'kolab/hands-on/index.html'))).toContain('<a href="/kolab/how-it-works/">How it works</a>');
  // It is short: under 700 words, its contents list aside.
  const text = /<article[\s\S]*<\/article>/.exec(page)![0].replace(/<nav class="toc"[\s\S]*?<\/nav>/, '').replace(/<[^>]+>/g, ' ');
  expect(text.split(/\s+/).filter(Boolean).length).toBeLessThan(700);
  // On the Kolab page, "How it works" goes here wherever it is: the header, the hero's button and the footer.
  const home = read(r, 'kolab/index.html');
  expect(home).not.toContain('href="#how"');
  expect(home.match(/<a href="\/kolab\/how-it-works\/"[^>]*>(How it works|See how it works)<\/a>/g)).toHaveLength(3);
});

test("the build refuses a tutorial with Markdown it doesn't render, rather than guess, and escapes any HTML in its text", () => {
  const r = copy('hands-on-refusals');
  const md = join(r, 'site/src/kolab/hands-on.md');
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
    expect(b.stderr).toContain('site/src/kolab/hands-on.md');
    expect(b.stderr).toContain(why);
  }
  writeFileSync(md, `${original}\nA paragraph with <img src=x onerror=alert(1)> in it.\n`);
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const page = read(r, 'kolab/hands-on/index.html');
  expect(page).toContain('A paragraph with &lt;img src=x onerror=alert(1)&gt; in it.');
  expect(page).not.toContain('<img src=x');
});

test("a tutorial title holding markup is escaped wherever it goes, <title> included, and the finished page holds no tag the build didn't write", () => {
  const r = copy('hands-on-title');
  const md = join(r, 'site/src/kolab/hands-on.md');
  const original = readFileSync(md, 'utf8');
  for (const title of [
    'Tutorial </title><script src="https://evil.example/x.js"></script><title>',
    'Tutorial </title><meta http-equiv="refresh" content="0;url=https://evil.example/"><title>',
  ]) {
    writeFileSync(md, original.replace(/^# .*$/m, `# ${title}`));
    const b = build(r);
    expect([b.status, b.stderr]).toStrictEqual([0, '']);
    const page = read(r, 'kolab/hands-on/index.html');
    expect(page).not.toContain('evil.example/x.js"></script>');
    expect(page).not.toMatch(/<meta http-equiv/i);
    expect([...page.matchAll(/<title>/g)]).toHaveLength(1);
    expect(page).toMatch(/<title>Hands-on: Tutorial &lt;\/title&gt;&lt;(script|meta) [^<]*: Konjir<\/title>/);
    expect(page).toMatch(/<meta property="og:title" content="Hands-on: Tutorial &lt;\/title&gt;&lt;(script|meta) [^<"]*: Konjir">/);
    expect(page).toContain('<h1 id="ho-title">Tutorial &lt;/title&gt;&lt;');
  }
});

test('the build checks each finished page whole: a description holding markup is refused, not written', () => {
  const r = copy('page-check');
  const md = join(r, 'site/src/kolab/hands-on.md');
  const original = readFileSync(md, 'utf8');
  // A lead paragraph can't hold markup (it is escaped), so make page() itself write some: a stand-in
  // for a future source of text the renderer doesn't escape.
  const buildPath = join(r, 'deploy/site/build.mjs');
  const script = readFileSync(buildPath, 'utf8');
  expect(script).toContain('p.description = rendered.lead;');
  writeFileSync(buildPath, script.replace('p.description = rendered.lead;', "p.description = rendered.lead + '\"><meta http-equiv=\"refresh\" content=\"0\">';"));
  writeFileSync(md, original);
  const b = build(r);
  expect(b.status).toBe(1);
  // The first article in PAGES is refused, and nothing is written.
  expect(b.stderr).toContain('site/kolab/how-it-works/index.html would have a <head> other than the one the build writes');
  expect(existsSync(join(r, 'site/kolab/how-it-works/index.html'))).toBe(false);
  expect(existsSync(join(r, 'site/kolab/hands-on/index.html'))).toBe(false);
});

test("every page has the one header: the mark links to /, the product switcher marks its section, and only Kolab's pages offer its sign-in", () => {
  const r = copy('header');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  // The switcher's entry says "page" only on a page none of the section's own links names: on
  // /konnect/ its "Overview" link is the current page, so the switcher's konnect is just current.
  const current: Record<string, string> = { 'kolab/index.html': 'page', 'kolab/how-it-works/index.html': 'true', 'kolab/hands-on/index.html': 'true', 'konnect/index.html': 'true', 'konnect/guide/index.html': 'true' };
  for (const file of [...PAGES.map(([f]) => f), '404.html']) {
    const head = headerOf(read(r, file));
    expect(head).toMatch(/<a href="\/" aria-label="Konjir home"[^>]*>/);
    expect(head).toMatch(/<div role="group" aria-label="Products"[^>]*>\n<a href="\/kolab\/"[^>]*>Kolab<\/a>\n<a href="\/konnect\/"[^>]*>konnect<\/a>\n<\/div>/);
    expect(head).toContain('<div role="radiogroup" aria-label="Theme"');
    expect(head.match(/data-theme-choice="(light|dark)"/g)).toStrictEqual(['data-theme-choice="light"', 'data-theme-choice="dark"']);
    const section = file.split('/')[0];
    expect(head.includes(`<a href="/kolab/" aria-current="${current[file]}"`)).toBe(section === 'kolab');
    expect(head.includes(`<a href="/konnect/" aria-current="${current[file]}"`)).toBe(section === 'konnect');
    // The privacy policy, like the 404, is in no section's links: nothing in the header is its page.
    expect((head.match(/aria-current="page"/g) ?? []).length).toBe(file === '404.html' || file === 'privacy/index.html' ? 0 : 1);
    expect(/aria-current="(page|true)"/.test(head.slice(head.indexOf('aria-label="Products"'), head.indexOf('</div>', head.indexOf('aria-label="Products"'))))).toBe(section === 'kolab' || section === 'konnect');
    const signIn = section === 'kolab';
    expect(head.includes('<a href="https://kolab.konjir.com/" class=')).toBe(signIn);
    expect(head.includes('<a href="https://kolab.konjir.com/api/session/oauth/start" class="kb fill')).toBe(signIn);
  }
  // The Kolab page's header keeps its in-page links, and leads to how it works and the tutorial.
  const kolab = headerOf(read(r, 'kolab/index.html'));
  for (const id of ['circle', 'agents', 'kolabs']) expect(kolab).toContain(`<a href="#${id}">`);
  expect(kolab).toContain('<a href="/kolab/how-it-works/">How it works</a>');
  expect(kolab).toMatch(/<a href="\/kolab\/hands-on\/" class="[^"]*">Try it hands-on<\/a>/);
  // konnect's pages link to each other, the current one marked.
  expect(headerOf(read(r, 'konnect/guide/index.html'))).toMatch(/<a href="\/konnect\/">Overview<\/a>\n<a href="\/konnect\/guide\/" aria-current="page"[^>]*>Guide<\/a>/);
  // The org page links to each product; konnect's page says how to install it.
  expect(read(r, 'index.html')).toMatch(/<main>[\s\S]*<a href="\/kolab\/"[\s\S]*<a href="\/konnect\/"[\s\S]*<\/main>/);
  expect(read(r, 'konnect/index.html')).toContain('npm i -g @konjir/konnect');
});

test("on a narrow screen every header is one row, the mark, the product switcher and a menu button, whose <details> holds the section's links, the theme switch and the sign-in; on a wide one they sit in the row", () => {
  const r = copy('menu');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  for (const file of [...PAGES.map(([f]) => f), '404.html']) {
    const head = headerOf(read(r, file));
    // The row: the mark and the switcher, then the menu, closed, so with no script its summary opens it.
    expect(head).toMatch(/<nav aria-label="Main" class="hd [^"]*">\n<div class="hd-brand">\n<a href="\/" aria-label="Konjir home"[\s\S]*?<div role="group" aria-label="Products"[\s\S]*?<\/div>\n<\/div>\n<details class="menu" data-menu="">\n<summary class="kb line"><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span class="menu-label">Menu<\/span><\/summary>\n<div class="menu-panel">/);
    expect(head.match(/<details\b/g)).toHaveLength(1);
    expect(head).toMatch(/<\/details>\n<\/nav>\n<\/header>$/);
    // In the menu: every link but the mark and the switcher's, the theme switch and Kolab's sign-in.
    const menu = head.slice(head.indexOf('<details'));
    const outside = head.slice(0, head.indexOf('<details'));
    expect([...outside.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])).toStrictEqual(['/', '/kolab/', '/konnect/']);
    expect(menu).toContain('<div role="radiogroup" aria-label="Theme"');
    if (file.startsWith('kolab/')) for (const href of ['https://kolab.konjir.com/', 'https://kolab.konjir.com/api/session/oauth/start']) expect(menu).toContain(`<a href="${href}"`);
    // The menu's own links come first, in the section's order.
    expect(menu.indexOf('<div class="menu-links">')).toBeLessThan(menu.indexOf('<div class="menu-end">'));
  }
  expect(headerOf(read(r, 'konnect/guide/index.html'))).toMatch(/<div class="menu-links">\n<a href="\/konnect\/">Overview<\/a>\n<a href="\/konnect\/guide\/" aria-current="page"[^>]*>Guide<\/a>\n<\/div>/);
  // The org page has no section links, so its menu holds only the theme switch.
  expect(headerOf(read(r, 'index.html'))).toContain('<div class="menu-links"></div>');

  // The stylesheet says when the screen is narrow, in the menu's --menu, which site.js reads: the
  // summary shows and the menu opens beneath it below 1200px; at 1200px and up the summary is hidden
  // and the menu's content shows even while it is closed (as it is with no script).
  const css = readFileSync(join(r, 'site', /href="(\/assets\/site\.[0-9a-f]{10}\.css)"/.exec(read(r, 'index.html'))![1]), 'utf8');
  expect(css).toContain('@media (min-width: 1200px){.menu{--menu:wide;');
  expect(css).toContain('.menu>summary{display:none}');
  expect(css).toContain('@media (min-width: 1200px){.menu::details-content{content-visibility:visible}}');
  expect(css).toMatch(/@media not all and \(min-width: 1200px\)\{\.menu\{--menu:narrow;[^\n]*\.menu-panel\{position:absolute;/);
  // In min-width, not range syntax (width < 1200px), which Safari reads only from 16.4: before it, an
  // older iPhone's Safari would apply neither, and show the menu both closed and open. A narrow rule
  // is `not all and` the wide one's, so every width, a fractional one from zoom too, gets exactly one.
  const queries = css.match(/@media[^{;]*/g) ?? [];
  expect(queries).toContain('@media not all and (min-width: 440px)');
  expect(queries).toContain('@media not all and (min-width: 380px)');
  for (const q of queries) expect(q).not.toMatch(/\(\s*[a-z-]+\s*[<>]|[<>]=?\s*[a-z-]+\s*\)|[<>]/);
  const js = readFileSync(join(r, 'site', /src="(\/assets\/site\.[0-9a-f]{10}\.js)"/.exec(read(r, 'index.html'))![1]), 'utf8');
  expect(js).toContain("getPropertyValue('--menu')");
  expect(js).toContain("e.key !== 'Escape'");
});

test('every footer links to the source on GitHub, both packages on npm and their licences, and the privacy policy, and to no terms or contact yet', () => {
  const r = copy('footer');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const links = [
    ['https://github.com/konjir/kolab', 'GitHub'],
    ['https://www.npmjs.com/package/@konjir/kolab', '@konjir/kolab on npm'],
    ['https://www.npmjs.com/package/@konjir/konnect', '@konjir/konnect on npm'],
    ['https://github.com/konjir/kolab/blob/main/LICENSE.md', 'Kolab server licence (FSL-1.1-ALv2)'],
    ['https://github.com/konjir/kolab/blob/main/apps/cli/LICENSE', 'kolab CLI licence (Apache-2.0)'],
    ['https://github.com/konjir/kolab/blob/main/apps/konnect/LICENSE', 'konnect licence (Apache-2.0)'],
    ['/privacy/', 'Privacy'],
  ];
  const nav = new RegExp(`<nav aria-label="Source and licences" class="[^"]*">\\n${links.map(([href, text]) => `<a href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`).join('\\n')}\\n</nav>`);
  // Kolab's own footer (site/src/kolab/footer.html, on Kolab's pages) and the shared one (every other page and the 404) alike.
  for (const file of [...PAGES.map(([f]) => f), '404.html']) {
    const foot = /<footer\b[\s\S]*<\/footer>/.exec(read(r, file))![0];
    expect([file, nav.test(foot)]).toStrictEqual([file, true]);
    expect(foot).not.toMatch(/terms|contact|mailto:/i);
  }
  // The licences it names are the repository's: the server's FSL, the CLIs' Apache-2.0.
  expect(readFileSync(join(ROOT, 'LICENSE.md'), 'utf8')).toContain('FSL-1.1-ALv2');
  for (const app of ['cli', 'konnect']) {
    expect(readFileSync(join(ROOT, `apps/${app}/LICENSE`), 'utf8')).toContain('Apache License');
    expect(JSON.parse(readFileSync(join(ROOT, `apps/${app}/package.json`), 'utf8')).license).toBe('Apache-2.0');
  }
});

test("the theme switch says which theme is on: its radios' aria-checked, and only the checked one a tab stop, follow the theme site.js applies", () => {
  const r = copy('theme');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  // Written dark first, as the root's data-theme is, for a page read with no script.
  for (const file of [...PAGES.map(([f]) => f), '404.html']) {
    const html = read(r, file);
    expect(html).toMatch(/<div class="kj[^"]*" data-theme="dark"/);
    expect(html).toMatch(/role="radio" class="tt" aria-label="Daybreak, the light theme" title="Daybreak" aria-checked="false" tabindex="-1" data-theme-choice="light"/);
    expect(html).toMatch(/role="radio" class="tt" aria-label="Predawn, the dark theme" title="Predawn" aria-checked="true" tabindex="0" data-theme-choice="dark"/);
  }
  const js = readFileSync(join(ROOT, 'deploy/site/site.js'), 'utf8');
  expect(js).toContain("buttons[i].setAttribute('aria-checked', on ? 'true' : 'false');");
  expect(js).toContain('buttons[i].tabIndex = on ? 0 : -1;');
});

test("konnect's page is its <main>, in the shared header and footer: the install line, the three commands, an agent woken by a message, what it needs, and its links", () => {
  const r = copy('konnect');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const page = read(r, 'konnect/index.html');
  expect(page).toMatch(/<h1 id="konnect-title"[^>]*>Chat for your team’s people and their AI agents\.<\/h1>/);
  expect(page).toMatch(/<meta name="description" content="konnect works from the command line, across machines\. [^"]*">/);
  // The same stylesheet and script as every page, and no inline style or other script.
  expect(assetsOf(r)).toStrictEqual([...page.matchAll(/\/assets\/(site\.[0-9a-f]{10}\.(?:css|js))/g)].map((m) => m[1]).sort());
  expect(page).not.toMatch(/\sstyle\s*=|<style\b/i);
  expect([...page.matchAll(/<script\b/g)]).toHaveLength(1);
  for (const command of ['konnect team create acme', 'konnect team invite sam-gh', 'konnect login', 'konnect receive', 'konnect send @sam-gh/reviewer', 'konnect agent run reviewer claude', 'npx @konjir/konnect']) expect(page).toContain(command);
  // Output as konnect prints it, escaped.
  expect(page).toContain('Invite people with: konnect team invite &lt;github-user&gt;');
  expect(page).toContain('Sent to @sam-gh/reviewer.');
  expect(page).toContain('Your agent @sam-gh/reviewer is added to team acme.');
  // What konnect tells an agent is said to be words, not a permission.
  expect(page).toContain('That is its system prompt, not a permission');
  for (const harness of ['Claude Code', 'Codex', 'OpenCode']) expect(page).toContain(`>${harness}</h3>`);
  for (const href of ['/konnect/guide/', 'https://github.com/konjir/kolab/blob/main/apps/konnect/man/konnect.1', 'https://www.npmjs.com/package/@konjir/konnect']) expect(page).toContain(`<a href="${href}"`);
  // It ends with the shared footer, as the guide does.
  expect(page).toContain('<nav aria-label="Footer"');
});

test('every page names its canonical URL on www, with Open Graph and Twitter tags; the sitemap lists them all, robots.txt names it, and the 404 page is noindex', () => {
  const r = copy('seo');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  for (const [file, url] of PAGES) {
    const html = read(r, file);
    const title = /<title>([^<]*)<\/title>/.exec(html)![1];
    const description = /<meta name="description" content="([^"]*)">/.exec(html)![1];
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(html).toContain(`<meta property="og:url" content="${url}">`);
    expect(html).toContain(`<meta property="og:title" content="${title}">`);
    expect(html).toContain(`<meta name="twitter:title" content="${title}">`);
    expect(html).toContain(`<meta property="og:description" content="${description}">`);
    expect(html).toContain(`<meta name="twitter:description" content="${description}">`);
    // konnect's pages name konnect's own image; every other page the org page's.
    expect(html).toContain(`<meta property="og:image" content="https://www.konjir.com/og/${file.startsWith('konnect/') ? 'konnect' : 'www'}.jpg">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  }
  for (const og of ['www', 'konnect']) expect(readFileSync(join(r, `site/og/${og}.jpg`)).subarray(0, 3)).toStrictEqual(Buffer.from([0xff, 0xd8, 0xff]));
  expect(read(r, 'konnect/index.html')).toContain('<meta property="og:image:alt" content="konnect: chat for your team’s people and their AI agents, from the command line. npm i -g @konjir/konnect">');
  expect(read(r, 'sitemap.xml')).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map(([, url]) => `<url><loc>${url}</loc></url>\n`).join('')}</urlset>\n`,
  );
  expect(read(r, 'robots.txt')).toBe('User-agent: *\nAllow: /\nSitemap: https://www.konjir.com/sitemap.xml\n');
  const notFound = read(r, '404.html');
  expect(notFound).toContain('<meta name="robots" content="noindex">');
  expect(notFound).not.toContain('rel="canonical"');
});

test("the org page says what Konjir is, gives a card to each product with its install line, and says which one you need", () => {
  const r = copy('org');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const page = read(r, 'index.html');
  expect(page).toMatch(/<h1 id="www-title"[^>]*>Tools for teams of people and their AI agents\.<\/h1>/);
  expect(page).toMatch(/<meta name="description" content="Konjir makes two of them: Kolab, [^"]*konnect, [^"]*">/);
  expect(page).toMatch(/<h2 id="kolab-title"[^>]*>Kolab<\/h2>[\s\S]*npm i -g @konjir\/kolab[\s\S]*<a href="\/kolab\/" class="kb line[^"]*">Kolab’s page →<\/a>/);
  // Kolab's card doesn't send people to the tutorial, and the page doesn't say "binding" unexplained.
  expect(/<main>[\s\S]*<\/main>/.exec(page)![0]).not.toMatch(/hands-on|binding/i);
  expect(page).toMatch(/<h2 id="konnect-title"[^>]*>konnect<\/h2>[\s\S]*npm i -g @konjir\/konnect[\s\S]*<a href="\/konnect\/" class="kb line[^"]*">konnect’s page →<\/a>/);
  expect(page).toMatch(/<h2 id="which-title"[^>]*>Which one do I need\?<\/h2>/);
  expect(page).not.toMatch(/\sstyle\s*=|<style\b/i);
});

test("site/src/ is plain source the repository owns, of the kinds the build reads, and nothing in it, the build, its README or the built site links to claude.ai or holds a template hole", () => {
  const src = join(ROOT, 'site/src');
  const files = filesIn(src).sort();
  // The shared stylesheet, and each section's main page, its own footer, its Markdown pages and its Open Graph image.
  const KINDS = [/^site\.css$/, /^[a-z0-9-]+\/(main|footer)\.html$/, /^[a-z0-9-]+\/[a-z0-9-]+\.md$/, /^[a-z0-9-]+\/og\.jpg$/];
  expect(files.filter((f) => !KINDS.some((k) => k.test(f)))).toStrictEqual([]);
  expect(files).toEqual(expect.arrayContaining(['site.css', 'www/main.html', 'kolab/main.html', 'kolab/footer.html', 'konnect/main.html']));
  // A main.html is one <main> and a footer.html one <footer>: never a whole document of its own.
  for (const f of files.filter((n) => n.endsWith('.html'))) {
    const text = readFileSync(join(src, f), 'utf8').trim();
    expect([f, text.startsWith(f.endsWith('main.html') ? '<main>' : '<footer'), /<\/?(html|head|body|title|meta|link|script|style)\b/i.test(text)]).toStrictEqual([f, true, false]);
  }
  const built = filesIn(join(ROOT, 'site'))
    .filter((f) => !f.startsWith('src/') && f !== 'README.md' && /\.(html|css|js|xml|txt)$/.test(f))
    .map((f) => join(ROOT, 'site', f));
  const sources = files.filter((f) => !f.endsWith('.jpg')).map((f) => join(src, f));
  const tools = filesIn(join(ROOT, 'deploy/site'))
    .filter((f) => /\.(mjs|js|css|html|json)$/.test(f))
    .map((f) => join(ROOT, 'deploy/site', f));
  const claudeLink = /https?:\/\/(?:[a-z0-9-]+\.)*claude\.ai\//i;
  for (const f of [...sources, ...built, ...tools, join(ROOT, 'site/README.md')]) {
    expect([relative(ROOT, f), claudeLink.test(readFileSync(f, 'utf8'))]).toStrictEqual([relative(ROOT, f), false]);
  }
  for (const f of [...sources, ...built]) expect([relative(ROOT, f), /\{\{/.test(readFileSync(f, 'utf8'))]).toStrictEqual([relative(ROOT, f), false]);
});

test('every path on this site that a built page or the stylesheet names is a file the build wrote', () => {
  const r = copy('paths');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const missing: string[] = [];
  const named = (file: string, text: string, re: RegExp) => {
    for (const m of text.matchAll(re)) {
      const path = m[1].replace(/[#?].*$/, '');
      if (!existsSync(join(r, 'site', path.endsWith('/') ? `${path}index.html` : path))) missing.push(`${file}: ${m[1]}`);
    }
  };
  for (const file of [...PAGES.map(([f]) => f), '404.html']) named(file, read(r, file), /\s(?:href|src)="(\/(?!\/)[^"]*)"/g);
  const cssPath = /href="\/(assets\/site\.[0-9a-f]{10}\.css)"/.exec(read(r, 'index.html'))![1];
  named(cssPath, read(r, cssPath), /url\((\/[^)]+)\)/g);
  expect(missing).toStrictEqual([]);
});

test("the build refuses an element it doesn't know, a template hole, a footer link to an id its section's page lacks, a stylesheet that loads something, and any argument", () => {
  const r = copy('source-refusals');
  const page = kolabPage(r);
  const original = readFileSync(page, 'utf8');
  for (const [add, why] of [
    ['<x-page><p>Hi</p></x-page>', "an element the build doesn't know, <x-page>"],
    ['<wrapper><p>Hi</p></wrapper>', "an element the build doesn't know, <wrapper>"],
    ['<p data-theme="{{theme}}">Hi</p>', 'an unhandled template hole'],
    ['<img src="https://example.com/x.png" alt="">', "a resource that isn't this site's own"],
    ['<p onclick="go()">Hi</p>', 'an event handler attribute'],
    // What the CSP would block, refused before it can ship: scripts, frames, other files' styles, script URLs.
    ['<script>alert(1)</script>', 'a <script>, <style>, <iframe>'],
    ['<iframe src="/x/"></iframe>', 'a <script>, <style>, <iframe>'],
    ['<link rel="stylesheet" href="/x.css">', 'a <script>, <style>, <iframe>'],
    ['<a href="javascript:alert(1)">Hi</a>', 'a javascript: URL'],
    ['<p style="background:url(/x.png)">Hi</p>', 'a style with url()'],
    ['</main>\n<main>', 'must be one <main>…</main>'],
  ]) {
    writeFileSync(page, original.replace('</main>', `${add}\n</main>`));
    const b = build(r);
    expect([b.status, add]).toStrictEqual([1, add]);
    expect(b.stderr).toContain('site/src/kolab/main.html');
    expect(b.stderr).toContain(why);
  }
  writeFileSync(page, original);

  const foot = join(r, 'site/src/kolab/footer.html');
  const footer = readFileSync(foot, 'utf8');
  expect(footer).toContain('<a href="#signup">');
  writeFileSync(foot, footer.replace('<a href="#signup">', '<a href="#nowhere">'));
  expect(build(r).stderr).toContain('site/src/kolab/footer.html links to #nowhere, which site/src/kolab/main.html has no id for');
  writeFileSync(foot, footer);

  const css = join(r, 'site/src/site.css');
  const sheet = readFileSync(css, 'utf8');
  writeFileSync(css, `${sheet}.x{background:url(/x.png)}\n`);
  expect(build(r).stderr).toContain('site/src/site.css loads something');
  writeFileSync(css, sheet);

  const withArgs = spawnSync(process.execPath, [join(r, 'deploy/site/build.mjs'), 'page.html', 'images'], { cwd: r, encoding: 'utf8' });
  expect([withArgs.status, withArgs.stderr]).toStrictEqual([2, 'usage: node deploy/site/build.mjs\n']);

  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
});

test("konnect's app's sign-in redirect lands on a page of its own, which says to open or install konnect, is in no sitemap, and never reads the URL it was sent; the preview build's own path has the same page", () => {
  const r = copy('app-page');
  const b = build(r);
  expect([b.status, b.stderr]).toStrictEqual([0, '']);
  const page = read(r, 'konnect/app/oauth/index.html');
  expect(read(r, 'konnect/app/preview/oauth/index.html')).toBe(page);
  // Neither path is any other page's, or under one: /konnect/app/ holds these two alone.
  expect(readdirSync(join(r, 'site/konnect/app')).sort()).toStrictEqual(['oauth', 'preview']);
  expect(readdirSync(join(r, 'site/konnect/app/preview'))).toStrictEqual(['oauth']);
  expect(page).toMatch(/<h1 id="app-title"[^>]*>Open konnect to finish signing in\.<\/h1>/);
  expect(page).toContain('<meta name="robots" content="noindex">');
  expect(page).not.toContain('rel="canonical"');
  expect(read(r, 'sitemap.xml')).not.toContain('/konnect/app/');
  // Its one script is the site's, which never looks at the address: the code in its query is never shown or used.
  expect([...page.matchAll(/<script\b/g)].length).toBe(1);
  expect(page).toMatch(/<script src="\/assets\/site\.[0-9a-f]{10}\.js"><\/script>/);
  const js = readFileSync(join(r, 'deploy/site/site.js'), 'utf8');
  expect(js).not.toMatch(/location\.(search|href|hash)|URLSearchParams|document\.URL|document\.referrer/);
  expect(page).not.toMatch(/\{\{|code=/);
});

test("konnect's app links are written only from ids filled in deploy/site/app-links.json, each checked, and are otherwise left out and said so, failing closed", () => {
  const r = copy('app-links');
  const config = JSON.parse(readFileSync(join(r, 'deploy/site/app-links.json'), 'utf8'));
  const emptied = { ...config, apple_team_id: null, android: config.android.map((a: { package: string }) => ({ ...a, sha256_cert_fingerprints: [] })) };
  // With no ids: neither file, and the build says why.
  writeFileSync(join(r, 'deploy/site/app-links.json'), JSON.stringify(emptied));
  const empty = build(r);
  expect([empty.status, empty.stderr]).toStrictEqual([0, '']);
  expect(empty.stdout).toContain('no apple-app-site-association: apple_team_id is not filled in');
  expect(empty.stdout).toContain('no assetlinks.json: no Android package has a fingerprint filled in');
  expect(existsSync(join(r, 'site/.well-known'))).toBe(false);
  // Filled in: Apple's and Google's files, for that path and those apps alone.
  const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
  config.apple_team_id = 'ABCDE12345';
  config.android[0].sha256_cert_fingerprints = [fp];
  writeFileSync(join(r, 'deploy/site/app-links.json'), JSON.stringify(config));
  const filled = build(r);
  expect([filled.status, filled.stderr]).toStrictEqual([0, '']);
  expect(filled.stdout).not.toContain('no apple-app-site-association');
  const aasa = JSON.parse(read(r, '.well-known/apple-app-site-association'));
  // Each build only its own path, so with both installed each takes only its own sign-in.
  expect(aasa).toStrictEqual({
    applinks: { details: [
      { appIDs: ['ABCDE12345.com.konjir.konnect'], components: [{ '/': '/konnect/app/oauth', comment: 'konnect\'s sign-in redirect for this build, and nothing else on this site' }] },
      { appIDs: ['ABCDE12345.com.konjir.konnect.preview'], components: [{ '/': '/konnect/app/preview/oauth', comment: 'konnect\'s sign-in redirect for this build, and nothing else on this site' }] },
    ] },
    webcredentials: { apps: ['ABCDE12345.com.konjir.konnect', 'ABCDE12345.com.konjir.konnect.preview'] },
  });
  // Only the package with a fingerprint is named.
  expect(JSON.parse(read(r, '.well-known/assetlinks.json'))).toStrictEqual([
    { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'com.konjir.konnect', sha256_cert_fingerprints: [fp] } },
  ]);
  // Anything that isn't an id is refused, and writes nothing new.
  const swapped = { 'com.konjir.konnect': '/konnect/app/preview/oauth', 'com.konjir.konnect.preview': '/konnect/app/oauth' };
  const shared = { 'com.konjir.konnect': '/konnect/app/oauth', 'com.konjir.konnect.preview': '/konnect/app/oauth' };
  for (const [key, bad] of [['apple_team_id', 'abcde12345'], ['apple_team_id', 'TOO-LONG-123'], ['paths', '/elsewhere'], ['paths', swapped], ['paths', shared], ['paths', null]] as const) {
    writeFileSync(join(r, 'deploy/site/app-links.json'), JSON.stringify({ ...config, [key]: bad }));
    const refused = build(r);
    expect([key, bad, refused.status, refused.stderr]).toStrictEqual([key, bad, 1, expect.stringMatching(/^build: deploy\/site\/app-links\.json/)]);
    expect(read(r, '.well-known/apple-app-site-association')).toBe(`${JSON.stringify(aasa, null, 2)}\n`);
  }
  writeFileSync(join(r, 'deploy/site/app-links.json'), JSON.stringify({ ...config, android: [{ package: 'com.konjir.konnect', sha256_cert_fingerprints: ['aa:bb'] }] }));
  expect(build(r).stderr).toMatch(/has a fingerprint that isn't one/);
  writeFileSync(join(r, 'deploy/site/app-links.json'), JSON.stringify({ ...config, ios_bundle_ids: ['com.example.other'] }));
  expect(build(r).stderr).toMatch(/ios_bundle_ids are konnect's own/);
  // Emptied again: both go.
  writeFileSync(join(r, 'deploy/site/app-links.json'), JSON.stringify(emptied));
  expect(build(r).status).toBe(0);
  expect(existsSync(join(r, 'site/.well-known'))).toBe(false);
});
