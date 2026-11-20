#!/usr/bin/env node
// Builds site/ (https://www.konjir.com, D81) from its source in site/src/ (D92).
//
//   node deploy/site/build.mjs [<Main.dc.html> <images-dir>]
//
// The site is split by product (docs/plans/rebrand-and-site.md): each section's source is in
// site/src/<section>/, and its pages are under /<section>/ (PAGES below):
//
//   /                 site/src/www/main.html, the org page (its <main>, until it has an artboard)
//   /kolab/           site/src/kolab/project/Main.dc.html, the artboard (the "Konjir Marketing Page"
//                     artifact is published from site/src/kolab/), with the images it names as
//                     /_blob/<id> in site/src/kolab/images/<id>.<ext>
//   /kolab/how-it-works/  site/src/kolab/how-it-works.md, how Kolab works, for someone new to it
//   /kolab/hands-on/  site/src/kolab/hands-on.md, the hands-on tutorial
//   /konnect/         site/src/konnect/main.html, konnect's page (its <main>, until it has an artboard)
//   /konnect/guide/   site/src/konnect/guide.md, the messaging guide
//
// With arguments, the Kolab artboard and its images are read from there instead.
// It reads nothing from the network: the fonts are vendored in deploy/site/fonts/ (vendor-fonts.mjs).
// It writes only site/'s built files and never touches site/src/ or site/README.md. See site/README.md.
//
// The artboard runs on the artifact's Design Component runtime. The site can't, so this:
//  - drops the runtime (support.js) and its <x-dc>/<helmet> wrappers, and the artboard's own header:
//    every page gets the one header chrome.mjs writes (the Konjir mark, the product switcher, the
//    section's links, the theme switch, which deploy/site/site.js runs);
//  - serves the vendored fonts, checked against source.json, with each family's OFL licence;
//  - moves every inline style="" into a generated class, so the CSP needs no 'unsafe-inline';
//  - hashes asset names (site/assets/), so they can be cached for a year, and keeps the previous
//    build's hashed assets one more build, so a page still cached for a minute finds its CSS;
//  - writes 404.html in the same header, plus robots.txt, sitemap.xml, the favicon, and the Open
//    Graph image (site/src/<section>/og.jpg, or the org page's) as og/<section>.jpg;
//  - renders each article page with markdown.mjs into its section's header and footer, as
//    <path>/index.html, styled by article.css.
// Every page's <head> has its canonical URL on https://www.konjir.com and its Open Graph and Twitter tags.
// It refuses an artboard that uses anything else from the runtime, or anything the CSP would
// block (scripts, handlers, frames, javascript: URLs, other origins' resources), rather than guess.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { footer, header } from './chrome.mjs';
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

const fail = (msg) => {
  console.error(`build: ${msg}`);
  process.exit(1);
};

/** Where the site is served; konjir.com redirects here (deploy/terraform/modules/site). */
const ORIGIN = 'https://www.konjir.com';

// Each section: the links its pages' header carries (a page may give its own), whether it offers
// Kolab's sign-in, and the alt text of its Open Graph image, site/src/<section>/og.jpg, when it has one.
const SECTIONS = {
  www: {
    links: [],
    ogAlt: 'A field at first light: fog over the grass, power lines crossing toward an amber horizon.',
  },
  kolab: {
    links: [
      { href: '/kolab/', text: 'Overview' },
      { href: '/kolab/how-it-works/', text: 'How it works' },
      { href: '/kolab/hands-on/', text: 'Hands-on tutorial' },
    ],
    signIn: true,
  },
  konnect: {
    links: [
      { href: '/konnect/', text: 'Overview' },
      { href: '/konnect/guide/', text: 'Guide' },
    ],
    ogAlt: 'konnect: chat for your team’s people and their AI agents, from the command line. npm i -g @konjir/konnect',
  },
};

// The footer of a section without an artboard of its own (and of the 404 page).
const FOOTER_LINKS = [
  { href: '/kolab/', text: 'Kolab' },
  { href: '/kolab/how-it-works/', text: 'How Kolab works' },
  { href: '/kolab/hands-on/', text: 'Hands-on tutorial' },
  { href: '/konnect/', text: 'konnect' },
  { href: '/konnect/guide/', text: 'Messaging with konnect' },
];

// The pages, each at its path under ORIGIN, built from site/src/<source>:
//  - artboard: a claude.ai artboard, its images in site/src/<images>/
//  - main: the <main> of a page, written as an artboard's is, in the shared header and footer
//  - article: Markdown, rendered under its kicker, with a contents list of its "## " headings
// The first artboard is the design every page shares: its fonts, its stylesheet and its root.
const PAGES = [
  { path: '/', section: 'www', main: 'www/main.html', title: 'Konjir: tools for teams of people and their AI agents' },
  {
    path: '/kolab/',
    section: 'kolab',
    artboard: 'kolab/project/Main.dc.html',
    images: 'kolab/images',
    links: [
      { href: '/kolab/how-it-works/', text: 'How it works' },
      { href: '#circle', text: 'Roles' },
      { href: '#agents', text: 'For agents' },
      { href: '#kolabs', text: 'Kolabs' },
      { href: '/kolab/hands-on/', text: 'Try it hands-on', accent: true },
    ],
  },
  { path: '/kolab/how-it-works/', section: 'kolab', article: 'kolab/how-it-works.md', kicker: 'How it works', contents: 'Sections', what: 'how-it-works page' },
  { path: '/kolab/hands-on/', section: 'kolab', article: 'kolab/hands-on.md', kicker: 'Hands-on', contents: 'Steps', what: 'tutorial' },
  { path: '/konnect/', section: 'konnect', main: 'konnect/main.html', title: 'konnect: chat for your team’s people and their AI agents' },
  { path: '/konnect/guide/', section: 'konnect', article: 'konnect/guide.md', kicker: 'Guide', contents: 'Sections', what: 'guide' },
];
for (const p of PAGES) {
  if (!/^\/(?:[a-z0-9-]+\/)*$/.test(p.path)) fail(`a page path must be /, or /<folder>/…/: ${p.path}`);
  p.file = `${p.path.slice(1)}index.html`;
  p.url = ORIGIN + p.path;
  if (p.artboard && args.length) [p.artboardPath, p.imagesDir] = args.map((a) => resolve(a));
  else if (p.artboard) [p.artboardPath, p.imagesDir] = [join(sourceDir, p.artboard), join(sourceDir, p.images)];
  const source = p.artboardPath ?? join(sourceDir, p.main ?? p.article);
  if (!existsSync(source)) fail(`no ${p.what ?? 'page source'} at ${source}`);
}
const landing = (section) => PAGES.find((p) => p.section === section && p.artboard);
if (!PAGES.some((p) => p.artboard)) fail('no artboard to take the design from');

// The build writes only these in site/; site/src/ (the source) and site/README.md are never its.
const outputs = new Set(['404.html', 'robots.txt', 'sitemap.xml', 'favicon.svg', 'assets', 'og', ...PAGES.map((p) => p.file.split('/')[0])]);
const outPath = (rel) => {
  const parts = rel.split(/[\\/]/);
  if (isAbsolute(rel) || parts.includes('..') || parts[0] === 'src' || !outputs.has(parts[0])) fail(`refusing to write site/${rel}, which the build doesn't own`);
  return join(out, rel);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hash = (buf) => sha256(buf).slice(0, 10);
const HASHED = /\.[0-9a-f]{10}\.[a-z0-9]+$/;

// The previous build's hashed assets, kept one more build (see the header): the ones site/'s pages
// use at the merge base with origin/main, which is what main and so the last deploy serves, and at
// every commit since it up to HEAD. So a rebuild on a branch, even after the branch's own builds
// are committed, never drops what production serves, and rebuilding a committed build changes
// nothing. On main itself that is HEAD alone, so the builds before the last one are pruned there.
// Without an origin/main, HEAD alone; outside a git checkout, the ones site/ uses now. A page is
// any .html file in site/ outside site/src/, wherever it was then (the site was split by product).
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const builtPage = (rel) => rel.startsWith('site/') && !rel.startsWith('site/src/') && rel.endsWith('.html');
const revs = [];
if (git('rev-parse', '--verify', '-q', 'HEAD').status === 0) {
  revs.push('HEAD');
  const base = git('merge-base', 'HEAD', 'origin/main');
  if (base.status === 0) {
    const b = base.stdout.trim();
    revs.push(b, ...git('rev-list', `${b}..HEAD`, '--', 'site', ':(exclude)site/src').stdout.split('\n').filter(Boolean));
  }
}
const previous = new Set();
const refsInText = (text) => {
  for (const m of text.matchAll(/\/assets\/([^"')\s]+)/g)) previous.add(m[1]);
};
const refsIn = (rel) => {
  if (!revs.length) {
    if (existsSync(join(repo, rel))) refsInText(readFileSync(join(repo, rel), 'utf8'));
    return;
  }
  for (const rev of revs) {
    const r = git('show', `${rev}:${rel}`);
    if (r.status === 0) refsInText(r.stdout);
  }
};
const pagesThen = new Set();
if (revs.length) {
  for (const rev of revs) for (const f of git('ls-tree', '-r', '--name-only', rev, '--', 'site').stdout.split('\n')) if (builtPage(f)) pagesThen.add(f);
} else if (existsSync(out)) {
  for (const f of walk(out)) {
    const rel = relative(repo, f).split('\\').join('/');
    if (builtPage(rel)) pagesThen.add(rel);
  }
}
for (const p of pagesThen) refsIn(p);
for (const p of [...previous]) if (p.endsWith('.css')) refsIn(`site/assets/${p}`);

mkdirSync(outPath('assets/fonts'), { recursive: true });
const current = new Set();
const emit = (stem, ext, buf) => {
  const name = `${stem}.${hash(buf)}${ext}`;
  writeFileSync(outPath(`assets/${name}`), buf);
  current.add(name);
  return `/assets/${name}`;
};

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
const check = (html, where, verb = 'has') => {
  for (const [re, what] of refuse) {
    const m = re.exec(html);
    if (m) fail(`${where} ${verb} ${what}: ${html.slice(m.index, m.index + 80)}`);
  }
};
const descriptionOf = (main, where) =>
  /<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/
    .exec(main)?.[1]
    .replace(/<[^>]+>/g, '')
    .trim() ?? fail(`${where}: no lead paragraph after the <h1> for the description`);

// --- Artboards ---

// One artboard: its helmet (the font links and one <style>), and its body split into the root, the
// header (dropped for chrome.mjs's), the main and the footer.
let design = null;
let fontCss = '';
for (const p of PAGES.filter((q) => q.artboard)) {
  const where = relative(repo, p.artboardPath);
  const src = readFileSync(p.artboardPath, 'utf8');
  for (const tag of ['<sc-for', '<sc-if', '<dc-import', '<x-import']) {
    if (src.includes(tag)) fail(`${where} uses ${tag}>, which this converter doesn't render; extend it`);
  }
  const lang = /<html\s+lang="([^"]+)"/.exec(src)?.[1] ?? 'en';
  p.title = /<title>([\s\S]*?)<\/title>/.exec(src)?.[1].trim() ?? fail(`${where}: no <title>`);
  const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(src)?.[1] ?? fail(`${where}: no <helmet>`);
  const xdc = /<\/helmet>([\s\S]*?)<\/x-dc>/.exec(src)?.[1].trim() ?? fail(`${where}: no <x-dc> body`);

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
  if (rest) fail(`${where}: unexpected <helmet> content: ${rest.slice(0, 120)}`);
  if (/url\(|@import/i.test(baseCss)) fail(`${where}: the helmet <style> loads something (url() or @import); extend the converter`);

  // The root's theme hole defaults to dark, as renderVals() does; site.js takes it from there.
  const body = /^(<div class="kj"[^>]*>)\s*<header\b[\s\S]*?<\/header>\s*(<main>[\s\S]*<\/main>)\s*(<footer\b[\s\S]*<\/footer>)\s*<\/div>$/.exec(
    xdc.replace(/data-theme="\{\{\s*theme\s*\}\}"/g, 'data-theme="dark"'),
  ) ?? fail(`${where}: the body isn't one .kj root holding a <header>, a <main> and a <footer>`);
  const [, root, main, foot] = body;

  if (!design) {
    design = { lang, fontHrefs, baseCss, root };
  } else if (lang !== design.lang || baseCss !== design.baseCss || fontHrefs.join() !== design.fontHrefs.join() || root !== design.root) {
    fail(`${where}: its helmet or root differs from ${relative(repo, PAGES.find((q) => q.artboard).artboardPath)}'s; the site has one design`);
  }

  // Images the page names as /_blob/<id>, and links to this site made relative, so they work
  // wherever it is served (the artifact on claude.ai needs them absolute).
  const assetFiles = existsSync(p.imagesDir) ? readdirSync(p.imagesDir) : [];
  const blobs = new Map();
  const site = (html) =>
    html
      .replace(/\/_blob\/([0-9a-f]{32})/g, (_, id) => {
        if (!blobs.has(id)) {
          const file = assetFiles.find((f) => f.startsWith(`${id}.`)) ?? fail(`no file for /_blob/${id} in ${p.imagesDir}`);
          blobs.set(id, emit('img', extname(file).toLowerCase(), readFileSync(join(p.imagesDir, file))));
        }
        return blobs.get(id);
      })
      .replaceAll(`href="${ORIGIN}/`, 'href="/');
  p.mainHtml = site(main);
  p.footer = site(foot);
  p.imageCount = blobs.size;
  p.description = descriptionOf(p.mainHtml, where);
}

// Fonts: the vendored copy, which must be the one the artboard links, byte for byte.
if (design.fontHrefs.length) {
  const manifest = JSON.parse(readFileSync(join(fontsDir, 'source.json'), 'utf8'));
  for (const href of design.fontHrefs) {
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

// --- Every page: the shared header, its main, its section's footer ---

// A section with an artboard ends its pages with that artboard's footer, whose in-page links point
// at the artboard's page from anywhere else; any other section, and the 404 page, with chrome.mjs's.
const footerFor = (p) => {
  const home = landing(p.section);
  if (!home) return footer(FOOTER_LINKS);
  if (home === p) return p.footer;
  return home.footer.replace(/href="#top"/g, `href="${home.path}"`).replace(/href="#/g, `href="${home.path}#`);
};
const assemble = (p, main) =>
  `${design.root}\n${header({ section: p.section, path: p.path, links: p.links ?? SECTIONS[p.section].links, signIn: SECTIONS[p.section].signIn })}\n\n${main}\n\n${footerFor(p)}\n</div>`;

for (const p of PAGES) {
  if (p.main) {
    const main = readFileSync(join(sourceDir, p.main), 'utf8').trim();
    if (!/^<main>[\s\S]*<\/main>$/.test(main) || main.indexOf('<main') !== main.lastIndexOf('<main')) fail(`site/src/${p.main} must be one <main>…</main>`);
    p.mainHtml = main;
    p.description = descriptionOf(main, `site/src/${p.main}`);
  } else if (p.article) {
    const rendered = render(readFileSync(join(sourceDir, p.article), 'utf8'), (m) => fail(`site/src/${p.article}: ${m}`));
    const toc = `<nav class="toc" aria-label="${p.contents}"><p>On this page</p><ol>${rendered.toc.map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join('')}</ol></nav>`;
    const firstH2 = rendered.html.indexOf('<h2 ');
    p.mainHtml = `<main>
<article class="ho" aria-labelledby="ho-title">
<header><p class="kicker">${p.kicker}</p><h1 id="ho-title">${rendered.title.html}</h1></header>
${firstH2 < 0 ? rendered.html : `${rendered.html.slice(0, firstH2)}${toc}\n${rendered.html.slice(firstH2)}`}
</article>
</main>`;
    p.title ??= `${p.kicker}: ${rendered.title.text}: Konjir`;
    p.description = rendered.lead;
  }
  check(p.mainHtml, p.artboard ? relative(repo, p.artboardPath) : `site/src/${p.main ?? p.article}`);
  p.html = assemble(p, p.mainHtml);
  check(p.html, `site/${p.file}`);
}

// The 404 page: the org page's header and the shared footer, around its own main.
const www = PAGES.find((p) => p.path === '/') ?? fail('no page at /');
const notFound = {
  section: 'www',
  path: null,
  file: '404.html',
  title: 'Not found: Konjir',
  description: www.description,
  html: `${design.root}\n${header({ section: 'www', path: null, links: [], signIn: false })}\n\n${readFileSync(join(here, '404-main.html'), 'utf8').trim()}\n\n${footer(FOOTER_LINKS)}\n</div>`,
};
check(notFound.html, 'site/404.html');

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
for (const p of [...PAGES, notFound]) {
  p.html = unstyle(p.html);
  if (/\sstyle\s*=/i.test(p.html)) fail(`an inline style survived in site/${p.file}`);
}

const articleCss = readFileSync(join(here, 'article.css'), 'utf8').trim();
if (/url\(|@import/i.test(articleCss)) fail('article.css loads something (url() or @import)');
const css = [
  '/* Generated by deploy/site/build.mjs from site/src/. Do not edit. */',
  '/* Fonts: Fraunces, Instrument Sans and JetBrains Mono, SIL Open Font License 1.1: /assets/fonts/*-OFL.txt */',
  fontCss.trim(),
  design.baseCss,
  ...[...classes].map(([decl, cls]) => `.kj .${cls},.kj.${cls}{${decl}}`),
  articleCss,
].join('\n');
const cssHref = emit('site', '.css', Buffer.from(css + '\n'));
const jsHref = emit('site', '.js', readFileSync(join(here, 'site.js')));

// The Open Graph image of each section: its own site/src/<section>/og.jpg, else the org page's.
const ogImages = new Map();
const ogImage = (section) => {
  const from = existsSync(join(sourceDir, section, 'og.jpg')) ? section : 'www';
  if (!ogImages.has(from)) {
    const src = join(sourceDir, from, 'og.jpg');
    if (!existsSync(src)) fail(`no Open Graph image at ${src}`);
    const alt = SECTIONS[from]?.ogAlt ?? fail(`site/src/${from}/og.jpg has no ogAlt in SECTIONS`);
    ogImages.set(from, { src, file: `og/${from}.jpg`, url: `${ORIGIN}/og/${from}.jpg`, alt });
  }
  return ogImages.get(from);
};

const attr = (s) => s.replaceAll('"', '&quot;');
const page = (p) => {
  // site.js goes first inside the .kj root, so the stored theme applies before anything paints.
  const withScript = p.html.replace(/(<div class="kj[^"]*"[^>]*>)/, `$1\n<script src="${jsHref}"></script>`);
  if (withScript === p.html) fail('no .kj root to hold the script');
  const title = p.title;
  const description = attr(p.description);
  let seo;
  if (p.url) {
    const og = ogImage(p.section);
    seo = `<link rel="canonical" href="${p.url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Konjir">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${p.url}">
<meta property="og:image" content="${og.url}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${attr(og.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(title)}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${og.url}">`;
  } else {
    seo = '<meta name="robots" content="noindex">';
  }
  return `<!doctype html>
<html lang="${design.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
${seo}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
${withScript}
</body>
</html>
`;
};

// Every finished page is checked whole before it is written: its head must be exactly the one
// page() writes, its title, description and Open Graph texts holding no markup and its URLs this
// site's, and its body, but for the one site.js tag, must pass the same refusals as the artboard.
// So nothing a source holds (a title, a description, a heading) can add a tag anywhere in the page.
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEXT = '[^<>"]*';
const URL_RE = `${re(ORIGIN)}/(?:[a-z0-9-]+/)*`;
const IMAGE_RE = `${re(ORIGIN)}/og/[a-z0-9-]+\\.jpg`;
const SEO_RE = [
  `<link rel="canonical" href="(${URL_RE})">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="Konjir">',
  `<meta property="og:title" content="${TEXT}">`,
  `<meta property="og:description" content="${TEXT}">`,
  '<meta property="og:url" content="\\1">',
  `<meta property="og:image" content="(${IMAGE_RE})">`,
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  `<meta property="og:image:alt" content="${TEXT}">`,
  '<meta name="twitter:card" content="summary_large_image">',
  `<meta name="twitter:title" content="${TEXT}">`,
  `<meta name="twitter:description" content="${TEXT}">`,
  '<meta name="twitter:image" content="\\2">',
].join('\\n');
const headRe = new RegExp(
  `^<!doctype html>\\n<html lang="[a-zA-Z-]+">\\n<head>\\n<meta charset="utf-8">\\n<meta name="viewport" content="width=device-width, initial-scale=1">\\n<title>[^<>]*</title>\\n<meta name="description" content="${TEXT}">\\n(?:${SEO_RE}|<meta name="robots" content="noindex">)\\n<link rel="icon" href="/favicon.svg" type="image/svg\\+xml">\\n<link rel="stylesheet" href="${re(cssHref)}">\\n</head>\\n<body>\\n`,
);
const finished = (rel, html) => {
  const head = headRe.exec(html) ?? fail(`site/${rel} would have a <head> other than the one the build writes: ${html.slice(0, 600)}`);
  const script = `<script src="${jsHref}"></script>`;
  const rest = html.slice(head[0].length);
  if (rest.split(script).length !== 2) fail(`site/${rel} would hold site.js other than once`);
  const inBody = rest.replace(script, '').replace(/\n<\/body>\n<\/html>\n$/, '');
  if (/<\/?(html|head|body|title)\b/i.test(inBody)) fail(`site/${rel} would have a second <html>, <head>, <body> or <title>`);
  check(inBody, `site/${rel}`, 'would have');
  mkdirSync(dirname(outPath(rel)), { recursive: true });
  writeFileSync(outPath(rel), html);
};

for (const p of PAGES) finished(p.file, page(p));
finished('404.html', page(notFound));
mkdirSync(outPath('og'), { recursive: true });
for (const og of ogImages.values()) copyFileSync(og.src, outPath(og.file));
writeFileSync(outPath('robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
writeFileSync(
  outPath('sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map((p) => `<url><loc>${p.url}</loc></url>\n`).join('')}</urlset>\n`,
);
copyFileSync(join(repo, 'brand', 'konjir-mark-tile.svg'), outPath('favicon.svg'));

// Open Graph images and hashed assets neither this build nor the one before uses go; licences and
// other files stay.
for (const file of existsSync(outPath('og')) ? readdirSync(outPath('og')) : []) {
  if (![...ogImages.values()].some((og) => og.file === `og/${file}`)) rmSync(outPath(`og/${file}`));
}
const pruned = [];
for (const file of walk(outPath('assets'))) {
  const rel = relative(join(out, 'assets'), file).split('\\').join('/');
  if (HASHED.test(rel) && !current.has(rel) && !previous.has(rel)) {
    rmSync(file);
    pruned.push(rel);
  }
}
const kept = [...previous].filter((p) => !current.has(p) && existsSync(join(out, 'assets', p)));

console.log(
  `site/: ${[...PAGES.map((p) => p.file), '404.html'].join(', ')}, robots.txt, sitemap.xml, favicon.svg, ${ogImages.size} Open Graph image(s), ` +
    `${classes.size} style classes, ${PAGES.reduce((n, p) => n + (p.imageCount ?? 0), 0)} image(s); kept ${kept.length} previous asset(s), pruned ${pruned.length}`,
);
