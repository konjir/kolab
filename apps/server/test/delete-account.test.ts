// konjir_delete_my_account over HTTP, with the stub identity provider in GitHub's place (Lee's
// decision of 2026-11-23, "remove me, keep my words"; migration 0060): only a person's own sign-in
// through konnect's app deletes its account, naming it; an agent's token, the admin token and any
// other app's sign-in are refused. Refused while the person owns a kolab someone else is in, with
// each such kolab in the refusal's structuredContent for the app to list. Once deleted, the
// sign-in's tokens reach nothing, and the same identity signing in again is a new person.
import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab, type TestKolab } from '@konjir/engine/testing';
import { StubIdentity, startServer } from '../src/server.js';

const APP = 'https://www.konjir.com/konnect/app/oauth';
const VERIFIER = 'v'.repeat(43);
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const ANN = { subject: '11', login: 'ann' };
const BOB = { subject: '22', login: 'bob' };
const PROTOCOL = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'konnect-app', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };

async function serve(kolab: Kolab) {
  const idp = new StubIdentity();
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null, identity: idp });
  closeAtEnd(server);
  return { base: new URL(server.url).origin, mcp: server.url, idp };
}

/** A browser: cookies kept, Kolab's redirects followed, stopping at one that leaves it. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  async go(url: string | URL, init: RequestInit = {}): Promise<{ res: Response; html: string; left?: URL }> {
    let at = new URL(url, this.base);
    for (let i = 0; ; i++) {
      const res = await fetch(at, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string> | undefined), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
      for (const c of res.headers.getSetCookie()) {
        const kv = c.split(';')[0];
        const name = kv.slice(0, kv.indexOf('='));
        if (/max-age=0/i.test(c)) this.cookies.delete(name); else this.cookies.set(name, kv.slice(kv.indexOf('=') + 1));
      }
      if (res.status < 300 || res.status >= 400 || i > 10) return { res, html: await res.text() };
      const next = new URL(res.headers.get('location')!, at);
      if (next.origin !== new URL(this.base).origin) return { res, html: '', left: next };
      at = next;
      init = {};
    }
  }
}

async function register(base: string) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'konnect', redirect_uris: [APP] }) });
  return (await r.json() as { client_id: string }).client_id;
}

const tokenEndpoint = async (base: string, form: Record<string, string>) => {
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  return { status: r.status, body: await r.json() as Record<string, string> };
};

/** `who` signs in through konnect's app, Continue on Kolab's page: the app's tokens. */
async function appTokens(base: string, idp: StubIdentity, client: string, who: { subject: string; login: string }) {
  const browser = new Browser(base);
  idp.next(who);
  const u = new URL('/oauth/authorize', base);
  u.search = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: APP, state: 'st', code_challenge: s256(VERIFIER), code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'konjir choose:kolab' }).toString();
  const page = await browser.go(u);
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(page.html)?.[1] ?? '';
  const left = (await browser.go('/oauth/consent', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: field('csrf'), sign_in: field('sign_in'), pick: 'continue' }).toString(),
  })).left!;
  const t = await tokenEndpoint(base, { grant_type: 'authorization_code', code: left.searchParams.get('code')!, client_id: client, redirect_uri: APP, code_verifier: VERIFIER });
  if (t.status !== 200) throw new Error(JSON.stringify(t.body));
  return t.body;
}

/** A tool called over /mcp with `token`: its structured result, or its error's text and structuredContent; or the HTTP status, if not 200. */
async function tool(mcp: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ ok?: Record<string, unknown>; error?: string; structured?: Record<string, unknown>; status?: number }> {
  const res = await fetch(mcp, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } }),
  });
  if (res.status !== 200) return { status: res.status };
  const text = await res.text();
  const body = JSON.parse(text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)![1]) as { result?: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> }; error?: { message: string } };
  if (body.error) return { error: body.error.message };
  const r = body.result!;
  return r.isError ? { error: r.content[0].text, structured: r.structuredContent } : { ok: r.structuredContent };
}

/** Ann owns `anns`, where Bob holds Read; Bob owns `bobs`, alone; Bob's agent works in anns with a token of its own. */
async function world(kolab: TestKolab) {
  for (const who of [ANN, BOB]) await kolab.signInWith({ provider: 'stub', ...who });
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  await kolab.makeOwnKolab('bob', 'bobs', 'Bob\'s');
  await kolab.grant('anns', 'bob', 'read');
  await kolab.addActor('bob-claude', { owner: 'bob' });
  await kolab.grant('anns', 'bob-claude', 'read');
  return { agent: await kolab.openSession('bob-claude', 'engineer', { kolab: 'anns' }) };
}

test('only a person\'s own sign-in through konnect\'s app deletes its account, naming it: an agent\'s token, the admin token and another person\'s sign-in are refused, and nothing changes', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  const { agent } = await world(kolab);
  const app = await register(base);
  const bob = await appTokens(base, idp, app, BOB);
  const ann = await appTokens(base, idp, app, ANN);

  expect((await tool(mcp, agent, 'konjir_delete_my_account', { account: 'bob' })).error).toMatch(/^AccessError: bob-claude is an agent: only a person deletes their account/);
  expect((await tool(mcp, 'admin-token', 'konjir_delete_my_account', { account: 'bob' })).error).toMatch(/^RoleError: this tool needs a person's own sign-in/);
  expect((await tool(mcp, ann.access_token, 'konjir_delete_my_account', { account: 'bob' })).error).toMatch(/^TenancyError: name the account to delete: type ann/);
  expect((await tool(mcp, bob.access_token, 'konjir_delete_my_account', {})).error).toMatch(/account/);
  // Ann owns a kolab Bob is in: refused, and the app is told which, to list.
  const refused = await tool(mcp, ann.access_token, 'konjir_delete_my_account', { account: 'ann' });
  expect(refused.error).toMatch(/^TenancyError: your account can't be deleted yet: kolab anns is yours and has 2 other members: hand it over, or erase it/);
  expect(refused.structured).toStrictEqual({ blocked: [{ name: 'anns', kind: 'kolab', reason: 'members', why: expect.stringContaining('kolab anns is yours') }] });
  // Nothing changed: both still signed in, Bob still a member.
  expect((await tool(mcp, ann.access_token, 'konjir_whoami')).ok).toMatchObject({ actor: 'ann' });
  expect((await tool(mcp, bob.access_token, 'konjir_whoami')).ok).toMatchObject({ actor: 'bob' });
  expect((await kolab.db.query(`select 1 from identity where actor_id = 'bob'`)).rows).toHaveLength(1);
});

test('the person deletes their account in the app: its tokens reach nothing, its words stay as a deleted account\'s, and the same identity signing in again is a new person', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  const { agent } = await world(kolab);
  const app = await register(base);
  const bob = await appTokens(base, idp, app, BOB);
  const ann = await appTokens(base, idp, app, ANN);
  // Bob's app opened anns, the first of his teams by name; he says something there first.
  expect((await tool(mcp, bob.access_token, 'konjir_whoami')).ok).toMatchObject({ actor: 'bob', kolab: 'anns' });
  expect((await tool(mcp, bob.access_token, 'konjir_send_channel_message', { channel: 'general', message: 'Bye all' })).ok).toBeDefined();

  const done = await tool(mcp, bob.access_token, 'konjir_delete_my_account', { account: '@bob' });
  expect(done.ok).toStrictEqual({ deleted: 'bob', left: ['anns'], erased: ['bobs'], agents: 1, revoked: 1, ended: 2, devices: 0 });
  // Its access token, its agent's and its refresh token reach nothing now.
  expect((await tool(mcp, bob.access_token, 'konjir_whoami')).status).toBe(401);
  expect((await tool(mcp, agent, 'konjir_whoami')).status).toBe(401);
  expect((await tokenEndpoint(base, { grant_type: 'refresh_token', refresh_token: bob.refresh_token, client_id: app })).status).toBe(400);
  // In anns, Bob is no member, and his message is a deleted account's.
  const members = (await tool(mcp, ann.access_token, 'konjir_list_members')).ok as { members: { actor: string }[] };
  expect(members.members.map((m) => m.actor)).toStrictEqual(['ann']);
  const general = (await tool(mcp, ann.access_token, 'konjir_list_channel_messages', { channel: 'general' })).ok as { messages: { from: string; message: string; from_deleted?: boolean }[] };
  expect(general.messages).toStrictEqual([expect.objectContaining({ from: 'bob', message: 'Bye all', from_deleted: true })]);
  // The same GitHub account signs in again: a new person, who holds nothing of the old one's.
  const again = await kolab.signInWith({ provider: 'stub', ...BOB });
  expect(again).toStrictEqual({ actor: 'bob_2', created: true });
  expect(await kolab.reachable('bob_2')).toStrictEqual([]);
});
