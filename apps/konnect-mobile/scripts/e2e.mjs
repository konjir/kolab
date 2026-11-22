#!/usr/bin/env node
// `e2e`: the Maestro flows in .maestro/, against konnect open on its tabs, signed out, on a booted
// simulator or emulator: a dev build with `start` running, or a preview build. sign-in.yaml needs
// the local Kolab (`local-kolab`, and `start` with KONNECT_URL=http://127.0.0.1:7432/mcp).
// APP_VARIANT picks the app, as in app.config.ts: development by default. Arguments go on to
// `maestro test` (a flow's path, say, in place of the folder).
//
// Maestro is installed apart from npm (https://maestro.dev, into ~/.maestro) and needs Java 17 or
// later: JAVA_HOME, or Homebrew's openjdk where it is installed.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_IDS = { development: 'com.konjir.konnect.dev', preview: 'com.konjir.konnect.preview', production: 'com.konjir.konnect' };
const variant = process.env.APP_VARIANT ?? 'development';
const appId = APP_IDS[variant];
if (!appId) { console.error(`e2e: APP_VARIANT is ${JSON.stringify(variant)}; it must be one of ${Object.keys(APP_IDS).join(', ')}`); process.exit(2); }

const maestro = [join(homedir(), '.maestro', 'bin', 'maestro')].find(existsSync)
  ?? (spawnSync('maestro', ['--version'], { stdio: 'ignore' }).error ? undefined : 'maestro');
if (!maestro) {
  console.error('e2e: Maestro isn\'t installed, so no flow ran. Install it (https://maestro.dev: its release zip into ~/.maestro), with Java 17 or later, boot a simulator with konnect on it, and run this again.');
  process.exit(1);
}
const env = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1' };
const brewJdk = '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
if (!env.JAVA_HOME && existsSync(brewJdk)) env.JAVA_HOME = brewJdk;

const args = process.argv.slice(2);
const r = spawnSync(maestro, ['test', '-e', `APP_ID=${appId}`, ...(args.length ? args : ['.maestro'])], { cwd: root, stdio: 'inherit', env });
process.exit(r.status ?? 1);
