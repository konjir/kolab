#!/usr/bin/env node
// Builds site/ (konjir.com, D81) from the "Konjir Marketing Page" artifact's artboard.
//
//   node deploy/site/from-artifact.mjs <Main.dc.html> <assets-dir>
//
// <Main.dc.html> is the artifact's project/Main.dc.html; <assets-dir> holds each image the page
// names as /_blob/<id>, saved as <id>.<ext> (the Artifact tool's read with path=<id> saves it so).
// It reads nothing from the network: the fonts are vendored in deploy/site/fonts/ (vendor-fonts.mjs).
// See site/README.md.
//
// The artboard runs on the artifact's Design Component runtime. The site can't, so this:
//  - drops the runtime (support.js) and its <x-dc>/<helmet> wrappers;
//  - replaces the component logic (theme state and the theme radio group) with deploy/site/site.js;
//  - serves the vendored fonts, checked against source.json, with each family's OFL licence;
//  - moves every inline style="" into a generated class, so the CSP needs no 'unsafe-inline';
//  - hashes asset names (site/assets/), so they can be cached for a year, and keeps the previous
//    build's hashed assets one more build, so a page still cached for a minute finds its CSS;
//  - writes 404.html from the same header and footer, plus robots.txt and the favicon.
// It refuses an artboard that uses anything else from the runtime, or anything the CSP would
// block (scripts, handlers, frames, javascript: URLs, other origins' resources), rather than guess.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = join(repo, 'site');
const fontsDir = join(here, 'fonts');
const [srcPath, assetsDir] = process.argv.slice(2);
if (!srcPath || !assetsDir) {
  console.error('usage: node deploy/site/from-artifact.mjs <Main.dc.html> <assets-dir>');
  process.exit(2);
}

const fail = (msg) => {
  console.error(`from-artifact: ${msg}`);
  process.exit(1);
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

// The previous build's hashed assets, kept one more build (see the header): the ones site/ uses at
// HEAD, the last commit, so rebuilding before a commit never drops what the last deploy serves.
// Outside a git checkout, the ones site/ uses now.
const previous = new Set();
const committed = (rel) => {
  const r = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: repo, encoding: 'utf8' });
  if (r.status === 0) return r.stdout;
  const inGit = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repo }).status === 0;
  return inGit ? null : existsSync(join(repo, rel)) ? readFileSync(join(repo, rel), 'utf8') : null;
};
const refsIn = (rel) => {
  const text = committed(rel);
  if (text) for (const m of text.matchAll(/\/assets\/([^"')\s]+)/g)) previous.add(m[1]);
};
refsIn('site/index.html');
refsIn('site/404.html');
for (const p of [...previous]) if (p.endsWith('.css')) refsIn(`site/assets/${p}`);

mkdirSync(join(out, 'assets', 'fonts'), { recursive: true });
const current = new Set();
const emit = (stem, ext, buf) => {
  const name = `${stem}.${hash(buf)}${ext}`;
  writeFileSync(join(out, 'assets', name), buf);
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
    writeFileSync(join(out, 'assets', 'fonts', name), vendored[name]);
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
if (/\sstyle\s*=/i.test(body + notFound)) fail('an inline style survived');

const css = [
  '/* Generated by deploy/site/from-artifact.mjs from the Konjir Marketing Page artifact. Do not edit. */',
  '/* Fonts: Fraunces, Instrument Sans and JetBrains Mono, SIL Open Font License 1.1: /assets/fonts/*-OFL.txt */',
  fontCss.trim(),
  baseCss,
  ...[...classes].map(([decl, cls]) => `.kj .${cls},.kj.${cls}{${decl}}`),
].join('\n');
const cssHref = emit('site', '.css', Buffer.from(css + '\n'));
const jsHref = emit('site', '.js', readFileSync(join(here, 'site.js')));

const description =
  /<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/
    .exec(body)?.[1]
    .replace(/<[^>]+>/g, '')
    .trim() ?? fail('no lead paragraph after the <h1> for the description');

const page = (pageTitle, main) => {
  // site.js goes first inside the .kj root, so the stored theme applies before anything paints.
  const withScript = main.replace(/(<div class="kj[^"]*"[^>]*>)/, `$1\n<script src="${jsHref}"></script>`);
  if (withScript === main) fail('no .kj root to hold the script');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<meta name="description" content="${description.replaceAll('"', '&quot;')}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
${withScript}
</body>
</html>
`;
};

writeFileSync(join(out, 'index.html'), page(title, body));
writeFileSync(join(out, '404.html'), page('Not found: Konjir', notFound));
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
copyFileSync(join(repo, 'brand', 'konjir-mark-tile.svg'), join(out, 'favicon.svg'));

// Hashed assets neither this build nor the one before uses go; licences and other files stay.
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const pruned = [];
for (const file of walk(join(out, 'assets'))) {
  const rel = relative(join(out, 'assets'), file);
  if (HASHED.test(rel) && !current.has(rel) && !previous.has(rel)) {
    rmSync(file);
    pruned.push(rel);
  }
}
const kept = [...previous].filter((p) => !current.has(p) && existsSync(join(out, 'assets', p)));

console.log(
  `site/: index.html, 404.html, robots.txt, favicon.svg, ${classes.size} style classes, ${blobs.size} image(s); ` +
    `kept ${kept.length} previous asset(s), pruned ${pruned.length}`,
);
