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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const NEEDS_NO_PROJECT = new Set(['whoami']);

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', ...opts });

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
