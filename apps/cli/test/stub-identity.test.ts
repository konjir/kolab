// KONJIR_STUB_IDENTITY (Lee's instruction of 2026-11-01): `konjir serve` with the stub identity
// provider, for local development and browser tests, so a browser completes Kolab's sign-in with no
// GitHub. It signs anyone in, so it can never be on in a deployed Kolab: refused with a public host
// (every deployed Kolab has one) and beside GitHub's settings, and the deployed config never sets it.
import { expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
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

test('konjir serve with KONJIR_STUB_IDENTITY and a public host refuses to start', async () => {
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
