#!/usr/bin/env node
// Builds site/ (konjir.com, D81) from the page's source in site/src/ (D92).
//
//   node deploy/site/build.mjs [<Main.dc.html> <images-dir>]
//
// With no arguments it reads site/src/project/Main.dc.html, the artboard (the "Konjir Marketing
// Page" artifact is published from site/src/), and site/src/images/, which holds each image the
// page names as /_blob/<id>, saved as <id>.<ext>. Both paths can be given instead.
// It reads nothing from the network: the fonts are vendored in deploy/site/fonts/ (vendor-fonts.mjs).
// It writes only site/'s built files and never touches site/src/ or site/README.md. See site/README.md.
//
// The artboard runs on the artifact's Design Component runtime. The site can't, so this:
//  - drops the runtime (support.js) and its <x-dc>/<helmet> wrappers;
//  - replaces the component logic (theme state and the theme radio group) with deploy/site/site.js;
//  - serves the vendored fonts, checked against source.json, with each family's OFL licence;
//  - moves every inline style="" into a generated class, so the CSP needs no 'unsafe-inline';
//  - hashes asset names (site/assets/), so they can be cached for a year, and keeps the previous
//    build's hashed assets one more build, so a page still cached for a minute finds its CSS;
//  - writes 404.html from the same header and footer, plus robots.txt and the favicon;
//  - renders the hands-on tutorial, site/src/hands-on.md, with markdown.mjs into the same header
//    and footer, as hands-on/index.html (https://konjir.com/hands-on/), styled by article.css.
// It refuses an artboard that uses anything else from the runtime, or anything the CSP would
// block (scripts, handlers, frames, javascript: URLs, other origins' resources), rather than guess.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './markdown.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = join(repo, 'site');
const fontsDir = join(here, 'fonts');
const sourceDir = join(out, 'src');
const args = process.argv.slice(2);
if (args.length !== 0 && args.length !== 2) {
  console.error('usage: node deploy/site/build.mjs [<Main.dc.html> <images-dir>]');
  process.exit(2);
}
const [srcPath, assetsDir] = args.length ? args.map((a) => resolve(a)) : [join(sourceDir, 'project', 'Main.dc.html'), join(sourceDir, 'images')];

const fail = (msg) => {
  console.error(`build: ${msg}`);
  process.exit(1);
};
if (!existsSync(srcPath)) fail(`no artboard at ${srcPath}`);

// The build writes only these in site/; site/src/ (the source) and site/README.md are never its.
const outputs = new Set(['index.html', '404.html', 'robots.txt', 'favicon.svg', 'assets', 'hands-on']);
// The pages, by their path in site/: each names the assets it uses.
const PAGES = ['index.html', '404.html', 'hands-on/index.html'];
const handsOnPath = join(sourceDir, 'hands-on.md');
if (!existsSync(handsOnPath)) fail(`no tutorial at ${handsOnPath}`);
const outPath = (rel) => {
  const parts = rel.split(/[\\/]/);
  if (isAbsolute(rel) || parts.includes('..') || !outputs.has(parts[0])) fail(`refusing to write site/${rel}, which the build doesn't own`);
  return join(out, rel);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hash = (buf) => sha256(buf).slice(0, 10);
const HASHED = /\.[0-9a-f]{10}\.[a-z0-9]+$/;

const src = readFileSync(srcPath, 'utf8');

for (const tag of ['<sc-for', '<sc-if', '<dc-import', '<x-import']) {
  if (src.includes(tag)) fail(`the artboard uses ${tag}>, which this converter doesn't render; extend it`);
}

const lang = /<html\s+lang="([^"]+)"/.exec(src)?.[1] ?? 'en';
const title = /<title>([\s\S]*?)<\/title>/.exec(src)?.[1].trim() ?? fail('no <title>');
const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(src)?.[1] ?? fail('no <helmet>');
const xdc = /<\/helmet>([\s\S]*?)<\/x-dc>/.exec(src)?.[1].trim() ?? fail('no <x-dc> body');

// The helmet: font links, preconnects and one <style>. Anything else is unexpected.
const fontHrefs = [...helmet.matchAll(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)">/g)].map((m) =>
  m[1].replaceAll('&amp;', '&'),
);
const baseCss = [...helmet.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1].trim()).join('\n');
const rest = helmet
  .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+">/g, '')
  .replace(/<link rel="preconnect"[^>]*>/g, '')
  .replace(/<style>[\s\S]*?<\/style>/g, '')
  .trim();
if (rest) fail(`unexpected <helmet> content: ${rest.slice(0, 120)}`);
if (/url\(|@import/i.test(baseCss)) fail('the helmet <style> loads something (url() or @import); extend the converter');

// The previous build's hashed assets, kept one more build (see the header): the ones site/'s pages
// use at the merge base with origin/main, which is what main and so the last deploy serves, and at
// every commit since it up to HEAD. So a rebuild on a branch, even after the branch's own builds
// are committed, never drops what production serves, and rebuilding a committed build changes
// nothing. On main itself that is HEAD alone, so the builds before the last one are pruned there.
// Without an origin/main, HEAD alone; outside a git checkout, the ones site/ uses now.
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
const revs = [];
if (git('rev-parse', '--verify', '-q', 'HEAD').status === 0) {
  revs.push('HEAD');
  const base = git('merge-base', 'HEAD', 'origin/main');
  if (base.status === 0) {
    const b = base.stdout.trim();
    revs.push(b, ...git('rev-list', `${b}..HEAD`, '--', ...PAGES.map((p) => `site/${p}`)).stdout.split('\n').filter(Boolean));
  }
}
const previous = new Set();
const refsIn = (rel) => {
  const texts = revs.length
    ? revs.map((rev) => git('show', `${rev}:${rel}`)).filter((r) => r.status === 0).map((r) => r.stdout)
    : existsSync(join(repo, rel)) ? [readFileSync(join(repo, rel), 'utf8')] : [];
  for (const text of texts) for (const m of text.matchAll(/\/assets\/([^"')\s]+)/g)) previous.add(m[1]);
};
for (const p of PAGES) refsIn(`site/${p}`);
for (const p of [...previous]) if (p.endsWith('.css')) refsIn(`site/assets/${p}`);

mkdirSync(outPath('assets/fonts'), { recursive: true });
const current = new Set();
const emit = (stem, ext, buf) => {
  const name = `${stem}.${hash(buf)}${ext}`;
  writeFileSync(outPath(`assets/${name}`), buf);
  current.add(name);
  return `/assets/${name}`;
};

// Fonts: the vendored copy, which must be the one the artboard links, byte for byte.
let fontCss = '';
if (fontHrefs.length) {
  const manifest = JSON.parse(readFileSync(join(fontsDir, 'source.json'), 'utf8'));
  for (const href of fontHrefs) {
    if (href !== manifest.href) fail(`the artboard links fonts the vendored copy isn't: run node deploy/site/vendor-fonts.mjs '${href}'`);
  }
  const vendored = {};
  for (const [name, digest] of Object.entries(manifest.files)) {
    const buf = readFileSync(join(fontsDir, name));
    if (sha256(buf) !== digest) fail(`deploy/site/fonts/${name} doesn't match source.json`);
    vendored[name] = buf;
  }
  fontCss = vendored['fonts.css'].toString('utf8').replace(/url\(([\w.-]+\.woff2)\)/g, (_, name) => {
    const buf = vendored[name] ?? fail(`fonts.css names ${name}, which isn't vendored`);
    return `url(${emit(`fonts/${name.replace(/\.woff2$/, '')}`, '.woff2', buf)})`;
  });
  for (const name of Object.keys(vendored).filter((n) => n.endsWith('-OFL.txt'))) {
    writeFileSync(outPath(`assets/fonts/${name}`), vendored[name]);
  }
}

// Images the page names as /_blob/<id>.
const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
const blobs = new Map();
const withBlobs = (html) =>
  html.replace(/\/_blob\/([0-9a-f]{32})/g, (_, id) => {
    if (!blobs.has(id)) {
      const file = assetFiles.find((f) => f.startsWith(`${id}.`)) ?? fail(`no file for /_blob/${id} in ${assetsDir}`);
      blobs.set(id, emit('img', extname(file).toLowerCase(), readFileSync(join(assetsDir, file))));
    }
    return blobs.get(id);
  });

// The component's holes. The theme defaults to dark, as renderVals() does; site.js takes it from there.
let body = withBlobs(xdc)
  .replace(/data-theme="\{\{\s*theme\s*\}\}"/g, 'data-theme="dark"')
  .replace(/<button\b[^>]*>/g, (tag) => {
    const choice = tag.includes('{{setLight}}') ? 'light' : tag.includes('{{setDark}}') ? 'dark' : null;
    if (!choice) return tag;
    return tag
      .replace(/\s(aria-checked|tabIndex|onClick|onKeyDown)="\{\{[^}]*\}\}"/g, '')
      .replace(/>$/, ` aria-checked="${choice === 'dark'}" tabindex="${choice === 'dark' ? 0 : -1}" data-theme-choice="${choice}">`);
  });

// What the static page and its CSP can't have. Links to other sites are fine; loading from them isn't.
const refuse = [
  [/\{\{[^}]*\}\}/, 'an unhandled template hole'],
  [/<[^>]*\son[a-z]+\s*=/i, 'an event handler attribute'],
  [/<(script|style|iframe|frame|object|embed|link|meta|base|form)\b/i, 'a <script>, <style>, <iframe>, <object>, <embed>, <link>, <meta>, <base> or <form> in the body'],
  [/javascript:/i, 'a javascript: URL'],
  [/\s(src|srcset|poster|data|action|formaction)\s*=\s*"(?!\/(?!\/))[^"]*"/i, 'a resource that isn\'t this site\'s own (an absolute /path)'],
  [/<(?!a\b)[a-z][\w-]*\b[^>]*\shref\s*=\s*"(?!#)/i, 'an href on anything but <a> that leaves the page'],
  [/\sstyle\s*=\s*"[^"]*(url\(|@import|expression\(|[{}<])/i, 'a style with url(), @import, expression() or a brace'],
];
for (const [re, what] of refuse) {
  const m = re.exec(body);
  if (m) fail(`the artboard has ${what}: ${body.slice(m.index, m.index + 80)}`);
}

// The 404 page: the same header and footer around its own main; in-page links point home.
let notFound = body.replace(/<main>[\s\S]*<\/main>/, readFileSync(join(here, '404-main.html'), 'utf8').trim());
if (notFound === body) fail('no <main> to swap for the 404 page');
notFound = notFound.replace(/href="#top"/g, 'href="/"').replace(/href="#/g, 'href="/#');

// The hands-on tutorial: the same header and footer, with in-page links pointing home, around the
// article markdown.mjs renders. A function replaces <main>, since the article's code holds `$`s.
const tutorial = render(readFileSync(handsOnPath, 'utf8'), (m) => fail(`site/src/hands-on.md: ${m}`));
const toc = `<nav class="toc" aria-label="Steps"><p>On this page</p><ol>${tutorial.toc.map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join('')}</ol></nav>`;
const firstH2 = tutorial.html.indexOf('<h2 ');
const article = `<main>
<article class="ho" aria-labelledby="ho-title">
<header><p class="kicker">Hands-on</p><h1 id="ho-title">${tutorial.title.html}</h1></header>
${firstH2 < 0 ? tutorial.html : `${tutorial.html.slice(0, firstH2)}${toc}\n${tutorial.html.slice(firstH2)}`}
</article>
</main>`;
for (const [re, what] of refuse) {
  const m = re.exec(article);
  if (m) fail(`site/src/hands-on.md renders ${what}: ${article.slice(m.index, m.index + 80)}`);
}
let handsOn = body.replace(/href="#top"/g, 'href="/"').replace(/href="#/g, 'href="/#').replace(/<main>[\s\S]*<\/main>/, () => article);
if (!handsOn.includes('class="ho"')) fail('no <main> to swap for the tutorial');

// Inline styles become classes. ".kj .sN" outranks the helmet's element rules (a:hover) as the
// inline style did, and ".kj.sN" covers the root itself.
const classes = new Map();
const unstyle = (html) =>
  html.replace(/<([a-zA-Z][\w-]*)(\s[^>]*?)?(\/?)>/g, (tag, name, attrs = '', slash) => {
    const m = /\sstyle="([^"]*)"/.exec(attrs);
    if (!m) return tag;
    const decl = m[1].trim().replace(/;$/, '');
    if (/[{}<]/.test(decl)) fail(`a style that could escape its rule: ${decl.slice(0, 80)}`);
    if (!classes.has(decl)) classes.set(decl, `s${classes.size + 1}`);
    const cls = classes.get(decl);
    let a = attrs.replace(m[0], '');
    a = /\sclass="/.test(a) ? a.replace(/\sclass="([^"]*)"/, (_, c) => ` class="${c} ${cls}"`) : `${a} class="${cls}"`;
    return `<${name}${a}${slash}>`;
  });
body = unstyle(body);
notFound = unstyle(notFound);
handsOn = unstyle(handsOn);
if (/\sstyle\s*=/i.test(body + notFound + handsOn)) fail('an inline style survived');

const css = [
  '/* Generated by deploy/site/build.mjs from site/src/. Do not edit. */',
  '/* Fonts: Fraunces, Instrument Sans and JetBrains Mono, SIL Open Font License 1.1: /assets/fonts/*-OFL.txt */',
  fontCss.trim(),
  baseCss,
  ...[...classes].map(([decl, cls]) => `.kj .${cls},.kj.${cls}{${decl}}`),
  readFileSync(join(here, 'article.css'), 'utf8').trim(),
].join('\n');
if (/url\(|@import/i.test(css.slice(css.indexOf('/* Article pages')))) fail('article.css loads something (url() or @import)');
const cssHref = emit('site', '.css', Buffer.from(css + '\n'));
const jsHref = emit('site', '.js', readFileSync(join(here, 'site.js')));

const description =
  /<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/
    .exec(body)?.[1]
    .replace(/<[^>]+>/g, '')
    .trim() ?? fail('no lead paragraph after the <h1> for the description');

const page = (pageTitle, main, pageDescription = description) => {
  // site.js goes first inside the .kj root, so the stored theme applies before anything paints.
  const withScript = main.replace(/(<div class="kj[^"]*"[^>]*>)/, `$1\n<script src="${jsHref}"></script>`);
  if (withScript === main) fail('no .kj root to hold the script');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${pageDescription.replaceAll('"', '&quot;')}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
${withScript}
</body>
</html>
`;
};

writeFileSync(outPath('index.html'), page(title, body));
writeFileSync(outPath('404.html'), page('Not found: Konjir', notFound));
mkdirSync(outPath('hands-on'), { recursive: true });
writeFileSync(outPath('hands-on/index.html'), page(`Hands-on: ${tutorial.title.text}: Konjir`, handsOn, tutorial.lead));
writeFileSync(outPath('robots.txt'), 'User-agent: *\nAllow: /\n');
copyFileSync(join(repo, 'brand', 'konjir-mark-tile.svg'), outPath('favicon.svg'));

// Hashed assets neither this build nor the one before uses go; licences and other files stay.
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const pruned = [];
for (const file of walk(outPath('assets'))) {
  const rel = relative(join(out, 'assets'), file);
  if (HASHED.test(rel) && !current.has(rel) && !previous.has(rel)) {
    rmSync(file);
    pruned.push(rel);
  }
}
const kept = [...previous].filter((p) => !current.has(p) && existsSync(join(out, 'assets', p)));

console.log(
  `site/: index.html, 404.html, hands-on/index.html, robots.txt, favicon.svg, ${classes.size} style classes, ${blobs.size} image(s); ` +
    `kept ${kept.length} previous asset(s), pruned ${pruned.length}`,
);
