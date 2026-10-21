// W3.5's done-when (D55): a person's Claude Code session receives Kolab's channel messages with no
// hand-issued token. The bridge listens with the sign-in `konjir login` keeps (shared with the CLI,
// through @konjir/login), lives through its access token expiring and being refreshed, signs in with
// the browser by itself when nothing is kept, waits for konjir login once signed out, and never
// prints a token. KONJIR_TOKEN still works, and overrides a kept sign-in. The identity provider is a
// stub in GitHub's place, and the "browser" follows Kolab's redirects with its cookies.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StubIdentity, startServer } from '@konjir/server';
import { StoredLogin, login } from '@konjir/login';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { KolabBridge } from '../src/bridge.js';
import type { ChannelMessage } from '../src/messages.js';
import { CLIENT_NAME, bridgeAuth } from '../src/sign-in.js';

const START = resolve(import.meta.dirname, '../scripts/start.sh');

/** The person's browser: follows Kolab's redirects with its cookies, submits the consent page as `form` says, and lands on the client's loopback callback. */
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
  const signIn = /name="sign_in" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error(`no consent page at ${url.pathname}: ${res.status}`);
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, sign_in: signIn ?? '', decision: 'allow', ...form }).toString(),
  });
  await (await fetch(new URL(done.headers.get('location')!))).text();
  return html;
}

async function until<T>(what: string, check: () => T | undefined, ms = 20_000, more = () => ''): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${more()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name: `konjir_${name}`, arguments: args });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return r.structuredContent as Record<string, unknown>;
}

/** An MCP client of Kolab with a bearer token, or with a kept sign-in, as the konjir CLI connects. */
async function kolabClient(url: string, auth: string | StoredLogin) {
  const c = new Client({ name: 'sign-in-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), typeof auth === 'string'
    ? { requestInit: { headers: { Authorization: `Bearer ${auth}` } } }
    : { authProvider: auth, fetch: auth.fetch }));
  closeAtEnd(c);
  return c;
}

let credentials: string;
const env = { ...process.env };
beforeEach(() => {
  delete process.env.KONJIR_TOKEN;
  credentials = join(mkdtempSync(join(tmpdir(), 'konjir-channel-')), 'konjir', 'credentials.json');
  process.env.KONJIR_CREDENTIALS = credentials;
});
afterEach(() => { process.env = { ...env }; });

/** A Kolab with GitHub sign-in (a stub), where Ann, new here, will make her first kolab, `anns`. */
async function kolabWithSignIn() {
  const kolab = await openKolab();
  const idp = new StubIdentity();
  const server = await startServer({ adminToken: 'channel-sign-in-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  /** Signs Ann in as `konjir login` does, as an agent of hers, keeping the sign-in in the credentials file. */
  const konjirLogin = (form: Record<string, string>) => {
    idp.next({ subject: '41', login: 'ann' });
    return login(server.url, { log: () => undefined, open: (u) => { void browse(u, { role: 'product', ...form }); } });
  };
  return { kolab, idp, server, konjirLogin };
}

/**
 * Ann's agent writes a spec through the kept sign-in, as the konjir CLI would; Ann, who also holds
 * the functional layer, approves it, then asks about it as engineer. Returns her engineer client.
 */
async function specInReview(url: string, kolab: Awaited<ReturnType<typeof openKolab>>, agent: Client) {
  await call(agent, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(agent, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(agent, 'submit_for_review', { node: 'orders', version: 1 });
  const product = await kolabClient(url, await annAs(kolab, 'product'));
  await call(product, 'review', { node: 'orders', version: 1, verdict: 'approve' });
  await product.close();
  return kolabClient(url, await annAs(kolab, 'engineer'));
}

/** A hand-issued session for Ann herself in her kolab, ending the one she holds (one each, ENF4). */
async function annAs(kolab: Awaited<ReturnType<typeof openKolab>>, role: 'product' | 'engineer') {
  await kolab.endSession({ actor: 'ann' }).catch(() => undefined);
  return kolab.openSession('ann', role, { kolab: 'anns' });
}

const saved = (url: string) => JSON.parse(readFileSync(credentials, 'utf8'))[url].tokens as { access_token: string; refresh_token: string };

test('with the sign-in konjir login keeps, and no token, the session hears its inbox, through an access token expiring and being refreshed; no token is ever printed', async () => {
  const { kolab, server, konjirLogin } = await kolabWithSignIn();
  await konjirLogin({ as: 'new-agent', agent_label: 'cli', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s' });
  const first = saved(server.url);

  // Ann's agent writes a spec through the same sign-in, as the konjir CLI would; Ann herself asks about it, as engineer.
  const agent = await kolabClient(server.url, new StoredLogin(server.url));
  const ann = await specInReview(server.url, kolab, agent);

  // The bridge as Claude Code starts it, with no KONJIR_TOKEN, and its own browser sign-in off: it must use what is kept.
  const transport = new StdioClientTransport({
    command: START,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', KONJIR_URL: server.url, KONJIR_TOKEN: '', KONJIR_CREDENTIALS: credentials, KONJIR_CHANNEL_SIGN_IN: 'off', KONJIR_CHANNEL_BACKOFF_MS: '100,1000' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr!.on('data', (d) => { stderr += String(d); });
  const messages: ChannelMessage[] = [];
  const claude = new Client({ name: 'claude-code-stand-in', version: '0' });
  claude.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') messages.push(n.params as unknown as ChannelMessage); };
  await claude.connect(transport);
  closeAtEnd(claude);
  const more = () => `messages: ${JSON.stringify(messages, null, 2)}\nbridge stderr:\n${stderr}`;
  const listening = (n: number) => until(`listen #${n}`, () => stderr.split('\n').filter((l) => /\b(re)?connected to Kolab\b/.test(l)).length >= n || undefined, 40_000, more);

  await listening(1);
  expect(stderr).toMatch(/using the sign-in konjir login keeps for/);
  expect(stderr).toMatch(/connected to Kolab at .* as ann-cli \(product\); watching konjir:\/\/inbox\/anns\/functional, konjir:\/\/answers\/anns\/ann-cli/);
  await call(ann, 'ask', { address: 'kj:orders#R8', question: 'From which statuses?' });
  const asked = await until('the question', () => messages.find((m) => m.content.includes('"From which statuses?"')), 20_000, more);
  expect(asked.meta).toMatchObject({ uri: 'konjir://inbox/anns/functional', kind: 'inbox', open_queries: '1' });

  // The access token expires. Kolab closes the stream before it signals the next change; the bridge
  // connects again, the MCP client refreshing the token, and re-reads what changed meanwhile.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'ann-cli' and ended_at is null`);
  await call(ann, 'ask', { address: 'kj:orders#R8', question: 'And refunds?' });
  await listening(2);
  const next = await until('the question asked while the token had expired', () => messages.find((m) => m.content.includes('"And refunds?"')), 20_000, more);
  expect(next.meta.open_queries).toBe('2');
  const second = saved(server.url);
  expect(second.refresh_token).not.toBe(first.refresh_token);   // rotated, and kept for konjir too

  // And again: a refresh by another konjir process (the agent's own CLI) rotates the token under the bridge.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'ann-cli' and ended_at is null`);
  expect(await call(agent, 'whoami')).toMatchObject({ actor: 'ann-cli' });
  const third = saved(server.url);
  expect(third.refresh_token).not.toBe(second.refresh_token);
  await call(ann, 'ask', { address: 'kj:orders#R8', question: 'Partial refunds too?' });
  await until('the question after the CLI refreshed', () => messages.find((m) => m.content.includes('"Partial refunds too?"')), 40_000, more);
  // One grant, never revoked: the bridge and the CLI share the sign-in, and no refresh token was used twice.
  expect((await kolab.db.query(`select revoked_at from oauth_grant where actor_id = 'ann-cli'`)).rows).toStrictEqual([{ revoked_at: null }]);

  const printed = JSON.stringify(messages) + stderr;
  for (const t of [first, second, third, saved(server.url)]) {
    expect(printed).not.toContain(t.access_token);
    expect(printed).not.toContain(t.refresh_token);
  }
  expect(printed).not.toMatch(/\bkj[src]_[A-Za-z0-9_-]{8,}/);
  await claude.close();

  // KONJIR_TOKEN still works, and overrides the kept sign-in.
  const handIssued = await annAs(kolab, 'engineer');
  const byToken = new StdioClientTransport({
    command: START,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', KONJIR_URL: server.url, KONJIR_TOKEN: handIssued, KONJIR_CREDENTIALS: credentials, KONJIR_CHANNEL_BACKOFF_MS: '100,1000' },
    stderr: 'pipe',
  });
  let tokenStderr = '';
  byToken.stderr!.on('data', (d) => { tokenStderr += String(d); });
  const claude2 = new Client({ name: 'claude-code-stand-in', version: '0' });
  await claude2.connect(byToken);
  closeAtEnd(claude2);
  await until('the token bridge', () => /connected to Kolab at .* as ann \(engineer\)/.test(tokenStderr) || undefined, 40_000, () => tokenStderr);
  expect(tokenStderr).not.toMatch(/using the sign-in/);
  expect(tokenStderr).not.toContain(handIssued);
  await claude2.close();
  await server.close();
}, 180_000);

test('with nothing kept, the bridge signs in with the browser by itself, for konjir too; signed out, it says to run konjir login and picks the new sign-in up with no restart', async () => {
  const { kolab, idp, server, konjirLogin } = await kolabWithSignIn();
  const messages: ChannelMessage[] = [];
  const logs: string[] = [];
  const forward = async (m: ChannelMessage) => { messages.push(m); };
  const log = (l: string) => { logs.push(l); };
  let page = '';
  idp.next({ subject: '41', login: 'ann' });
  const auth = await bridgeAuth(server.url, { KONJIR_URL: server.url }, {
    forward, log,
    open: (u) => browse(u, { as: 'new-agent', agent_label: 'channel', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'product' }).then((h) => { page = h; }),
  });
  expect(page).toContain(CLIENT_NAME);   // Kolab's consent page names the bridge
  const told = messages.find((m) => m.meta.status === 'signing_in')!;
  expect(told.content).toMatch(/opened the user's browser at Kolab's sign-in page/);
  expect(told.content).toContain(`${new URL(server.url).origin}/oauth/authorize?`);
  expect(logs.join('\n')).toMatch(/signed in to .* as ann-channel, in kolab anns as product; kept for konjir too/);
  expect(auth.login).toBeDefined();
  expect(new StoredLogin(server.url).signedIn).toBe(true);   // the konjir CLI sees the same sign-in

  const bridge = new KolabBridge({ url: server.url, ...auth, forward, log, backoff: { initialMs: 100, maxMs: 300 } });
  let listens = 0;
  bridge.onListening = () => { listens++; };
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  await until('the first listen', () => listens === 1 || undefined);
  expect(bridge.me).toMatchObject({ actor: 'ann-channel', role: 'product' });

  // The grant is revoked and its session ended (an admin, or Ann from another device): Kolab closes
  // the stream, the refresh is refused, and the bridge says so once, without opening the browser.
  await kolab.db.query(`update oauth_grant set revoked_at = now() where actor_id = 'ann-channel'`);
  await kolab.endSession({ actor: 'ann-channel' });
  const out = await until('the sign-out', () => messages.find((m) => m.meta.status === 'signed_out'), 20_000, () => logs.join('\n'));
  expect(out.content).toMatch(/was signed out of Kolab at .*: its sign-in ended or was revoked.* run konjir login --url .* The channel picks the sign-in up by itself, with no restart\./);
  await new Promise((r) => setTimeout(r, 800));
  expect(messages.filter((m) => m.meta.status === 'signed_out').length).toBe(1);

  // konjir login signs in again, as the same agent: the bridge listens again, and the session hears its inbox.
  await konjirLogin({ as: 'agent:ann-channel', kolab: 'kolab:anns' });
  await until('the listen after konjir login', () => listens === 2 || undefined, 20_000, () => logs.join('\n'));
  const agent = await kolabClient(server.url, new StoredLogin(server.url));
  const ann = await specInReview(server.url, kolab, agent);
  await call(ann, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await until('the question', () => messages.find((m) => m.content.includes('"Which statuses?"')), 20_000, () => logs.join('\n'));

  const tokens = JSON.stringify(JSON.parse(readFileSync(credentials, 'utf8')));
  for (const t of tokens.match(/kj[sr]_[A-Za-z0-9_-]+/g)!) expect(JSON.stringify(messages) + logs.join('\n')).not.toContain(t);
  await bridge.stop();
  await server.close();
}, 120_000);

test('with nothing kept and its own sign-in off, the bridge tells the session to run konjir login, and waits', async () => {
  const { server } = await kolabWithSignIn();
  const messages: ChannelMessage[] = [];
  const logs: string[] = [];
  const forward = async (m: ChannelMessage) => { messages.push(m); };
  const auth = await bridgeAuth(server.url, { KONJIR_CHANNEL_SIGN_IN: 'off' }, { forward, log: (l) => logs.push(l), open: () => { throw new Error('no browser'); } });
  expect(logs.join('\n')).toMatch(/KONJIR_CHANNEL_SIGN_IN is off: run konjir login --url/);
  const bridge = new KolabBridge({ url: server.url, ...auth, forward, log: (l) => logs.push(l), backoff: { initialMs: 100, maxMs: 200 } });
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  const told = await until('the message', () => messages.find((m) => m.meta.status === 'unconfigured'));
  expect(told.content).toMatch(/has no sign-in to Kolab at .* run konjir login --url/);
  await new Promise((r) => setTimeout(r, 600));
  expect(messages.length).toBe(1);
  // It registered no client while waiting: nothing reached Kolab's registration endpoint.
  expect((await server.kolab.db.query(`select count(*)::int as n from oauth_client`)).rows).toStrictEqual([{ n: 0 }]);
  await bridge.stop();
  await server.close();
});

test('the bridge masks any Kolab secret in what it prints', () => {
  const b = new KolabBridge({ url: 'http://127.0.0.1:9/mcp', token: 'kjs_given', forward: async () => undefined, log: () => undefined });
  expect(b.redact('a kjs_given, kjr_abc-DEF_1 and kjc_x9 here')).toBe('a ***, *** and *** here');
  expect(() => new KolabBridge({ url: 'http://127.0.0.1:9/mcp', forward: async () => undefined, log: () => undefined })).toThrow(/exactly one/);
});
