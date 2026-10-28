// W3.4's done-when, end to end, with no admin (P15, D55): a new person signs up with one command,
// `konjir login`, choosing on Kolab's page a new agent of theirs and a first kolab of their own; the
// agent works there through the CLI, whose 15-minute token refreshes by itself; the person invites
// a teammate with a link, who joins; and `konjir logout` revokes the agent's grant. The identity
// provider is a stub in GitHub's place, and the "browser" follows Kolab's redirects with its cookies.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { StubIdentity, startServer } from '@konjir/server';
import { StoredLogin, call, connect, credentialsPath, login, logout, main } from '../src/cli.js';
import { closeAtEnd, els, openKolab, rejection } from '@konjir/engine/testing';
import { FileLock } from '../src/login.js';

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
  const signIn = /name="sign_in" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error(`no consent page at ${url.pathname}: ${res.status}`);
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, sign_in: signIn ?? '', decision: 'allow', ...form }).toString(),
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
    open: (u) => { void browse(u, { as: 'new-agent', agent_label: 'cli', kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'engineer' }).then((h) => { page = h; }); },
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
  // Ann's kolab holds its spec, which a binding names (D78).
  await kolab.db.query(`insert into node(id, name, kind, layer, title, kolab_id, created_by) values ('orders', 'orders', 'spec', 'functional', 'Orders', 'anns', 'ann')`);
  await main(['create_node', 'kind=binding', 'title=Orders on Postgres', 'id=orders-pg']);

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
  expect(await logout(server.url)).toStrictEqual({ had: false, revoked: false });
});

/** Ann signs in with konjir login, as a new agent of hers, in a first kolab. */
async function signedIn(label = 'cli') {
  const kolab = await openKolab();
  const idp = new StubIdentity();
  const server = await startServer({ adminToken: 'login-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  process.env.KONJIR_URL = server.url;
  const again = async (form: Record<string, string>) => {
    idp.next({ subject: '41', login: 'ann' });
    return login(server.url, { log: () => undefined, open: (u) => { void browse(u, { as: 'new-agent', ...form }); } });
  };
  await again({ agent_label: label, kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'engineer' });
  return { kolab, server, again };
}

test('an empty or blank KONJIR_TOKEN, or --token "", is unset: the kept sign-in is used; a real token still wins', async () => {
  const { server } = await signedIn();
  // konjir connect claude writes KONJIR_TOKEN: "" in .mcp.json; those settings copied into a shell.
  for (const blank of ['', '   ']) {
    process.env.KONJIR_TOKEN = blank;
    out = [];
    await main(['whoami']);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ actor: 'ann-cli', kolab: 'anns' });
  }
  out = [];
  await main(['--token', '', 'whoami']);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ actor: 'ann-cli' });
  // A real token wins over the kept sign-in, from KONJIR_TOKEN or --token.
  const admin = await connect(server.url, 'login-admin');
  closeAtEnd(admin);
  await call(admin, 'admin_add_actor', { id: 'bot' });
  await call(admin, 'admin_grant', { kolab: 'anns', to: 'bot', level: 'write', layers: ['functional'] });
  const { token } = (await call(admin, 'admin_open_session', { actor: 'bot', role: 'product', kolab: 'anns' })) as { token: string };
  process.env.KONJIR_TOKEN = token;
  out = [];
  await main(['whoami']);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ actor: 'bot' });
  process.env.KONJIR_TOKEN = ' ';
  out = [];
  await main(['--token', token, 'whoami']);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ actor: 'bot' });
});

test('two konjir processes refreshing one sign-in at once: both go on working, and nothing is revoked', async () => {
  // konjir's own default folder already exists, more open than it should be: konjir closes it.
  delete process.env.KONJIR_CREDENTIALS;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'konjir-xdg-'));
  mkdirSync(join(process.env.XDG_CONFIG_HOME, 'konjir'), { mode: 0o755 });
  chmodSync(join(process.env.XDG_CONFIG_HOME, 'konjir'), 0o755);
  const { kolab, server } = await signedIn();
  expect(credentialsPath()).toBe(join(process.env.XDG_CONFIG_HOME, 'konjir', 'credentials.json'));
  expect(statSync(join(credentialsPath(), '..')).mode & 0o777).toBe(0o700);
  const a = await connect(server.url, new StoredLogin(server.url));
  const b = await connect(server.url, new StoredLogin(server.url));
  closeAtEnd(a, b);
  for (let round = 0; round < 3; round++) {
    await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'ann-cli' and ended_at is null`);
    const both = await Promise.all([call(a, 'whoami'), call(b, 'whoami'), call(a, 'list_nodes'), call(b, 'list_nodes')]);
    expect(both.slice(0, 2)).toMatchObject([{ actor: 'ann-cli' }, { actor: 'ann-cli' }]);
  }
  expect((await kolab.db.query(`select revoked_at from oauth_grant where actor_id = 'ann-cli'`)).rows).toStrictEqual([{ revoked_at: null }]);
  expect(JSON.parse(readFileSync(credentialsPath(), 'utf8'))[server.url].tokens.refresh_token).toMatch(/^kjr_/);
  expect(() => statSync(`${credentialsPath()}.lock`)).toThrow();   // no lock left behind
}, 120_000);

test('konjir login again revokes the sign-in it replaces; logout that can\'t reach Kolab keeps the sign-in and says so, unless told to forget it', async () => {
  const { kolab, server, again } = await signedIn();
  const before = (await kolab.db.query<{ id: string }>(`select id from oauth_grant`)).rows.map((r) => r.id);
  await again({ agent_label: 'other', kolab: '@new', new_kolab_name: 'anns-2', new_kolab_title: 'Two', role: 'product' });
  const grants = (await kolab.db.query<{ id: string; revoked: boolean }>(`select id, revoked_at is not null as revoked from oauth_grant order by created_at`)).rows;
  expect(grants.filter((g) => before.includes(g.id)).every((g) => g.revoked)).toBe(true);
  expect(grants.filter((g) => !before.includes(g.id)).map((g) => g.revoked)).toStrictEqual([false]);

  // The same sign-in, kept for a Kolab that isn't answering.
  const gone = 'http://127.0.0.1:9/mcp';
  const all = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
  writeFileSync(credentialsPath(), JSON.stringify({ ...all, [gone]: all[server.url] }));
  expect(await rejection(logout(gone))).toMatch(/couldn't reach Kolab .* wasn't revoked and is still kept: run konjir logout again, or konjir logout --forget/);
  expect(JSON.parse(readFileSync(credentialsPath(), 'utf8'))[gone]).toBeDefined();
  expect(await logout(gone, { forget: true })).toStrictEqual({ had: true, revoked: false });
  expect(JSON.parse(readFileSync(credentialsPath(), 'utf8'))[gone]).toBeUndefined();
  expect(JSON.parse(readFileSync(credentialsPath(), 'utf8'))[server.url]).toBeDefined();   // the other Kolab's is untouched
});

test('a credentials file konjir can\'t read is never overwritten: konjir says where it is', async () => {
  const path = credentialsPath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{ not json');
  process.env.KONJIR_URL = 'http://127.0.0.1:9/mcp';
  expect(await rejection(main(['whoami']))).toContain(`${path} isn't konjir's credentials (not valid JSON), so konjir won't touch it`);
  expect(await rejection(logout('http://127.0.0.1:9/mcp'))).toContain('not valid JSON');
  expect(readFileSync(path, 'utf8')).toBe('{ not json');
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
      void browse(u, { as: 'new-agent', agent_label: 'cli', kolab: '@new', new_kolab_name: 'bos', new_kolab_title: 'Bo\'s', role: 'product' });
    },
  });
  // An admin ends the agent's session; its grant goes with it on the next refresh.
  await kolab.db.query(`update oauth_grant set revoked_at = now(), revoked_by = 'admin'`);
  await kolab.endSession({ actor: 'bo-cli' });
  expect(await rejection(main(['whoami']))).toMatch(/your sign-in to .* has ended or was revoked: run konjir login/);
});

const URL_ = 'http://127.0.0.1:9/mcp';
const tokens = (n: number) => ({ access_token: `kjs_a${n}`, refresh_token: `kjr_r${n}`, token_type: 'Bearer', expires_in: 900 });

test('a folder named through KONJIR_CREDENTIALS is never changed: konjir warns when others may write in it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-shared-'));
  chmodSync(dir, 0o777);
  process.env.KONJIR_CREDENTIALS = join(dir, 'c.json');
  const warn = console.error as unknown as jest.Mock;
  await new StoredLogin(URL_).saveTokens(tokens(1));
  expect(statSync(dir).mode & 0o777).toBe(0o777);
  expect(warn.mock.calls.flat().join('\n')).toContain(`warning: others may write in ${dir}`);
  expect(statSync(join(dir, 'c.json')).mode & 0o777).toBe(0o600);
});

test('a lock that is a dangling symbolic link, or a stale one konjir can\'t remove, ends in a clear error by the deadline, never a spin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-lock-'));
  const path = join(dir, 'c.json');
  symlinkSync(join(dir, 'nowhere'), `${path}.lock`);
  const started = Date.now();
  expect(await rejection(new StoredLogin(URL_, { path, lockWaitMs: 300 }).forget())).toMatch(/c\.json\.lock is a symbolic link, so konjir won't use it as its lock: remove it/);
  expect(Date.now() - started).toBeLessThan(5000);

  // A stale lock in a folder konjir may not change: it waits until the deadline, sleeping, then says so.
  const ro = mkdtempSync(join(tmpdir(), 'konjir-ro-'));
  const roPath = join(ro, 'c.json');
  writeFileSync(`${roPath}.lock`, 'someone-else');
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${roPath}.lock`, old, old);
  chmodSync(ro, 0o500);
  try {
    const t0 = Date.now();
    const why = await rejection(new StoredLogin(URL_, { path: roPath, lockWaitMs: 400 }).forget());
    expect(why).toMatch(/konjir couldn't take .*c\.json\.lock: its stale lock can't be removed \(EACCES\)\. If no konjir is running, remove that file|konjir couldn't take .*c\.json\.lock \(EACCES\)/);
    expect(Date.now() - t0).toBeLessThan(5000);
  } finally {
    chmodSync(ro, 0o700);
  }
});

test('a lock broken while its holder stalled: the break is atomic, the holder notices, and keeps the tokens another konjir saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-break-'));
  const lockPath = join(dir, 'x.lock');
  const a = new FileLock(lockPath, 2000);
  const b = new FileLock(lockPath, 2000);
  await a.acquire('owner-a');
  expect(a.holds('owner-a')).toBe(true);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath, old, old);
  await b.acquire('owner-b');
  expect(readFileSync(lockPath, 'utf8')).toBe('owner-b');
  expect(a.holds('owner-a')).toBe(false);
  a.release('owner-a');
  expect(readFileSync(lockPath, 'utf8')).toBe('owner-b');   // A's release leaves B's lock alone
  b.release('owner-b');

  // Two konjir refreshing: X stalls past the stale mark, Y breaks the lock, refreshes and saves.
  const path = join(dir, 'c.json');
  await new StoredLogin(URL_, { path }).saveTokens(tokens(1));
  const x = new StoredLogin(URL_, { path });
  const y = new StoredLogin(URL_, { path });
  expect((await x.tokens({}))?.refresh_token).toBe('kjr_r1');
  utimesSync(`${path}.lock`, old, old);
  expect((await y.tokens({}))?.refresh_token).toBe('kjr_r1');
  await y.saveTokens(tokens(2));
  // X wakes, with tokens from its own refresh: it doesn't save over Y's, which are the live ones.
  await x.saveTokens(tokens(3));
  expect(JSON.parse(readFileSync(path, 'utf8'))[URL_].tokens.refresh_token).toBe('kjr_r2');
  expect(() => statSync(`${path}.lock`)).toThrow();
});

test('an abandoned konjir login keeps the sign-in it would have replaced, working', async () => {
  const { kolab, server } = await signedIn();
  const before = JSON.parse(readFileSync(credentialsPath(), 'utf8'))[server.url].tokens.refresh_token;
  expect(await rejection(login(server.url, { log: () => undefined, open: () => undefined, timeoutMs: 300 }))).toMatch(/took too long/);
  expect(JSON.parse(readFileSync(credentialsPath(), 'utf8'))[server.url].tokens.refresh_token).toBe(before);
  out = [];
  await main(['whoami']);
  expect(JSON.parse(out.join('\n'))).toMatchObject({ actor: 'ann-cli' });
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant where revoked_at is null`)).rows).toStrictEqual([{ n: 1 }]);
});

test('a hold leaked by an error that escaped the SDK, in a konjir that keeps running (a watch), ends by itself: the heartbeat stops and others take the lock', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'konjir-leak-')), 'c.json');
  await new StoredLogin(URL_, { path }).saveTokens(tokens(1));
  // The watch's sign-in starts a refresh, and the error that would end it never reaches anything konjir awaits.
  const watching = new StoredLogin(URL_, { path, lockMaxHoldMs: 300 });
  expect((await watching.tokens({}))?.refresh_token).toBe('kjr_r1');
  expect(statSync(`${path}.lock`).isFile()).toBe(true);
  // Well past the cap, the process still running, the lock is gone and another konjir writes at once.
  await new Promise((r) => setTimeout(r, 700));
  expect(() => statSync(`${path}.lock`)).toThrow();
  const t0 = Date.now();
  await new StoredLogin(URL_, { path, lockWaitMs: 200 }).saveTokens(tokens(2));
  expect(Date.now() - t0).toBeLessThan(1000);
  // The leaked refresh, if it ever finishes, keeps the newer tokens rather than writing over them.
  await watching.saveTokens(tokens(3));
  expect(JSON.parse(readFileSync(path, 'utf8'))[URL_].tokens.refresh_token).toBe('kjr_r2');
});

test('konjir watch, as its stream closes at token expiry and listens again, lets go only of an idle hold, never of a refresh in flight', async () => {
  const { kolab, server } = await signedIn();   // ann-cli, an engineer in anns
  const annAs = async (role: 'product' | 'engineer') => {
    await kolab.endSession({ actor: 'ann' }).catch(() => undefined);
    return kolab.openSession('ann', role, { kolab: 'anns' });
  };
  // Ann commits a binding in anns; asking about it signals ann-cli's technical inbox.
  await kolab.createNode(await annAs('product'), 'spec', 'Orders', 'orders');   // the spec it binds (D78)
  const eng = await annAs('engineer');
  await kolab.createNode(eng, 'binding', 'Orders on Postgres', 'orders-pg');
  // It waits for ann-cli, the layer's other writer, who approves it.
  await rejection(kolab.commit(eng, 'orders-pg', { elements: els({ b1: 'orders.status allows cancel from Open.' }) }));
  await main(['review', 'node=orders-pg', 'version=1', 'verdict=approve']);
  const ask = async (q: string) => kolab.raiseQuery(await annAs('product'), 'kj:orders-pg#b1', q);
  const keptRefresh = () => JSON.parse(readFileSync(credentialsPath(), 'utf8'))[server.url].tokens.refresh_token as string;
  const forced = jest.spyOn(StoredLogin.prototype, 'releaseLock');
  const idle = jest.spyOn(StoredLogin.prototype, 'releaseIdleLock');
  out = [];
  let settled = false;
  const watching = main(['watch', '--once']).finally(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 1500));   // listening
  const before = keptRefresh();

  // The token expires: Kolab closes the stream before its next signal, and watch listens again, refreshing.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where actor_id = 'ann-cli' and ended_at is null`);
  await ask('Asked as the token expired?');
  const end = Date.now() + 30_000;
  while (keptRefresh() === before) {
    if (Date.now() > end) throw new Error(`watch never listened again: settled ${settled}, printed ${out.join(' | ')}, idle ${idle.mock.calls.length}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  // The stream's close let go of an idle hold only: nothing forced the lock off while watch ran.
  expect(idle).toHaveBeenCalled();
  expect(forced).not.toHaveBeenCalled();
  for (let n = 0; !settled; n++) {
    if (n > 30) throw new Error('watch heard nothing after listening again');
    await ask(`And now (${n})?`);
    await new Promise((r) => setTimeout(r, 500));
  }
  await watching;
  expect(out.some((l) => l.includes('"updated"'))).toBe(true);
  expect(forced).toHaveBeenCalledTimes(1);   // watch's own last release, once all it started has settled
  expect(() => statSync(`${credentialsPath()}.lock`)).toThrow();
  await server.close();
}, 90_000);
