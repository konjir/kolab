import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** scripts/eas.mjs, as the Nx targets run it, with `env` added to (or taken from) this process's. */
const eas = (args: string[], env: Record<string, string | undefined>) => {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v;
  return spawnSync('node', [join(__dirname, '..', 'scripts', 'eas.mjs'), ...args], { encoding: 'utf8', env: merged });
};

describe('eas update', () => {
  test('is refused unless it is built as its channel\'s variant, before anything reaches EAS', () => {
    for (const [channel, variant] of [['preview', undefined], ['preview', 'development'], ['production', 'preview']] as const) {
      const r = eas(['update', '--channel', channel, '--message', 'x'], { APP_VARIANT: variant });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`must be built with APP_VARIANT=${channel}`);
    }
  });

  test('is refused with no channel, and unsigned', () => {
    expect(eas(['update', '--message', 'x'], { APP_VARIANT: 'preview' }).stderr).toContain('name the channel');
    const r = eas(['update', '--channel', 'preview', '--message', 'x'], { APP_VARIANT: 'preview', KONNECT_UPDATES_PRIVATE_KEY_PATH: '/nonexistent' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('updates are signed');
  });

  test('takes its message from KONNECT_UPDATE_MESSAGE, given once and not empty', () => {
    const signed = { APP_VARIANT: 'preview', KONNECT_UPDATES_PRIVATE_KEY_PATH: __filename };
    const both = eas(['update', '--channel', 'preview', '--message', 'x'], { ...signed, KONNECT_UPDATE_MESSAGE: 'main at abc' });
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('give the message once');
    const empty = eas(['update', '--channel', 'preview'], { ...signed, KONNECT_UPDATE_MESSAGE: ' ' });
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('KONNECT_UPDATE_MESSAGE is empty');
  });

  test('is refused with the channel named more than once, however it is written', () => {
    for (const extra of [['--channel', 'production'], ['--channel=production'], ['--channel', 'preview']]) {
      const r = eas(['update', '--channel', 'preview', ...extra, '--message', 'x'], { APP_VARIANT: 'preview' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('name one channel, once');
    }
    const r = eas(['update', '--channel=production', '--message', 'x'], { APP_VARIANT: 'preview' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must be built with APP_VARIANT=production');
  });
});

describe('eas submit', () => {
  test('is refused unless it runs as its profile\'s variant, before anything reaches EAS', () => {
    for (const [profile, variant] of [['preview', undefined], ['preview', 'development'], ['production', 'preview']] as const) {
      const r = eas(['submit', '--non-interactive', '--profile', profile, '--platform', 'ios'], { APP_VARIANT: variant });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`must run with APP_VARIANT=${profile}`);
    }
  });

  test('names one known profile, once', () => {
    for (const args of [['submit'], ['submit', '--profile', 'development'], ['submit', '--profile', 'preview', '--profile=production']]) {
      const r = eas(args, { APP_VARIANT: 'preview' });
      expect([args, r.status]).toStrictEqual([args, 2]);
      expect(r.stderr).toMatch(/name the profile, once|--profile is preview or production/);
    }
  });

  test('every submit target sets the variant its profile needs', () => {
    const scripts = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts).filter(([, c]) => c.includes('eas.mjs submit'))) {
      const profile = /--profile (\w+)/.exec(cmd)?.[1];
      expect([name, cmd.startsWith(`APP_VARIANT=${profile} `)]).toStrictEqual([name, true]);
    }
  });
});

/** scripts/credentials.mjs, as its Nx targets run it, with HOME at an empty folder unless `env` says otherwise. */
const credentials = (args: string[], env: Record<string, string | undefined> = {}) => {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, HOME: mkdtempSync(join(tmpdir(), 'creds-')), EXPO_ASC_API_KEY_PATH: undefined, EXPO_ASC_KEY_ID: undefined, EXPO_ASC_ISSUER_ID: undefined, ...env })) if (v !== undefined) merged[k] = v;
  return spawnSync('node', [join(__dirname, '..', 'scripts', 'credentials.mjs'), ...args], { encoding: 'utf8', env: merged });
};

describe('eas credentials', () => {
  test('names one app and one platform, or does nothing', () => {
    for (const args of [[], ['production'], ['development', 'ios'], ['production', 'web'], ['production', 'ios', '--extra']]) {
      const r = credentials(args);
      expect([args, r.status]).toStrictEqual([args, 2]);
      expect(r.stderr).toContain('usage: node scripts/credentials.mjs <production|preview> <ios|android>');
    }
  });

  test('on iOS, signs in with the App Store Connect key in ~/.config/konnect-mobile, and stops before EAS or Apple when it is not there', () => {
    const home = mkdtempSync(join(tmpdir(), 'creds-'));
    const r = credentials(['preview', 'ios'], { HOME: home });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`isn't at ${join(home, '.config', 'konnect-mobile', 'AuthKey_V455KTM3J2.p8')}. Nothing was sent to EAS or Apple.`);
    const elsewhere = credentials(['production', 'ios'], { EXPO_ASC_API_KEY_PATH: '/nonexistent/AuthKey_X.p8' });
    expect(elsewhere.stderr).toContain("isn't at /nonexistent/AuthKey_X.p8");
  });
});
