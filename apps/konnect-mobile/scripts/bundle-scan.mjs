#!/usr/bin/env node
// `bundle-scan`, after `expo export`: fails if anything in the exported app looks like a token or a
// secret. What ships in an app can be read by anyone who has it, so it holds public config only
// (app.config.ts extra: the variant and Kolab's URL); every credential reaches the phone at run
// time, through sign-in, into the secure store.
//
//   node scripts/bundle-scan.mjs <export folder>
//
// It reads every file but images, fonts and other media, as bytes: the iOS and Android bundles are
// Hermes bytecode, whose string table keeps ASCII strings as they are. It prints each finding's
// file, kind and offset, never the match itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const PATTERNS = [
  // Kolab's own: session and access tokens, refresh tokens, invitation secrets, authorization codes.
  ['a Kolab token', /\bkj(?:s|r|i|c)_[A-Za-z0-9_-]{24,}/g],
  ['a Kolab OAuth client ID', /\bkjcl_[A-Za-z0-9_-]{20,}/g],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['an AWS access key ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['a Stripe secret key', /\b[rs]k_live_[A-Za-z0-9]{20,}/g],
  ['an Anthropic or OpenAI API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/g],
  // A PEM key itself, not the bare header a PEM parser (jose's, in the MCP client) looks for.
  ['a private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}/g],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['a bearer credential', /\bBearer [A-Za-z0-9._~+/-]{24,}=*/g],
  ['an Expo access token', /\bEXPO_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/g],
];
const SKIP = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ttf', '.otf', '.woff', '.woff2', '.mp4', '.mp3', '.wav']);

const dir = process.argv[2];
if (!dir) { console.error('usage: bundle-scan.mjs <export folder>'); process.exit(2); }

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(dir);

const findings = [];
let scanned = 0;
for (const file of files) {
  if (SKIP.has(extname(file).toLowerCase())) continue;
  scanned++;
  const text = readFileSync(file).toString('latin1');
  for (const [kind, re] of PATTERNS) for (const m of text.matchAll(re)) findings.push({ file: relative(dir, file), kind, at: m.index });
}

const bundles = files.filter((f) => /\.(hbc|js)$/.test(f)).length;
if (bundles === 0) { console.error(`bundle-scan: no bundle in ${dir}; run expo export first`); process.exit(1); }
if (findings.length) {
  for (const f of findings) console.error(`bundle-scan: ${f.file} at byte ${f.at}: ${f.kind}`);
  console.error(`bundle-scan: ${findings.length} finding(s) in ${scanned} files. Nothing secret may ship in the app: move it to run time, or out.`);
  process.exit(1);
}
console.log(`bundle-scan: ${scanned} files (${bundles} bundles) in ${dir}: nothing that looks like a token or a secret`);
