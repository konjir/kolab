#!/usr/bin/env node
// Runs the pinned eas-cli (this app's devDependency) with the arguments given, once the app is
// linked to its EAS project. Until then it says so and stops, before eas-cli can offer to create
// or link a project under whichever Expo account happens to be signed in on this machine.
//
//   node scripts/eas.mjs build --profile preview [--platform ios] ...
//
// Linked means app.config.ts names the EAS project (EAS_PROJECT_ID, read here from the resolved
// config as extra.eas.projectId) and its owner. `eas whoami` needs no project, so it always runs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const NEEDS_NO_PROJECT = new Set(['whoami']);

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', ...opts });

// An update is built from app.config.ts as APP_VARIANT says, and eas update never applies
// eas.json's profile env: an update for a channel must be built as that channel's variant, or it
// targets a runtime no binary of the channel has (with the dev variant's scheme and Kolab URL).
export const VARIANT_OF_CHANNEL = { development: 'development', preview: 'preview', production: 'production' };
if (args[0] === 'update') {
  // One channel, named once: a second --channel (the target's, then one added after `--`) would
  // leave eas-cli to pick between them, and the check below to look at only one.
  const named = args.filter((a) => a === '--channel' || a.startsWith('--channel='));
  if (named.length > 1) { console.error('eas update: name one channel, once; this asks for --channel more than once. Nothing was sent to EAS.'); process.exit(2); }
  const at = args.indexOf('--channel');
  const channel = at >= 0 ? args[at + 1] : named[0]?.slice('--channel='.length);
  const want = VARIANT_OF_CHANNEL[channel];
  if (!want) { console.error(`eas update: name the channel, --channel ${Object.keys(VARIANT_OF_CHANNEL).join('|')}`); process.exit(2); }
  if (process.env.APP_VARIANT !== want) {
    console.error(`eas update --channel ${channel}: APP_VARIANT is ${JSON.stringify(process.env.APP_VARIANT ?? null)}; an update for ${channel} must be built with APP_VARIANT=${want}. Nothing was sent to EAS.`);
    process.exit(2);
  }
  // Updates are signed (expo-updates code signing): the certificate is in the app, the private key
  // only in a secret (KONNECT_UPDATES_PRIVATE_KEY_PATH, a file).
  const key = process.env.KONNECT_UPDATES_PRIVATE_KEY_PATH;
  if (!key || !existsSync(key)) { console.error('eas update: KONNECT_UPDATES_PRIVATE_KEY_PATH names no file; updates are signed, and a build only applies a signed one. Nothing was sent to EAS.'); process.exit(2); }
  args.push('--private-key-path', key);
}

if (!NEEDS_NO_PROJECT.has(args[0])) {
  const config = spawnSync('npx', ['expo', 'config', '--json', '--type', 'public'], { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  if (config.status !== 0) {
    process.stderr.write(config.stderr);
    console.error('eas: could not read app.config.ts (npx expo config failed), so nothing was sent to EAS');
    process.exit(config.status || 1);
  }
  const exp = JSON.parse(config.stdout);
  if (!exp.extra?.eas?.projectId || !exp.owner) {
    console.error([
      `eas ${args.join(' ')}: not linked. konnect has no EAS project yet: app.config.ts sets neither EAS_PROJECT_ID nor EAS_OWNER.`,
      'Nothing was sent to EAS. Linking is Lee\'s, once the Expo organization konjir exists: see "Linking EAS" in apps/konnect-mobile/README.md.',
    ].join('\n'));
    process.exit(1);
  }
}

// Submitting needs the store accounts' details, which eas.json holds as placeholders until Lee fills them.
if ((args[0] === 'submit' || args.includes('--auto-submit')) && readFileSync(join(root, 'eas.json'), 'utf8').includes('REPLACE_WITH_')) {
  console.error(`eas ${args.join(' ')}: eas.json's submit.production still has placeholders (REPLACE_WITH_…): the App Store Connect app's ID and the Play service account key. Nothing was sent to EAS.`);
  process.exit(1);
}

const eas = run('npx', ['eas', ...args]);
process.exit(eas.status ?? 1);
