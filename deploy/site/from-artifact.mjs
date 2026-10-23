#!/usr/bin/env node
// Builds site/ (konjir.com, D81) from the "Konjir Marketing Page" artifact's artboard.
//
//   node deploy/site/from-artifact.mjs <Main.dc.html> <assets-dir>
//
// <Main.dc.html> is the artifact's project/Main.dc.html; <assets-dir> holds each image the page
// names as /_blob/<id>, saved as <id>.<ext> (the Artifact tool's read with path=<id> saves it so).
// See site/README.md.
//
// The artboard runs on the artifact's Design Component runtime. The site can't, so this:
//  - drops the runtime (support.js) and its <x-dc>/<helmet> wrappers;
//  - replaces the component logic (theme state and the theme radio group) with deploy/site/site.js;
//  - self-hosts the Google Fonts the helmet links (latin and latin-ext subsets);
//  - moves every inline style="" into a generated class, so the CSP needs no 'unsafe-inline';
//  - hashes asset names (site/assets/), so they can be cached for a year;
//  - writes 404.html from the same header and footer, plus robots.txt and the favicon.
// It refuses an artboard that uses anything else from the runtime, rather than guess.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = join(repo, 'site');
const [srcPath, assetsDir] = process.argv.slice(2);
if (!srcPath || !assetsDir) {
  console.error('usage: node deploy/site/from-artifact.mjs <Main.dc.html> <assets-dir>');
  process.exit(2);
}

const fail = (msg) => {
  console.error(`from-artifact: ${msg}`);
  process.exit(1);
};
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

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

// Fresh output: generated files are replaced wholesale; README.md stays.
rmSync(join(out, 'assets'), { recursive: true, force: true });
mkdirSync(join(out, 'assets', 'fonts'), { recursive: true });

const emit = (stem, ext, buf) => {
  const name = `${stem}.${hash(buf)}${ext}`;
  writeFileSync(join(out, 'assets', name), buf);
  return `/assets/${name}`;
};

// Fonts: fetch the css2 stylesheet as a current Chrome would, keep the latin subsets, host the files.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KEEP = new Set(['latin', 'latin-ext']);
let fontCss = '';
const fetched = new Map();
for (const href of fontHrefs) {
  const res = await fetch(href, { headers: { 'user-agent': UA } });
  if (!res.ok) fail(`fonts: ${res.status} from ${href}`);
  const css = await res.text();
  for (const m of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[\s\S]*?\})/g)) {
    const [, subset, face] = m;
    if (!KEEP.has(subset)) continue;
    const family = /font-family:\s*'([^']+)'/.exec(face)?.[1] ?? fail('fonts: a face with no family');
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(face)?.[1] ?? fail(`fonts: no woff2 for ${family}`);
    if (!fetched.has(url)) {
      const r = await fetch(url);
      if (!r.ok) fail(`fonts: ${r.status} from ${url}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const name = `fonts/${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${subset}.${hash(buf)}.woff2`;
      writeFileSync(join(out, 'assets', name), buf);
      fetched.set(url, `/assets/${name}`);
    }
    fontCss += face.replace(url, fetched.get(url)) + '\n';
  }
}
if (fontHrefs.length && !fontCss) fail('fonts: kept no faces');

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
const hole = /\{\{[^}]*\}\}|\son[A-Z]\w*="/.exec(body);
if (hole) fail(`unhandled template hole or handler: ${body.slice(hole.index, hole.index + 60)}`);

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
    if (!classes.has(decl)) classes.set(decl, `s${classes.size + 1}`);
    const cls = classes.get(decl);
    let a = attrs.replace(m[0], '');
    a = /\sclass="/.test(a) ? a.replace(/\sclass="([^"]*)"/, (_, c) => ` class="${c} ${cls}"`) : `${a} class="${cls}"`;
    return `<${name}${a}${slash}>`;
  });
body = unstyle(body);
notFound = unstyle(notFound);
if (/\sstyle="/.test(body + notFound)) fail('an inline style survived');

const css = [
  '/* Generated by deploy/site/from-artifact.mjs from the Konjir Marketing Page artifact. Do not edit. */',
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

console.log(
  `site/: index.html, 404.html, robots.txt, favicon.svg, ${classes.size} style classes, ${fetched.size} font files, ${blobs.size} image(s)`,
);
