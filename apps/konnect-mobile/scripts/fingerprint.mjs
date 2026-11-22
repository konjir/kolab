#!/usr/bin/env node
// `fingerprint`: the native fingerprint of each platform (expo-updates fingerprint:generate), the
// runtime version an update must match (app.config.ts, runtimeVersion's fingerprint policy).
//
//   node scripts/fingerprint.mjs                     {"ios":"<hash>","android":"<hash>"}
//   node scripts/fingerprint.mjs --platform ios      {"ios":"<hash>"}
//   node scripts/fingerprint.mjs --sources           each platform's full fingerprint, with its sources
//
// APP_VARIANT is part of the config, so each variant has its own fingerprint.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = args.findIndex((a) => a === '--platform' || a.startsWith('--platform='));
const named = at < 0 ? undefined : args[at].includes('=') ? args[at].split('=')[1] : args[at + 1];
const platforms = named ? [named] : ['ios', 'android'];
const sources = args.includes('--sources');

const result = {};
for (const platform of platforms) {
  const r = spawnSync('npx', ['expo-updates', 'fingerprint:generate', '--platform', platform], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status || 1); }
  const fingerprint = JSON.parse(r.stdout);
  result[platform] = sources ? fingerprint : fingerprint.hash;
}
console.log(JSON.stringify(result, null, sources ? 2 : 0));
