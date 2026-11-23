// KONJIR_STUB_IDENTITY (Lee's instruction of 2026-11-01): `kolab serve` with the stub identity
// provider, for local development and browser tests, so a browser completes Kolab's sign-in with no
// GitHub. It signs anyone in, so it can never be on in a deployed Kolab: refused with a public host
// (every deployed Kolab has one) and beside GitHub's settings, and the deployed config never sets it.
import { expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StubIdentity } from '@konjir/server';
import { signInSettings } from '../src/cli.js';

const root = resolve(import.meta.dirname, '../../..');
const load = async () => ({ StubIdentity, GitHubIdentity: class {} as never });

test('KONJIR_STUB_IDENTITY: the stub signs everyone in as its login, on a local Kolab only; refused with a public host, beside GitHub, or naming no login', async () => {
  const s = signInSettings({ KONJIR_STUB_IDENTITY: 'icedlee337' });
  expect(s.stub).toBe('icedlee337');
  expect(s.describe).toMatch(/^the stub identity provider \(KONJIR_STUB_IDENTITY\): anyone who opens Kolab's sign-in is signed in as icedlee337, with no check; local development only/);
  const { identity } = await s.identity(load) as { identity: StubIdentity };
  expect(identity).toBeInstanceOf(StubIdentity);
  expect(identity.as).toStrictEqual({ subject: 'stub-icedlee337', login: 'icedlee337' });
  expect(signInSettings({ KONJIR_STUB_IDENTITY: ' ' }).stub).toBeUndefined();
  expect(signInSettings({}).stub).toBeUndefined();
  expect(() => signInSettings({ KONJIR_STUB_IDENTITY: 'ann' }, { publicHost: 'kolab.konjir.com' })).toThrow(/only for a local Kolab, never one with a public host/);
  expect(() => signInSettings({ KONJIR_STUB_IDENTITY: 'ann', KONJIR_GITHUB_CLIENT_ID: 'i', KONJIR_GITHUB_CLIENT_SECRET: 's' })).toThrow(/for a local Kolab without GitHub/);
  for (const bad of ['a b', '-ann', 'ann;rm', 'x'.repeat(40)]) expect(() => signInSettings({ KONJIR_STUB_IDENTITY: bad })).toThrow(/the login everyone signs in as/);
});

test('the deployed Kolab can\'t turn the stub on: its config never names it, and always gives the public host that refuses it', () => {
  const userdata = readFileSync(join(root, 'deploy/terraform/modules/kolab/userdata.sh.tftpl'), 'utf8');
  const start = readFileSync(join(root, 'deploy/release/start.sh'), 'utf8');
  for (const text of [userdata, start]) expect(text).not.toContain('KONJIR_STUB_IDENTITY');
  expect(userdata).toMatch(/^KONJIR_PUBLIC_HOST=\$DOMAIN$/m);
});

test('Sign in with Apple: on beside GitHub with all four of its settings; with any missing, or a key that isn\'t Apple\'s, off and said so, and Kolab runs on; never beside the stub', async () => {
  const { AppleIdentity, GitHubIdentity } = await import('@konjir/server');
  const load = async () => ({ StubIdentity, GitHubIdentity, AppleIdentity });
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const github = { KONJIR_GITHUB_CLIENT_ID: 'Iv1.x', KONJIR_GITHUB_CLIENT_SECRET: 'shh' };
  const apple = { KONJIR_APPLE_SERVICES_ID: 'com.konjir.kolab.signin', KONJIR_APPLE_TEAM_ID: '7Y8QD34KJQ', KONJIR_APPLE_KEY_ID: 'ABCDE12345', KONJIR_APPLE_PRIVATE_KEY: key };
  const ids = (r: { identity?: unknown }) => [r.identity ?? []].flat().map((i) => (i as { id: string }).id);

  const both = signInSettings({ ...github, ...apple });
  expect([both.github, both.apple, both.appleOff, both.describe, both.webTokenSignIn]).toStrictEqual([true, true, undefined, 'GitHub and Apple; hand-issued session tokens', false]);
  expect(ids(await both.identity(load))).toStrictEqual(['github', 'apple']);
  expect(ids(await signInSettings(apple).identity(load))).toStrictEqual(['apple']);

  // Production before Lee sets them all: only the team id's parameter is there.
  const partial = signInSettings({ ...github, KONJIR_APPLE_TEAM_ID: '7Y8QD34KJQ' });
  expect([partial.apple, partial.appleOff, partial.describe]).toStrictEqual([false, 'Sign in with Apple is off: KONJIR_APPLE_SERVICES_ID, KONJIR_APPLE_KEY_ID, KONJIR_APPLE_PRIVATE_KEY are unset', 'GitHub; hand-issued session tokens']);
  expect(ids(await partial.identity(load))).toStrictEqual(['github']);
  expect(signInSettings(github).appleOff).toBeUndefined();

  // A key that isn't Apple's: off, said through `warn`, never with the key; GitHub goes on.
  const warned: string[] = [];
  expect(ids(await signInSettings({ ...github, ...apple, KONJIR_APPLE_PRIVATE_KEY: 'not-a-key' }).identity(load, (m) => warned.push(m)))).toStrictEqual(['github']);
  expect(warned).toStrictEqual(['Sign in with Apple is off: the Sign in with Apple private key isn\'t a PEM private key: put the .p8 file Apple gave']);

  expect(() => signInSettings({ KONJIR_STUB_IDENTITY: 'ann', KONJIR_APPLE_TEAM_ID: '7Y8QD34KJQ' })).toThrow(/for a local Kolab without Apple/);
  // The deployed start script reads all four beside the admin token, the key decrypted, and never prints it.
  const start = readFileSync(join(root, 'deploy/release/start.sh'), 'utf8');
  for (const name of ['apple-signin-${pair#*:}', 'apple-signin-private-key', 'KONJIR_APPLE_PRIVATE_KEY="$APPLE_KEY"']) expect(start).toContain(name);
  expect(start).not.toMatch(/(echo|printf)[^\n]*APPLE_KEY/);
});

test('kolab serve with KONJIR_STUB_IDENTITY and a public host refuses to start', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn('node', [join(root, 'apps/cli/dist/main.js'), 'serve', '--port', String(port), '--data', mkdtempSync(join(tmpdir(), 'konjir-')), '--public-host', 'kolab.example.com', '--quiet'], {
    env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types', KONJIR_ADMIN_TOKEN: 'x'.repeat(44), KONJIR_STUB_IDENTITY: 'ann' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d; });
  child.stderr.on('data', (d: Buffer) => { output += d; });
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (c) => { clearTimeout(timer); done(c); });
  });
  expect(code).toBe(1);
  expect(output).toMatch(/KONJIR_STUB_IDENTITY signs anyone who opens Kolab's sign-in in, with no check: it is only for a local Kolab/);
  expect(output).not.toContain('Kolab listening');
}, 90_000);
