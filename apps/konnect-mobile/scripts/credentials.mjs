#!/usr/bin/env node
// `eas credentials` for one app and one platform, with nothing to type but the menu's answers:
//
//   node scripts/credentials.mjs <production|preview> <ios|android>
//
// It builds the app config as that app (APP_VARIANT), and on iOS signs in to Apple with Lee's App
// Store Connect team API key rather than an Apple ID and password, whose sign-in eas-cli 27.11.0
// fails ("The first argument must be of type string or an instance of Buffer ... Received
// undefined"; expo/eas-cli#2651). Every value can still be overridden from the environment.
//
// The key's ID and its team's issuer ID name the key, and grant nothing without it. The key itself,
// the .p8, is the secret: it stays on Lee's machine, outside the repo, at ASC_KEY_PATH (mode 600).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Lee's App Store Connect team key "EAS" (Admin), made 2026-11-22. */
export const ASC_KEY_ID = 'V455KTM3J2';
export const ASC_ISSUER_ID = 'b416057a-e548-4af1-892f-9713ae0b9077';
const ASC_KEY_PATH = join(homedir(), '.config', 'konnect-mobile', `AuthKey_${ASC_KEY_ID}.p8`);

const APPS = ['production', 'preview'];
const PLATFORMS = ['ios', 'android'];

const [app, platform, ...rest] = process.argv.slice(2);
if (!APPS.includes(app) || !PLATFORMS.includes(platform) || rest.length) {
  console.error(`usage: node scripts/credentials.mjs <${APPS.join('|')}> <${PLATFORMS.join('|')}>`);
  process.exit(2);
}

const env = { ...process.env, APP_VARIANT: app };
if (platform === 'ios') {
  env.EXPO_ASC_KEY_ID ??= ASC_KEY_ID;
  env.EXPO_ASC_ISSUER_ID ??= ASC_ISSUER_ID;
  env.EXPO_ASC_API_KEY_PATH ??= ASC_KEY_PATH;
  if (!existsSync(env.EXPO_ASC_API_KEY_PATH)) {
    console.error([
      `credentials ${app} ios: the App Store Connect API key isn't at ${env.EXPO_ASC_API_KEY_PATH}. Nothing was sent to EAS or Apple.`,
      `Download key ${env.EXPO_ASC_KEY_ID} from App Store Connect (Users and Access, Integrations, App Store Connect API) and put it there with mode 600,`,
      'or set EXPO_ASC_API_KEY_PATH, EXPO_ASC_KEY_ID and EXPO_ASC_ISSUER_ID to another team key.',
    ].join('\n'));
    process.exit(1);
  }
  console.log(`credentials ${app} ios: signing in to Apple with App Store Connect API key ${env.EXPO_ASC_KEY_ID}; answer "no" if asked to log in to an Apple account.`);
}
console.log(`credentials ${app} ${platform}: choose the "${app}" build profile when asked.`);

const eas = join(dirname(fileURLToPath(import.meta.url)), 'eas.mjs');
const r = spawnSync(process.execPath, [eas, 'credentials', '--platform', platform], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
