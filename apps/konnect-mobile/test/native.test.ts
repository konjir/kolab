import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// scripts/embedded-fingerprint.mjs, which `native-verify` uses, run as Node runs it (an ES module),
// against small zips laid out as an .ipa, an .aab and an .apk are.
const script = join(__dirname, '..', 'scripts', 'embedded-fingerprint.mjs');
const work = mkdtempSync(join(tmpdir(), 'konnect-native-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const HASH = 'f1d2d2f924e986ac86fdf7b36c94bcdf32beec15';

/** A zip at `name` holding `files` (path → contents). */
const zip = (name: string, files: Record<string, string>) => {
  const dir = join(work, `${name}.d`);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  const out = join(work, name);
  const r = spawnSync('zip', ['-qr', out, '.'], { cwd: dir });
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
  return out;
};

const embeds = (artifact: string, platform: string, want: string) => {
  const r = spawnSync('node', ['--input-type=module', '-e', `
    import { embedsFingerprint } from ${JSON.stringify(script)};
    try { console.log(JSON.stringify(embedsFingerprint(${JSON.stringify(artifact)}, ${JSON.stringify(platform)}, ${JSON.stringify(want)}))); }
    catch (e) { console.log(JSON.stringify({ error: e.message })); }
  `], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as { ok?: boolean; found?: { entry: string; value: string }[]; error?: string };
};

// What a fingerprint-policy build carries outside the fingerprint file: the sentinel alone.
const SENTINEL = '<plist><dict><key>EXUpdatesRuntimeVersion</key><string>file:fingerprint</string></dict></plist>';

describe('native-verify reads the runtime version a build embeds', () => {
  test('an .ipa: Payload/<App>.app/EXUpdates.bundle/fingerprint, trimmed', () => {
    const ipa = zip('app.ipa', {
      'Payload/konnect.app/Expo.plist': SENTINEL,
      'Payload/konnect.app/EXUpdates.bundle/fingerprint': `${HASH}\n`,
    });
    expect(embeds(ipa, 'ios', HASH)).toEqual({ ok: true, found: [{ entry: 'Payload/konnect.app/EXUpdates.bundle/fingerprint', value: HASH }] });
  });

  test('an .ipa with expo-updates as a framework', () => {
    const ipa = zip('framework.ipa', { 'Payload/konnect.app/Frameworks/EXUpdates.framework/EXUpdates.bundle/fingerprint': HASH });
    expect(embeds(ipa, 'ios', HASH).ok).toBe(true);
  });

  test('an .aab: base/assets/fingerprint, and an .apk: assets/fingerprint', () => {
    const aab = zip('app.aab', { 'base/manifest/AndroidManifest.xml': 'file:fingerprint', 'base/assets/fingerprint': HASH });
    expect(embeds(aab, 'android', HASH)).toEqual({ ok: true, found: [{ entry: 'base/assets/fingerprint', value: HASH }] });
    const apk = zip('app.apk', { 'assets/fingerprint': HASH });
    expect(embeds(apk, 'android', HASH).ok).toBe(true);
  });

  test('refuses another hash, and one that only contains the wanted hash', () => {
    const other = zip('other.ipa', { 'Payload/konnect.app/EXUpdates.bundle/fingerprint': '0'.repeat(40) });
    expect(embeds(other, 'ios', HASH)).toEqual({ ok: false, found: [{ entry: 'Payload/konnect.app/EXUpdates.bundle/fingerprint', value: '0'.repeat(40) }] });
    const longer = zip('longer.aab', { 'base/assets/fingerprint': `${HASH}00` });
    expect(embeds(longer, 'android', HASH).ok).toBe(false);
  });

  test('refuses a build with only the sentinel, or the other platform\'s file', () => {
    const plistOnly = zip('sentinel.ipa', { 'Payload/konnect.app/Expo.plist': `${SENTINEL}${HASH}` });
    expect(embeds(plistOnly, 'ios', HASH)).toEqual({ ok: false, found: [] });
    const ipa = zip('wrong.ipa', { 'Payload/konnect.app/EXUpdates.bundle/fingerprint': HASH });
    expect(embeds(ipa, 'android', HASH)).toEqual({ ok: false, found: [] });
    const aab = zip('wrong.aab', { 'base/assets/fingerprint': HASH, 'base/res/raw/fingerprint': HASH });
    expect(embeds(aab, 'ios', HASH)).toEqual({ ok: false, found: [] });
  });

  test('refuses a file that is not a zip', () => {
    const notZip = join(work, 'not.ipa');
    writeFileSync(notZip, 'nope');
    expect(embeds(notZip, 'ios', HASH).error).toContain("can't read");
  });
});
