#!/usr/bin/env node
// `doctor`: expo-doctor, passing when every check passes but the one this project fails on purpose.
//
// The plan pins eas-cli as a devDependency (docs/plans/konnect-mobile.md, Nx targets), so every
// EAS target runs the same, locked version through npx, never a global install. expo-doctor's
// "legacy global CLI installed locally" check flags exactly that, and has no setting to skip it, so
// that check, failing for eas-cli alone, is accepted here. Any other failure fails the target.
import { spawnSync } from 'node:child_process';

const ACCEPTED = 'Check for legacy global CLI installed locally';

const run = spawnSync('npx', ['expo-doctor', ...process.argv.slice(2)], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
process.stdout.write(out);
if (run.error) throw run.error;
if (run.status === 0) process.exit(0);

// Each failed check is a "✖ <title>" line, then its explanation up to the next blank line.
const failed = [...out.matchAll(/^✖ (.+)\n([\s\S]*?)(?:\n\n|$)/gm)].map(([, title, body]) => ({ title: title.trim(), body }));
const other = failed.filter((f) => !(f.title === ACCEPTED && /EAS CLI should not be installed/.test(f.body) && !/Expo CLI is now part/.test(f.body)));
if (failed.length > 0 && other.length === 0) {
  console.log(`\ndoctor: accepted "${ACCEPTED}" (eas-cli is a pinned devDependency on purpose; see scripts/doctor.mjs). Every other check passed.`);
  process.exit(0);
}
console.error(`\ndoctor: ${other.length ? other.map((f) => f.title).join('; ') : 'expo-doctor failed'}`);
process.exit(run.status || 1);
