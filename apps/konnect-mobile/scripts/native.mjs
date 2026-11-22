#!/usr/bin/env node
// Which native binaries exist, by fingerprint: the gate that decides, on each merge, between an
// over-the-air update (free) and a new binary (a local build on a GitHub runner, then submit).
//
//   node scripts/native.mjs check --profile preview [--platform ios|android] [--github-output]
//   node scripts/native.mjs tag   --profile preview --platform ios
//
// A binary built for a fingerprint is recorded as the git tag
// konnect-native/<profile>/<platform>/<fingerprint>, pushed by the workflow that built it. EAS
// records only the builds it runs: `eas build --local` leaves nothing in `eas build:list`, and
// `eas fingerprint:compare` compares against those records, so neither knows a local build.
// `check` reads the tags from the remote (git ls-remote), so it needs no fetch of tags.
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verb = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const profile = opt('profile');
const VARIANT = { preview: 'preview', production: 'production', development: 'development' };
if (!['check', 'tag'].includes(verb) || !profile || !VARIANT[profile]) {
  console.error('usage: native.mjs check|tag --profile preview|production|development [--platform ios|android] [--github-output]');
  process.exit(2);
}
const platforms = opt('platform') ? [opt('platform')] : ['ios', 'android'];

const fingerprint = (platform) => {
  const r = spawnSync('node', ['scripts/fingerprint.mjs', '--platform', platform], { cwd: root, encoding: 'utf8', env: { ...process.env, APP_VARIANT: VARIANT[profile] } });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status || 1); }
  return JSON.parse(r.stdout)[platform];
};
const tagOf = (platform, hash) => `konnect-native/${profile}/${platform}/${hash}`;
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });

if (verb === 'check') {
  const listed = git('ls-remote', '--tags', 'origin', `refs/tags/konnect-native/${profile}/*`);
  if (listed.status !== 0) { process.stderr.write(listed.stderr); process.exit(listed.status || 1); }
  const tags = new Set(listed.stdout.split('\n').map((l) => l.split('\t')[1]?.replace('refs/tags/', '')).filter(Boolean));
  const out = {};
  for (const platform of platforms) {
    const hash = fingerprint(platform);
    out[platform] = { fingerprint: hash, built: tags.has(tagOf(platform, hash)) };
    if (args.includes('--github-output') && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${platform}_fingerprint=${hash}\n${platform}_build=${!out[platform].built}\n`);
    }
  }
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const platform of platforms) {
    const tag = tagOf(platform, fingerprint(platform));
    for (const step of [['tag', '-f', tag], ['push', '-f', 'origin', `refs/tags/${tag}`]]) {
      const r = git(...step);
      if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status || 1); }
    }
    console.log(`recorded ${tag}`);
  }
}
