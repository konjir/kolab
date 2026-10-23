#!/usr/bin/env node
// Vendors the fonts the marketing page links into deploy/site/fonts/, so building site/ never
// fetches anything (from-artifact.mjs reads only these files).
//
//   node deploy/site/vendor-fonts.mjs '<the artboard's fonts.googleapis.com/css2 href>'
//
// Run it only when the artifact's font link changes; from-artifact.mjs refuses an artboard whose
// link doesn't match source.json. It writes:
//  - <family>-<subset>.woff2: the latin and latin-ext files Google serves a current Chrome
//  - fonts.css: their @font-face rules, pointing at those files
//  - <family>-OFL.txt: each family's SIL Open Font License, from github.com/google/fonts, which
//    OFL-1.1 condition 2 requires to travel with every copy
//  - source.json: the href, and each file's sha256, which from-artifact.mjs checks
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fonts');
const href = process.argv[2];
if (!href || !href.startsWith('https://fonts.googleapis.com/css2?')) {
  console.error("usage: node deploy/site/vendor-fonts.mjs 'https://fonts.googleapis.com/css2?…'");
  process.exit(2);
}
const fail = (msg) => {
  console.error(`vendor-fonts: ${msg}`);
  process.exit(1);
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KEEP = new Set(['latin', 'latin-ext']);
const get = async (url, headers = {}) => {
  const r = await fetch(url, { headers });
  if (!r.ok) fail(`${r.status} from ${url}`);
  return Buffer.from(await r.arrayBuffer());
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const css = (await get(href, { 'user-agent': UA })).toString('utf8');
const files = {};
const byUrl = new Map();
const families = new Set();
let out = '';
for (const m of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[\s\S]*?\})/g)) {
  const [, subset, face] = m;
  if (!KEEP.has(subset)) continue;
  const family = /font-family:\s*'([^']+)'/.exec(face)?.[1] ?? fail('a face with no family');
  const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(face)?.[1] ?? fail(`no woff2 for ${family}`);
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  families.add(family);
  if (!byUrl.has(url)) {
    const name = `${slug}-${subset}.woff2`;
    const buf = await get(url);
    byUrl.set(url, name);
    files[name] = { buf, sha256: sha(buf) };
  }
  out += `/* ${subset} */\n${face.replace(url, byUrl.get(url))}\n`;
}
if (!out) fail('kept no faces');

for (const family of families) {
  const repoDir = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  const buf = await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${repoDir}/OFL.txt`);
  if (!/SIL OPEN FONT LICENSE/i.test(buf.toString('utf8'))) fail(`${family}'s OFL.txt isn't the OFL`);
  files[`${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-OFL.txt`] = { buf, sha256: sha(buf) };
}
files['fonts.css'] = { buf: Buffer.from(out), sha256: sha(Buffer.from(out)) };

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [name, { buf }] of Object.entries(files)) writeFileSync(join(dir, name), buf);
const manifest = { href, files: Object.fromEntries(Object.entries(files).map(([n, f]) => [n, f.sha256]).sort()) };
writeFileSync(join(dir, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`deploy/site/fonts/: ${readdirSync(dir).length} files for ${[...families].join(', ')}`);
