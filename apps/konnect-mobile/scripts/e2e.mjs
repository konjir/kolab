#!/usr/bin/env node
// `e2e`: the Maestro flows in .maestro/, against konnect installed on a booted simulator or emulator
// (a dev build with `start` running, or a preview build). APP_VARIANT picks the app, as in
// app.config.ts: development by default. Arguments go on to `maestro test`.
//
// Maestro is installed apart from npm (https://maestro.dev), so this says so when it is missing.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_IDS = { development: 'com.konjir.konnect.dev', preview: 'com.konjir.konnect.preview', production: 'com.konjir.konnect' };
const variant = process.env.APP_VARIANT ?? 'development';
const appId = APP_IDS[variant];
if (!appId) { console.error(`e2e: APP_VARIANT is ${JSON.stringify(variant)}; it must be one of ${Object.keys(APP_IDS).join(', ')}`); process.exit(2); }

if (spawnSync('maestro', ['--version'], { stdio: 'ignore' }).error) {
  console.error('e2e: Maestro isn\'t installed, so no flow ran. Install it (curl -fsSL "https://get.maestro.mobile.dev" | bash, which needs Java 17), boot a simulator with konnect on it, and run this again.');
  process.exit(1);
}
const r = spawnSync('maestro', ['test', '-e', `APP_ID=${appId}`, ...process.argv.slice(2), '.maestro'], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
