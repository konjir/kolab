// W3.4's done-when, end to end, with no admin (P15, D55): a new person signs up with one command,
// `konjir login`, choosing on Kolab's page a new agent of theirs and a first kolab of their own; the
// agent works there through the CLI, whose 15-minute token refreshes by itself; the person invites
// a teammate with a link, who joins; and `konjir logout` revokes the agent's grant. The identity
// provider is a stub in GitHub's place, and the "browser" follows Kolab's redirects with its cookies.
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { StubIdentity, startServer } from '@konjir/server';
import { credentialsPath, login, logout, main } from '../src/cli.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

/** The person's browser: follows Kolab's redirects with its cookies, submits the consent page as `form` says, and lands on the CLI's loopback callback. */
async function browse(start: URL, form: Record<string, string>): Promise<string> {
  const jar = new Map<string, string>();
  const go = async (url: URL, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)); }
    return res;
  };
  let url = start;
  let res = await go(url);
  while (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location')!, url); res = await go(url); }
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error(`no consent page at ${url.pathname}: ${res.status}`);
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'allow', ...form }).toString(),
  });
  const back = new URL(done.headers.get('location')!);
  // The CLI's own loopback server receives the code.
  await (await fetch(back)).text();
  return html;
}

let out: string[];
const env = { ...process.env };
beforeEach(() => {
  out = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.KONJIR_TOKEN;
  process.env.KONJIR_CREDENTIALS = join(mkdtempSync(join(tmpdir(), 'konjir-login-')), 'konjir', 'credentials.json');
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...env };
});

test('from nothing to an agent working in its own kolab, with a teammate invited, with no admin: konjir login, a refresh, an invite, konjir logout', async () => {
  const kolab = await openKolab();
  const idp = new StubIdentity().next({ subject: '41', login: 'Ann' });
  const server = await startServer({ adminToken: 'login-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  process.env.KONJIR_URL = server.url;

  // One command. On Kolab's page Ann, new here, makes a new agent of hers and her first kolab.
  let page = '';
  const me = await login(server.url, {
    scope: 'konjir role:engineer',
    open: (u) => { void browse(u, { as: 'new-agent', agent_label: 'cli', kolab: 'new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'engineer' }).then((h) => { page = h; }); },
  });
  expect(me).toMatchObject({ actor: 'ann-cli', kind: 'agent', owner: 'ann', kolab: 'anns', role: 'engineer', layer: 'technical' });
  expect(page).toContain('Welcome: you are <code>ann</code> here');
  expect(page).toContain('konjir CLI');
  expect(page).toMatch(/value="engineer" checked/);   // preselected from --role

  // The sign-in is kept where only Ann can read it, and every konjir command uses it.
  const path = credentialsPath();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  const saved = JSON.parse(readFileSync(path, 'utf8'))[server.url];
  expect(saved.client.client_id).toMatch(/^kjcl_/);
  expect(saved.tokens.refresh_token).toMatch(/^kjr_/);
  await main(['whoami']);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ actor: 'ann-cli', owner: 'ann', kolab: 'anns' });
  out = [];
  await main(['create_node', 'kind=technical_binding', 'title=Orders on Postgres', 'id=orders-pg']);

  // Its access token expires; the next command refreshes it by itself, and the file keeps the new one.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'ann-cli' and ended_at is null`);
  out = [];
  await main(['list_nodes']);
  expect(out.join('\n')).toContain('orders-pg');
  expect(JSON.parse(readFileSync(path, 'utf8'))[server.url].tokens.refresh_token).not.toBe(saved.tokens.refresh_token);

  // Ann, as herself, invites a teammate, who signs up and joins with the link.
  const ann = await kolab.openSession('ann', 'product', { kolab: 'anns' });
  const { token } = await kolab.createInvite(ann, { level: 'write', layers: ['functional'] });
  const { actor: eli } = await kolab.signInWith({ provider: 'stub', subject: '42', login: 'eli' });
  expect((await kolab.acceptInvite(token, eli)).access).toStrictEqual({ level: 'write', layers: ['functional'] });
  // Ann's agent is unchanged by any of it: its own session, its own kolab.
  out = [];
  await main(['whoami']);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ actor: 'ann-cli', kolab: 'anns', role: 'engineer' });

  // konjir logout revokes the grant and forgets it: the agent's session ends.
  out = [];
  await main(['logout']);
  expect(out.join('\n')).toMatch(/Signed out of .*: the sign-in is revoked and forgotten/);
  expect((await kolab.db.query(`select 1 from session where actor_id = 'ann-cli' and ended_at is null`)).rows).toStrictEqual([]);
  expect(await rejection(main(['whoami']))).toMatch(/or run konjir login/);
  expect(await logout(server.url)).toBe(false);
});

test('a sign-in that was revoked elsewhere says to run konjir login; the answer to another sign-in is refused', async () => {
  const kolab = await openKolab();
  const idp = new StubIdentity().next({ subject: '43', login: 'bo' });
  const server = await startServer({ adminToken: 'login-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  process.env.KONJIR_URL = server.url;
  await login(server.url, {
    open: async (u) => {
      // A forged answer, with another state, reaches the CLI first: refused, and the real one still counts.
      const cb = new URL(u.searchParams.get('redirect_uri')!);
      const forged = await fetch(`${cb.origin}${cb.pathname}?code=kjc_forged&state=nope`);
      expect(forged.status).toBe(400);
      void browse(u, { as: 'new-agent', agent_label: 'cli', kolab: 'new', new_kolab_name: 'bos', new_kolab_title: 'Bo\'s', role: 'product' });
    },
  });
  // An admin ends the agent's session; its grant goes with it on the next refresh.
  await kolab.db.query(`update oauth_grant set revoked_at = now()`);
  await kolab.endSession({ actor: 'bo-cli' });
  expect(await rejection(main(['whoami']))).toMatch(/your sign-in to .* has ended or was revoked: run konjir login/);
});
