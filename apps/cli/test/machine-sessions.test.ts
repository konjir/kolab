// W6.1's done-when, end to end (D103, ENF4, DEL7): a person signed in as themselves on two
// machines (two konjir installs, each with its own credentials file and so its own registered
// client) and in a browser keeps all three sessions working at once, calls and listen streams
// alike; signing in again on one ends only that one, and closes only its streams; the person lists
// the three, from the CLI and the web page, and revoking one ends it and closes its streams while
// the others go on. The identity provider is a stub in GitHub's place.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { StubIdentity, startServer } from '@konjir/server';
import type { OwnSession } from '@konjir/types';
import { call, connect, login } from '../src/cli.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const INBOX = 'konjir://inbox/test/functional';

/** The person's browser: a cookie jar, following Kolab's redirects, and stopping at one that leaves it. */
class Browser {
  readonly jar = new Map<string, string>();
  constructor(readonly base: string) {}
  async fetch(url: string | URL, init: RequestInit = {}) {
    const res = await fetch(new URL(url, this.base), {
      ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const [name, value] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)];
      if (!value || /max-age=0/i.test(c)) this.jar.delete(name); else this.jar.set(name, value);
    }
    return res;
  }
  async go(start: URL | string, init?: RequestInit) {
    let url = new URL(start, this.base);
    let res = await this.fetch(url, init);
    while (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location')!, url);
      if (next.origin !== url.origin) return { res, url: next, left: true };
      url = next;
      res = await this.fetch(url);
    }
    return { res, url, left: false };
  }
  /** Through Kolab's sign-in to its consent page, and allows it as `form` says; returns where it went next. */
  async consent(start: URL | string, form: Record<string, string>) {
    const page = await this.go(start);
    const html = await page.res.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    const signIn = /name="sign_in" value="([^"]+)"/.exec(html)?.[1];
    if (!csrf) throw new Error(`no consent page at ${page.url.pathname}: ${page.res.status}`);
    return this.go(new URL('/oauth/consent', this.base), {
      method: 'POST', headers: { origin: this.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, sign_in: signIn ?? '', decision: 'allow', ...form }).toString(),
    });
  }
  api(path: string, init: RequestInit = {}) {
    return this.fetch(`/api/${path}`, { ...init, headers: { origin: this.base, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  }
}

/** The web page's event stream, read as it arrives: open until Kolab ends it. */
async function webStream(browser: Browser) {
  const res = await browser.api('events');
  expect(res.status).toBe(200);
  let text = '';
  let ended = false;
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
  })().catch(() => undefined).finally(() => { ended = true; });
  await until('the web stream to be ready', () => text.includes('"ready"'));
  return { text: () => text, ended: () => ended, done };
}

async function until(what: string, check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** How a listen stream closed, or 'open' if it is still open after `ms`. */
const settled = (closed: Promise<unknown>, ms: number) => Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), ms).unref())]);

test('a person signed in on two machines and in a browser keeps all three; signing in again on one ends only that one; they list the three and revoke one (W6.1, D103)', async () => {
  const kolab = await openKolab();
  await kolab.addOrganization('test-org');
  await kolab.createKolab('test', { owner: 'test-org' });
  // A spec to ask about, committed before Ana holds Write (so no review waits), and an engineer to ask.
  await kolab.addActor('pat');
  await kolab.grant('test', 'pat', 'write', { layers: ['functional'] });
  const pat = await kolab.openSession('pat', 'product', { kolab: 'test' });
  await kolab.createNode(pat, 'spec', 'Orders', 'orders');
  await kolab.commit(pat, 'orders', { elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  await kolab.addActor('eng');
  await kolab.grant('test', 'eng', 'write', { layers: ['technical'] });
  const eng = await kolab.openSession('eng', 'engineer', { kolab: 'test' });
  const { actor: ana } = await kolab.signInWith({ provider: 'stub', subject: '61', login: 'ana' });
  await kolab.grant('test', ana, 'write');
  const idp = new StubIdentity();
  const server = await startServer({ adminToken: 'machines-admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  const base = new URL(server.url).origin;

  // Two machines: two konjir installs, each its own credentials file, each signing in as Ana herself.
  const machine = (name: string) => join(mkdtempSync(join(tmpdir(), `konjir-${name}-`)), 'credentials.json');
  const signIn = async (path: string) => {
    idp.next({ subject: '61', login: 'ana' });
    const me = await login(server.url, { path, log: () => undefined, open: (u) => { void new Browser(base).consent(u, { as: 'self', kolab: 'kolab:test', role: 'product' }).then((r) => (r.left ? fetch(r.url) : undefined)); } });
    const kept = JSON.parse(readFileSync(path, 'utf8'))[server.url] as { client: { client_id: string }; tokens: { access_token: string } };
    const client = await connect(server.url, kept.tokens.access_token);
    closeAtEnd(client);
    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (n) => { updates.push(n.params.uri); });
    return { me, client, updates, clientId: kept.client.client_id, token: kept.tokens.access_token };
  };
  const laptop = machine('laptop');
  const desktop = machine('desktop');
  const a = await signIn(laptop);
  const b = await signIn(desktop);
  expect([a.me, b.me]).toStrictEqual([expect.objectContaining({ actor: 'ana', kind: 'person', kolab: 'test' }), expect.objectContaining({ actor: 'ana', kind: 'person', kolab: 'test' })]);
  expect(a.clientId).not.toBe(b.clientId);

  // And the browser, through Kolab's own web client: a machine of its own too.
  const browser = new Browser(base);
  idp.next({ subject: '61', login: 'ana' });
  await browser.consent('/api/session/oauth/start', { kolab: 'kolab:test', role: 'product' });
  expect([...browser.jar.keys()].sort()).toStrictEqual(['konjir_browser', 'konjir_refresh', 'konjir_session']);
  expect(await (await browser.api('me')).json()).toMatchObject({ actor: 'ana', kolab: 'test' });

  // All three work at once: calls, and their streams, each hearing what changes.
  const listenA = await a.client.listen({ resourceSubscriptions: [INBOX] });
  const listenB = await b.client.listen({ resourceSubscriptions: [INBOX] });
  const web = await webStream(browser);
  const sessionOf = async (c: Client) => ((await call(c, 'whoami')) as { session: string }).session;
  const [sa, sb] = [await sessionOf(a.client), await sessionOf(b.client)];
  expect(sa).not.toBe(sb);
  const wid = (await kolab.db.query<{ id: string }>(`select id from session where actor_id = 'ana' and ended_at is null and machine_key like 'web:%'`)).rows[0].id;
  const [heardA, heardB, heardWeb] = [a.updates.length, b.updates.length, web.text().length];
  await kolab.raiseQuery(eng, 'kj:orders#R1', 'Which orders?');
  await until('every machine to hear the question', () => a.updates.length > heardA && b.updates.length > heardB && web.text().length > heardWeb);
  expect(await call(a.client, 'whoami')).toMatchObject({ actor: 'ana' });
  expect(await call(b.client, 'whoami')).toMatchObject({ actor: 'ana' });
  expect((await browser.api('me')).status).toBe(200);

  // She lists them: from either machine, and from the web page, each marking its own.
  const listed = (await call(a.client, 'list_sessions')) as { sessions: OwnSession[] };
  const mine = listed.sessions;
  expect(mine.map((s) => s.session).sort()).toStrictEqual([sa, sb, wid].sort());
  expect(mine.find((s) => s.session === sa)).toMatchObject({ current: true, via: 'app', where: 'app "konjir CLI"', app: 'konjir CLI', kolab: 'test', role: 'product', expires_at: null });
  expect(mine.find((s) => s.session === sb)).toMatchObject({ current: false, via: 'app', where: 'app "konjir CLI"', app: 'konjir CLI' });
  expect(mine.find((s) => s.session === wid)).toMatchObject({ current: false, via: 'web', where: expect.stringMatching(/^Kolab's web page/) });
  const fromWeb = (await (await browser.api('sessions')).json()) as { sessions: OwnSession[] };
  expect(fromWeb.sessions.filter((s) => s.current).map((s) => s.session)).toStrictEqual([wid]);

  // Signing in again on the laptop ends only the laptop's old session, and closes only its stream.
  const a2 = await signIn(laptop);
  expect(a2.clientId).toBe(a.clientId);   // the same install keeps its registration: the same machine
  expect(await settled(listenA.closed, 2000)).toBe('graceful');
  expect(await settled(listenB.closed, 100)).toBe('open');
  expect(web.ended()).toBe(false);
  expect(await kolab.sessionOpen(a.token)).toBe(false);
  expect(await call(b.client, 'whoami')).toMatchObject({ actor: 'ana' });
  expect((await browser.api('me')).status).toBe(200);
  const sa2 = await sessionOf(a2.client);
  expect(((await call(a2.client, 'list_sessions')) as { sessions: OwnSession[] }).sessions.map((s) => s.session).sort())
    .toStrictEqual([sa2, sb, wid].sort());

  // Signing in again in the browser ends only the browser's.
  idp.next({ subject: '61', login: 'ana' });
  await browser.consent('/api/session/oauth/start', { kolab: 'kolab:test', role: 'product' });
  await until('the browser\'s old stream to be told', () => web.ended());
  expect(web.text()).toContain('"ended"');
  expect(await settled(listenB.closed, 100)).toBe('open');
  const wid2 = (await kolab.db.query<{ id: string }>(`select id from session where actor_id = 'ana' and ended_at is null and machine_key like 'web:%'`)).rows.map((r) => r.id);
  expect(wid2.length).toBe(1);
  expect(wid2[0]).not.toBe(wid);
  const web2 = await webStream(browser);

  // From the web page she revokes the desktop: it ends at once, its stream closes, and the others go on.
  const revoked = await browser.api(`sessions/${encodeURIComponent(sb)}/revoke`, { method: 'POST', body: '{}' });
  expect([revoked.status, await revoked.json()]).toStrictEqual([200, { ended: sb, current: false }]);
  expect(await settled(listenB.closed, 2000)).toBe('graceful');
  expect(await rejection(call(b.client, 'whoami'))).toMatch(/401|invalid_token|Unauthorized|ended/i);
  expect(await call(a2.client, 'whoami')).toMatchObject({ actor: 'ana' });
  expect((await browser.api('me')).status).toBe(200);
  expect(web2.ended()).toBe(false);
  // Its grant is revoked, as the person's: the desktop's refresh token renews nothing.
  expect((await kolab.db.query(`select g.revoked_by from session s join oauth_grant g on g.id = s.grant_id where s.id = $1`, [sb])).rows).toStrictEqual([{ revoked_by: 'ana' }]);
  // And from the laptop, the browser's: the page is told its session ended.
  expect(await call(a2.client, 'end_session', { session: wid2[0].slice(0, 10) })).toStrictEqual({ ended: wid2[0], current: false });
  await until('the browser to be told', () => web2.ended());
  expect(web2.text()).toContain('"ended"');
  expect((await browser.api('me')).status).toBe(401);
  // Anything but an open session of hers is refused alike.
  expect(await rejection(call(a2.client, 'end_session', { session: sb }))).toMatch(/you have no open session/);
  expect(await rejection(call(a2.client, 'end_session', { session: 'short' }))).toMatch(/at least its first 8 characters/);
  expect((await browser.api('sessions/nothere-at-all/revoke', { method: 'POST', body: '{}' })).status).toBe(401);
  await listenA.close().catch(() => undefined);
});
