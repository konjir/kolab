// W3.5's done-when (D55): a person's Claude Code session receives Kolab's channel messages with no
// hand-issued token. The bridge listens with the sign-in `konjir login` keeps (shared with the CLI,
// through @konjir/login), lives through its access token expiring and being refreshed, signs in with
// the browser by itself when nothing is kept, waits for konjir login once signed out, and never
// prints a token. KONJIR_TOKEN still works, and overrides a kept sign-in. The identity provider is a
// stub in GitHub's place, and the "browser" follows Kolab's redirects with its cookies.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StubIdentity, startServer } from '@konjir/server';
import { FileLock, StoredLogin, agentCredentials, agentCredentialsPath, login } from '@konjir/login';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';
import { KolabBridge } from '../src/bridge.js';
import type { ChannelMessage } from '../src/messages.js';
import { CLIENT_NAME, bridgeAuth, browserAvailable, scopeFrom } from '../src/sign-in.js';

const START = resolve(import.meta.dirname, '../scripts/start.sh');
/** A scratch home for each spawned bridge: none ever reaches the person's own ~/.config. */
const scratchHome = () => mkdtempSync(join(tmpdir(), 'konjir-home-'));

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
    env: { PATH: process.env.PATH ?? '', HOME: scratchHome(), XDG_CONFIG_HOME: scratchHome(), KONJIR_URL: server.url, KONJIR_TOKEN: '', KONJIR_CREDENTIALS: credentials, KONJIR_CHANNEL_SIGN_IN: 'off', KONJIR_CHANNEL_BACKOFF_MS: '100,1000' },
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
    env: { PATH: process.env.PATH ?? '', HOME: scratchHome(), XDG_CONFIG_HOME: scratchHome(), KONJIR_URL: server.url, KONJIR_TOKEN: handIssued, KONJIR_CREDENTIALS: credentials, KONJIR_CHANNEL_BACKOFF_MS: '100,1000' },
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
  // Fixed words: the link (its state, PKCE challenge and loopback port) never reaches the model; it is in the log.
  expect(told.content).toBe(`Konjir needs the user to sign in to Kolab at ${server.url}: a browser window opened at Kolab's sign-in page. If it didn't, the link is in the Konjir channel's log, or the user can run konjir login --url ${server.url} in a terminal. Inbox changes start arriving once that is done. Tell the user.`);
  expect(logs.join('\n')).toContain(`${new URL(server.url).origin}/oauth/authorize?`);
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
  await kolab.db.query(`update oauth_grant set revoked_at = now(), revoked_by = 'admin' where actor_id = 'ann-channel'`);
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

test('a bridge sign-in that finishes after a konjir login kept one yields: the CLI\'s is kept, and the bridge\'s own grant is revoked', async () => {
  const { kolab, idp, server, konjirLogin } = await kolabWithSignIn();
  await konjirLogin({ as: 'new-agent', agent_label: 'cli', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s' });
  const cli = saved(server.url);
  // Forgotten here only, so the bridge starts a sign-in of its own; the CLI's grant still holds at Kolab.
  const all = JSON.parse(readFileSync(credentials, 'utf8'));
  writeFileSync(credentials, JSON.stringify({}));
  const logs: string[] = [];
  const auth = await bridgeAuth(server.url, {}, {
    forward: async () => undefined, log: (l) => logs.push(l),
    open: async (u) => {
      // While the person is on the bridge's page, konjir login keeps a sign-in (here, the one from before).
      writeFileSync(credentials, JSON.stringify(all));
      idp.next({ subject: '41', login: 'ann' });
      await browse(u, { as: 'new-agent', agent_label: 'channel', kolab: 'kolab:anns', role: 'product' });
    },
  });
  expect(logs.join('\n')).toMatch(/another konjir signed in to .* meanwhile, as ann-cli: the channel uses that sign-in, and revoked its own/);
  expect(saved(server.url).refresh_token).toBe(cli.refresh_token);
  expect(new StoredLogin(server.url).saved().client?.client_id).toBe(all[server.url].client.client_id);
  const grants = (await kolab.db.query<{ actor_id: string; revoked: boolean }>(`select actor_id, revoked_at is not null as revoked from oauth_grant order by created_at`)).rows;
  expect(grants).toStrictEqual([{ actor_id: 'ann-cli', revoked: false }, { actor_id: 'ann-channel', revoked: true }]);
  expect(await call(await kolabClient(server.url, auth.login!), 'whoami')).toMatchObject({ actor: 'ann-cli' });
  await server.close();
}, 60_000);

test('one bridge signs in at a time; none signs in over http to another host, or with no browser to open', async () => {
  const { server } = await kolabWithSignIn();
  const logs: string[] = [];
  const io = { forward: async () => undefined, log: (l: string) => { logs.push(l); }, open: () => { throw new Error('opened'); } };
  // Another bridge holds the marker: this one opens nothing and waits for that sign-in.
  const marker = new FileLock(`${credentials}.signing-in`);
  await marker.acquire('other-bridge');
  const auth = await bridgeAuth(server.url, {}, io);
  expect(logs.join('\n')).toMatch(/another konjir channel started a browser sign-in to .*; this one will use that sign-in once it is done/);
  expect(auth.login?.signedIn).toBe(false);
  expect(auth.awaiting).toBe('another-channel');
  // The session is told what is really happening, not that nothing is kept.
  const told: ChannelMessage[] = [];
  const waiting = new KolabBridge({ url: server.url, ...auth, forward: async (m) => { told.push(m); }, log: () => undefined, backoff: { initialMs: 50, maxMs: 100 } });
  waiting.start();
  await until('the waiting message', () => told[0]);
  await waiting.stop();
  expect(told[0].meta.status).toBe('awaiting_sign_in');
  expect(told[0].content).toMatch(/waiting for a sign-in to Kolab at .* that another Konjir channel started in the browser, and picks it up by itself once it is done\. If none finishes, tell the user to run konjir login --url/);
  marker.release('other-bridge');
  expect((await server.kolab.db.query(`select count(*)::int as n from oauth_client`)).rows).toStrictEqual([{ n: 0 }]);

  await expect(bridgeAuth('http://kolab.example/mcp', {}, io)).rejects.toThrow(/only over https, or http on this machine: http:\/\/kolab\.example\/mcp is http to another host/);
  expect((await bridgeAuth('http://kolab.example/mcp', { KONJIR_TOKEN: 'kjs_t' }, io)).token).toBe('kjs_t');   // a hand-issued token, as before

  logs.length = 0;
  await bridgeAuth(server.url, { CI: 'true' }, { ...io, open: undefined });
  expect(logs.join('\n')).toMatch(/no browser can be opened here \(CI, SSH or no display\): run konjir login --url/);
  expect(browserAvailable({}, 'darwin')).toBe(true);
  expect(browserAvailable({ SSH_CONNECTION: '1 2 3 4' }, 'darwin')).toBe(false);
  expect(browserAvailable({}, 'linux')).toBe(false);
  expect(browserAvailable({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true);
  await server.close();
});

test('Kolab closing the stream while the bridge refreshes: the refresh keeps its lock, the CLI uses the newer tokens, and nothing is revoked', async () => {
  const { kolab, server, konjirLogin } = await kolabWithSignIn();
  await konjirLogin({ as: 'new-agent', agent_label: 'cli', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s' });
  const agent = await kolabClient(server.url, new StoredLogin(server.url));
  const ann = await specInReview(server.url, kolab, agent);
  // The bridge's token requests take 1.5 s: long enough for Kolab to close its stream, and the CLI to need a token, meanwhile.
  let refreshing = 0;
  const slow: typeof fetch = async (input, init) => {
    if (String(input instanceof Request ? input.url : input).endsWith('/oauth/token')) {
      refreshing++;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return fetch(input, init);
  };
  const messages: ChannelMessage[] = [];
  const logs: string[] = [];
  const bridge = new KolabBridge({
    url: server.url, login: new StoredLogin(server.url), fetch: slow as never,
    forward: async (m) => { messages.push(m); }, log: (l) => logs.push(l),
    backoff: { initialMs: 100, maxMs: 400 }, liveness: { intervalMs: 150, timeoutMs: 5000 },
  });
  let listens = 0;
  bridge.onListening = () => { listens++; };
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  await until('the first listen', () => listens === 1 || undefined);
  const before = saved(server.url);

  // The token expires: the bridge's next liveness check starts a refresh, holding the lock.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'ann-cli' and ended_at is null`);
  await until('the bridge refreshing', () => refreshing > 0 || undefined);
  // Meanwhile a change: Kolab closes the bridge's stream (its token has expired), and the bridge's connection ends.
  await call(ann, 'ask', { address: 'kj:orders#R8', question: 'Asked mid-refresh?' });
  // The CLI needs a token now too: it waits for the bridge's refresh and uses its tokens, refreshing nothing itself.
  expect(await call(agent, 'whoami')).toMatchObject({ actor: 'ann-cli' });
  const after = saved(server.url);
  expect(after.refresh_token).not.toBe(before.refresh_token);
  await until('the listen after the refresh', () => listens >= 2 || undefined, 20_000, () => logs.join('\n'));
  await until('the question', () => messages.find((m) => m.content.includes('"Asked mid-refresh?"')), 20_000, () => logs.join('\n'));
  // One refresh token at a time: the grant stands, and the tokens kept are the newest, which both use.
  expect((await kolab.db.query(`select revoked_at from oauth_grant where actor_id = 'ann-cli'`)).rows).toStrictEqual([{ revoked_at: null }]);
  expect(await call(await kolabClient(server.url, new StoredLogin(server.url)), 'whoami')).toMatchObject({ actor: 'ann-cli' });
  expect(() => statSync(`${credentials}.lock`)).toThrow();
  await bridge.stop();
  await server.close();
}, 60_000);

test('a crashed bridge\'s stale .signing-in marker is broken, and the next bridge signs in; a marker that is a symbolic link is said as it is', async () => {
  const { idp, server } = await kolabWithSignIn();
  const marker = `${credentials}.signing-in`;
  const logs: string[] = [];
  // A marker a bridge left when it was killed, untouched for two minutes.
  mkdirSync(join(credentials, '..'), { recursive: true });
  writeFileSync(marker, 'b999_dead');
  const old = new Date(Date.now() - 120_000);
  utimesSync(marker, old, old);
  idp.next({ subject: '41', login: 'ann' });
  const auth = await bridgeAuth(server.url, {}, {
    forward: async () => undefined, log: (l) => logs.push(l),
    open: (u) => browse(u, { as: 'new-agent', agent_label: 'channel', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'product' }).then(() => undefined),
  });
  expect(logs.join('\n')).toMatch(/signed in to .* as ann-channel/);
  expect(auth.login?.signedIn).toBe(true);
  expect(() => statSync(marker)).toThrow();   // let go once done

  // A marker that is a symbolic link is never followed, and the log says why rather than blame another channel.
  writeFileSync(credentials, JSON.stringify({}));
  symlinkSync(join(credentials, '..', 'nowhere'), marker);
  logs.length = 0;
  const refused = await bridgeAuth(server.url, {}, { forward: async () => undefined, log: (l) => logs.push(l), open: () => { throw new Error('opened'); } });
  expect(logs.join('\n')).toMatch(/the channel can't sign in by itself \(.*is a symbolic link.*\); run konjir login --url/);
  expect(refused.awaiting).toBeUndefined();
  unlinkSync(marker);
  await server.close();
}, 60_000);

test('the backoff returns to its first step only after a stream that lived steadyMs; shorter ones keep doubling', async () => {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'channel-backoff-admin', kolab, webRoot: null });
  closeAtEnd(server);
  const admin = await kolabClient(server.url, 'channel-backoff-admin');
  await call(admin, 'admin_add_actor', { id: 'pm' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'pm' });
  const { token } = await call(admin, 'admin_open_session', { actor: 'pm', role: 'product' }) as { token: string };
  // Each listen stream is cut by the "network" after its lifetime here: three short, one long, then short again.
  const lifetimes = [50, 50, 50, 1200, 50];
  const starts: number[] = [];
  const ends: number[] = [];
  const cut: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (typeof init?.body !== 'string' || !init.body.includes('"method":"subscriptions/listen"') || !res.body) return res;
    const life = lifetimes[starts.length] ?? 60_000;
    starts.push(Date.now());
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        setTimeout(() => { ends.push(Date.now()); void reader.cancel().catch(() => undefined); try { c.close(); } catch { /* closed */ } }, life).unref();
        void (async () => { for (;;) { const r = await reader.read().catch(() => ({ done: true as const, value: undefined })); if (r.done) break; try { c.enqueue(r.value); } catch { break; } } })();
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
  const bridge = new KolabBridge({ url: server.url, token, fetch: cut as never, forward: async () => undefined, log: () => undefined, backoff: { initialMs: 200, maxMs: 5000, steadyMs: 800 } });
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  await until('five streams', () => starts.length >= 5 || undefined, 20_000);
  await bridge.stop();
  // The gap after a stream's end is the delay plus a reconnect: 200, 400 and 800 ms after the short ones, 200 after the long one.
  // The steps are wide enough that a reconnect slowed by a busy machine (CI runs the projects in parallel) doesn't blur them.
  const gap = (i: number) => starts[i + 1] - ends[i];
  expect(gap(1)).toBeGreaterThanOrEqual(390);
  expect(gap(2)).toBeGreaterThanOrEqual(790);
  expect(gap(3)).toBeLessThan(gap(2) - 300);
  expect(gap(3)).toBeGreaterThanOrEqual(195);
  await server.close();
}, 60_000);

test('W3.8 done when: with only the bridge configured, as konjir connect claude writes it (KONJIR_AGENT), Claude Code calls Kolab\'s tools and hears its channel on one sign-in, through an access token expiring mid-session, and no session ends another', async () => {
  const { kolab, idp, server } = await kolabWithSignIn();
  // konjir connect claude signs the entry in as its own agent, kept apart from the CLI's sign-in.
  const agentFile = agentCredentialsPath('ann-claude');
  idp.next({ subject: '41', login: 'ann' });
  await login(server.url, {
    path: agentFile, clientName: CLIENT_NAME, scope: 'konjir role:product', log: () => undefined,
    open: (u) => { void browse(u, { as: 'new-agent', agent_label: 'claude', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'product' }); },
  });
  expect(existsSync(credentials)).toBe(false);   // the CLI's own sign-in is untouched: there is none

  const transport = new StdioClientTransport({
    command: START,
    env: { PATH: process.env.PATH ?? '', HOME: scratchHome(), XDG_CONFIG_HOME: scratchHome(), KONJIR_URL: server.url, KONJIR_TOKEN: '', KONJIR_AGENT: 'ann-claude', KONJIR_SCOPE: 'konjir kolab:anns role:product agent:ann-claude', KONJIR_CREDENTIALS: credentials, KONJIR_CHANNEL_SIGN_IN: 'off', KONJIR_CHANNEL_BACKOFF_MS: '100,1000' },
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

  // The agent works through the bridge's tools: the same session the channel listens as.
  expect((await claude.listTools()).tools.map((t) => t.name)).toContain('konjir_instructions');
  expect(await call(claude, 'whoami')).toMatchObject({ actor: 'ann-claude', kolab: 'anns', role: 'product' });
  await listening(1);
  expect(stderr).toMatch(/using the sign-in kept for ann-claude at/);
  await call(claude, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(claude, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(claude, 'submit_for_review', { node: 'orders', version: 1 });
  const product = await kolabClient(server.url, await annAs(kolab, 'product'));
  await call(product, 'review', { node: 'orders', version: 1, verdict: 'approve' });
  await product.close();
  const ann = await kolabClient(server.url, await annAs(kolab, 'engineer'));
  await call(ann, 'ask', { address: 'kj:orders#R8', question: 'From which statuses?' });
  await until('the question', () => messages.find((m) => m.content.includes('"From which statuses?"')), 20_000, more);

  // The access token expires mid-session. The next call is refused (401) before it runs, refreshed
  // under the lock and sent again, once; the channel reconnects with the refreshed token.
  const keptRefresh = () => JSON.parse(readFileSync(agentFile, 'utf8'))[server.url].tokens.refresh_token as string;
  const before = keptRefresh();
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'ann-claude' and ended_at is null`);
  await call(claude, 'ask', { address: 'kj:orders#R8', question: 'Is a note enough here?', kind: 'note' });
  expect(keptRefresh()).not.toBe(before);   // refreshed, and kept in the agent's own file
  const mine = JSON.stringify(await call(claude, 'list_queries', { all: true }));
  expect(mine.split('Is a note enough here?').length - 1).toBe(1);   // sent once: one note
  await call(ann, 'ask', { address: 'kj:orders#R8', question: 'And refunds?' });
  await until('the question after the expiry', () => messages.find((m) => m.content.includes('"And refunds?"')), 40_000, more);
  expect(await call(claude, 'whoami')).toMatchObject({ actor: 'ann-claude' });

  // One sign-in, one grant, never revoked; one open session; nothing told the session it was signed out.
  expect((await kolab.db.query(`select revoked_at from oauth_grant where actor_id = 'ann-claude'`)).rows).toStrictEqual([{ revoked_at: null }]);
  expect((await kolab.db.query(`select count(*)::int as n from session where actor_id = 'ann-claude' and ended_at is null`)).rows).toStrictEqual([{ n: 1 }]);
  expect(messages.filter((m) => m.meta.kind === 'bridge')).toStrictEqual([]);
  expect(JSON.stringify(messages) + stderr).not.toMatch(/\bkj[src]_[A-Za-z0-9_-]{8,}/);
  await claude.close();
  await server.close();
}, 180_000);

test('W3.8: with KONJIR_AGENT, a sign-in kept for that agent that works as anyone else is refused whole: one message, nothing served, nothing heard', async () => {
  const { kolab, idp, server } = await kolabWithSignIn();
  const env = { KONJIR_CREDENTIALS: credentials };
  // The file for ann-claude holds a sign-in as another agent of Ann's (chosen otherwise at consent).
  const path = agentCredentials('ann-claude', env);
  idp.next({ subject: '41', login: 'ann' });
  await login(server.url, {
    path, clientName: CLIENT_NAME, log: () => undefined,
    open: (u) => { void browse(u, { as: 'new-agent', agent_label: 'other', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'product' }); },
  });
  const messages: ChannelMessage[] = [];
  const logs: string[] = [];
  const auth = await bridgeAuth(server.url, { ...env, KONJIR_URL: server.url, KONJIR_AGENT: 'ann-claude', KONJIR_CHANNEL_SIGN_IN: 'off' }, { forward: async (m) => { messages.push(m); }, log: (l) => logs.push(l) });
  expect(auth.agent).toBe('ann-claude');
  let listens = 0;
  const bridge = new KolabBridge({ url: server.url, ...auth, forward: async (m) => { messages.push(m); }, log: (l) => logs.push(l), backoff: { initialMs: 100, maxMs: 200 }, passthrough: { connectWaitMs: 300 } });
  bridge.onListening = () => { listens++; };
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  const told = await until('the refusal', () => messages.find((m) => m.meta.status === 'wrong_actor'));
  expect(told.content).toContain('The Konjir channel\'s sign-in for ann-claude works as ann-other, not ann-claude, so it serves no Konjir tools and hears no inbox changes.');
  expect(told.content).toContain(`KONJIR_CREDENTIALS=${path} konjir login --url ${server.url} --agent ann-claude`);
  await new Promise((r) => setTimeout(r, 600));   // retried, and said once
  expect(messages.filter((m) => m.meta.status === 'wrong_actor')).toHaveLength(1);
  expect(listens).toBe(0);
  expect(await bridge.list('tools', 100)).toStrictEqual([]);
  expect(await rejection(bridge.forward('tools/call', { name: 'konjir_whoami', arguments: {} }))).toMatch(/its sign-in works as ann-other, not ann-claude/);
  await bridge.stop();

  // KONJIR_TOKEN with KONJIR_AGENT: a token that works as anyone else is refused the same way.
  const other = await kolab.openSession('ann', 'product', { kolab: 'anns' });
  const byToken = await bridgeAuth(server.url, { KONJIR_TOKEN: other, KONJIR_AGENT: 'ann-claude' }, { forward: async () => undefined, log: () => undefined });
  expect(byToken).toStrictEqual({ token: other, agent: 'ann-claude' });
  const said: ChannelMessage[] = [];
  const tokenBridge = new KolabBridge({ url: server.url, ...byToken, forward: async (m) => { said.push(m); }, log: () => undefined, backoff: { initialMs: 100, maxMs: 200 }, passthrough: { connectWaitMs: 100 } });
  closeAtEnd({ close: () => tokenBridge.stop() });
  tokenBridge.start();
  const refused = await until('the token refused', () => said.find((m) => m.meta.status === 'wrong_actor'));
  expect(refused.content).toContain('KONJIR_TOKEN works as ann, not ann-claude (KONJIR_AGENT)');
  expect(await tokenBridge.list('tools', 100)).toStrictEqual([]);
  await tokenBridge.stop();
  await server.close();
}, 60_000);

test('W3.8: KONJIR_SCOPE keeps only konjir, kolab:, role: and agent: words, never as:self, and with KONJIR_AGENT no other agent', () => {
  expect(scopeFrom({ KONJIR_SCOPE: 'konjir kolab:anns role:product agent:ann-pm as:self openid' })).toBe('konjir kolab:anns role:product agent:ann-pm');
  expect(scopeFrom({ KONJIR_SCOPE: 'konjir kolab:anns agent:ann-dev', KONJIR_AGENT: 'ann-pm' })).toBe('konjir kolab:anns');
  expect(scopeFrom({ KONJIR_SCOPE: 'konjir agent:ann-pm', KONJIR_AGENT: 'ann-pm' })).toBe('konjir agent:ann-pm');
  expect(scopeFrom({})).toBeUndefined();
});

test('W3.8: konjir keeps an agent\'s sign-in only in an agents/ folder of its own: made 0700, tightened if looser, and refused as a symbolic link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-agents-'));
  const env = { KONJIR_CREDENTIALS: join(dir, 'credentials.json') };
  expect(agentCredentials('ann-pm', env)).toBe(join(dir, 'agents', 'ann-pm.json'));
  expect(statSync(join(dir, 'agents')).mode & 0o777).toBe(0o700);
  chmodSync(join(dir, 'agents'), 0o777);
  agentCredentials('ann-pm', env);
  expect(statSync(join(dir, 'agents')).mode & 0o777).toBe(0o700);
  const other = mkdtempSync(join(tmpdir(), 'konjir-agents-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'konjir-elsewhere-'));
  symlinkSync(elsewhere, join(other, 'agents'));
  expect(() => agentCredentials('ann-pm', { KONJIR_CREDENTIALS: join(other, 'credentials.json') })).toThrow(/isn't a folder of konjir's \(it is a symbolic link, or not a folder\)/);
  expect(() => agentCredentials('../ann', env)).toThrow(/isn't an agent's id/);
});
