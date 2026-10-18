// Self-serve onboarding over HTTP (W3.4; P15, D55), with a stub identity provider in GitHub's place:
// a new person signs up and makes their first kolab at the consent page, invites a teammate with a
// link from the web page, and the teammate joins with it, signed out (through the consent page) or
// signed in. The invite rides only the web interface's own sign-in, in a cookie only Kolab's
// sign-in reads, and every refusal says nothing of why.
import { request } from 'node:http';
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { StubIdentity, startServer } from '../src/server.js';

async function serve(kolab: Kolab) {
  const identity = new StubIdentity();
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null, identity });
  closeAtEnd(server);
  return { base: new URL(server.url).origin, idp: identity };
}

/** A browser: a cookie jar (paths aside), following redirects within Kolab. */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly set: string[] = [];
  constructor(readonly base: string) {}
  async fetch(url: string | URL, init: RequestInit = {}) {
    const headers = { ...(init.headers as Record<string, string> | undefined), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    const res = await fetch(new URL(url, this.base), { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      this.set.push(c);
      const kv = c.split(';')[0];
      const name = kv.slice(0, kv.indexOf('=')).trim();
      const value = kv.slice(kv.indexOf('=') + 1).trim();
      if (!value || /max-age=0/i.test(c)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return res;
  }
  async go(url: string | URL, init?: RequestInit) {
    let at = new URL(url, this.base);
    let res = await this.fetch(at, init);
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
      at = new URL(res.headers.get('location')!, at);
      res = await this.fetch(at);
    }
    return { res, at };
  }
  /** The web API, as the page calls it: from Kolab's own origin. */
  api(path: string, body?: unknown) {
    return this.fetch(`/api/${path}`, body === undefined
      ? { headers: { origin: this.base } }
      : { method: 'POST', headers: { origin: this.base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  consent(form: Record<string, string>) {
    return this.go('/oauth/consent', { method: 'POST', headers: { origin: this.base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  }
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

/** Signs `login` in to the web page with the identity provider, consenting as `form` says; returns the consent page it saw. */
async function webSignIn(b: Browser, idp: StubIdentity, who: { subject: string; login: string }, form: (html: string) => Record<string, string>) {
  idp.next(who);
  const html = await (await b.go('/api/session/oauth/start')).res.text();
  await b.consent({ csrf: csrfOf(html), decision: 'allow', ...form(html) });
  return html;
}

test('from nothing: a new person signs up and makes their first kolab, invites a teammate with a link, and the teammate joins with it, signed out', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);

  // Ann is new: the consent page offers her first kolab, named after her.
  const ann = new Browser(base);
  const first = await webSignIn(ann, idp, { subject: '21', login: 'ann' }, () => ({ kolab: '@new', new_kolab_name: 'ann', new_kolab_title: 'Ann\'s', role: 'product' }));
  expect(first).toContain('Welcome: you are <code>ann</code> here');
  expect(first).toMatch(/name="new_kolab_name" value="ann"/);
  expect(await (await ann.api('me')).json()).toMatchObject({ actor: 'ann', kolab: 'ann', access: { level: 'admin' } });

  // She invites an engineer.
  const made = await ann.api('invites', { level: 'write', layers: ['technical'] });
  expect(made.status).toBe(201);
  const { token, invite } = await made.json() as { token: string; invite: { id: string } };
  expect(token).toMatch(/^kji_/);
  expect(await (await ann.api('invites')).json()).toMatchObject({ invites: [{ id: invite.id, state: 'open', level: 'write', layers: ['technical'] }] });

  // Eli opens the link, signed out: the page shows what it offers, and Kolab keeps it for the sign-in.
  const eli = new Browser(base);
  const opened = await eli.api('session/invite', { token });
  expect(opened.status).toBe(200);
  expect(await opened.json()).toMatchObject({ kolab: 'ann', title: 'Ann\'s', owner: 'ann', level: 'write', layers: ['technical'], invited_by: 'ann' });
  expect(eli.set.at(-1)).toMatch(/^konjir_invite=kji_[^;]+; Path=\/oauth; HttpOnly; SameSite=Lax; Max-Age=1800$/);
  // Signing in, the consent page offers to join, chosen already; he consents as an engineer.
  const page = await webSignIn(eli, idp, { subject: '22', login: 'eli' }, () => ({ kolab: '@invite', role: 'engineer' }));
  expect(page).toMatch(/value="@invite" checked><span>Join <code>ann<\/code>/);
  expect(page).toContain('ann invites you, with Write on technical');
  expect(eli.cookies.has('konjir_invite')).toBe(false);   // used up, and cleared
  expect(await (await eli.api('me')).json()).toMatchObject({ actor: 'eli', kolab: 'ann', role: 'engineer', access: { level: 'write', layers: ['technical'] } });
  expect(await (await ann.api('invites')).json()).toMatchObject({ invites: [{ id: invite.id, state: 'accepted', accepted_by: 'eli' }] });

  // The link is spent: opening it again is refused, and clears the cookie.
  const again = new Browser(base);
  const spent = await again.api('session/invite', { token });
  expect(spent.status).toBe(404);
  expect((await spent.json() as { message: string }).message).toMatch(/unknown, already used, revoked or expired/);
  expect(again.set.at(-1)).toMatch(/^konjir_invite=; .*Max-Age=0$/);
});

test('a signed-in person joins with a link from the page; only Admin invites, and a revoked invite is gone', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const ann = new Browser(base);
  await webSignIn(ann, idp, { subject: '21', login: 'ann' }, () => ({ kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'product' }));
  const fay = new Browser(base);
  await webSignIn(fay, idp, { subject: '23', login: 'fay' }, () => ({ kolab: '@new', new_kolab_name: 'fays', new_kolab_title: 'Fay\'s', role: 'engineer' }));

  const { token } = await (await ann.api('invites', { level: 'write', layers: ['functional'] })).json() as { token: string };
  const joined = await fay.api('session/invite/accept', { token });
  expect(joined.status).toBe(200);
  expect(await joined.json()).toMatchObject({ actor: 'fay', kolab: 'anns', role: 'engineer', access: { level: 'write', layers: ['functional'] } });
  expect(await (await fay.api('me')).json()).toMatchObject({ kolab: 'anns' });   // the cookie holds the new session

  // Fay holds Write in anns, not Admin: she invites nobody there, and sees no invites.
  expect((await fay.api('invites', { level: 'read' })).status).toBe(403);
  expect((await fay.api('invites')).status).toBe(403);
  // Nor is Admin anyone's to give by invite.
  expect((await ann.api('invites', { level: 'admin' })).status).toBe(400);

  const second = await (await ann.api('invites', { level: 'read' })).json() as { token: string; invite: { id: string } };
  expect((await ann.api(`invites/${second.invite.id}/revoke`, {})).status).toBe(204);
  expect((await new Browser(base).api('session/invite', { token: second.token })).status).toBe(404);
  expect((await fay.api('session/invite/accept', { token: second.token })).status).toBe(400);
  // Signed out, accepting is refused outright.
  expect((await new Browser(base).api('session/invite/accept', { token: second.token })).status).toBe(401);
});

test('the invite rides only the web interface\'s sign-in; opening a link needs Kolab\'s own origin, and is limited per address', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const ann = new Browser(base);
  await webSignIn(ann, idp, { subject: '21', login: 'ann' }, () => ({ kolab: '@new', new_kolab_name: 'anns', new_kolab_title: 'Ann\'s', role: 'product' }));
  const { token } = await (await ann.api('invites', { level: 'read' })).json() as { token: string };

  // A browser holding the invite authorizes an MCP client: its consent page offers no invite.
  const eli = new Browser(base);
  await eli.api('session/invite', { token });
  const client = (await kolab.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  idp.next({ subject: '22', login: 'eli' });
  const u = new URL('/oauth/authorize', base);
  u.search = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: 'http://127.0.0.1:9/cb', state: 's', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' }).toString();
  const html = await (await eli.go(u)).res.text();
  expect(html).toContain('name="csrf"');
  expect(html).not.toContain('value="@invite"');
  // …and choosing it anyway is refused, saying so.
  const forced = await eli.consent({ csrf: csrfOf(html), decision: 'allow', as: 'new-agent', agent_label: 'cli', kolab: '@invite', role: 'product' });
  expect(await forced.res.text()).toContain('this sign-in carries no invite');
  expect(await kolab.reachable('eli')).toStrictEqual([]);

  // From another origin, or none, opening a link is refused.
  const evil = await fetch(`${base}/api/session/invite`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  expect(evil.status).toBe(403);
  expect(evil.headers.getSetCookie()).toStrictEqual([]);
  // 30 a minute from one address, counted before the database is asked: Eli's one above, and 29 more.
  const statuses = [];
  for (let i = 0; i < 30; i++) statuses.push((await new Browser(base).api('session/invite', { token: 'kji_nope' })).status);
  expect(statuses.slice(0, 29).every((s) => s === 404)).toBe(true);
  expect(statuses[29]).toBe(429);
});

test('the invite cookie goes with Decline, Not now and sign-out; Join is chosen already only for someone with no kolab; a kolab called invite or new can be chosen', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const ann = new Browser(base);
  await webSignIn(ann, idp, { subject: '21', login: 'ann' }, () => ({ kolab: '@new', new_kolab_name: 'invite', new_kolab_title: 'Called invite', role: 'product' }));
  expect(await (await ann.api('me')).json()).toMatchObject({ kolab: 'invite' });
  const link = async () => (await (await ann.api('invites', { level: 'read' })).json() as { token: string }).token;

  // Decline.
  const eli = new Browser(base);
  await eli.api('session/invite', { token: await link() });
  expect(eli.cookies.has('konjir_invite')).toBe(true);
  idp.next({ subject: '22', login: 'eli' });
  const html = await (await eli.go('/api/session/oauth/start')).res.text();
  await eli.consent({ csrf: csrfOf(html), decision: 'deny' });
  expect(eli.cookies.has('konjir_invite')).toBe(false);
  // Not now.
  await eli.api('session/invite', { token: await link() });
  expect((await eli.fetch('/api/session/invite', { method: 'DELETE', headers: { origin: base } })).status).toBe(204);
  expect(eli.cookies.has('konjir_invite')).toBe(false);
  // Sign-out.
  await webSignIn(eli, idp, { subject: '22', login: 'eli' }, () => ({ kolab: '@new', new_kolab_name: 'new', new_kolab_title: 'Called new', role: 'product' }));
  expect(await (await eli.api('me')).json()).toMatchObject({ kolab: 'new' });
  await eli.api('session/invite', { token: await link() });
  expect((await eli.fetch('/api/session', { method: 'DELETE', headers: { origin: base } })).status).toBe(204);
  expect(eli.cookies.has('konjir_invite')).toBe(false);

  // Eli has a kolab now: the invite is offered, not chosen, and the kolab called `new` is his to pick.
  await eli.api('session/invite', { token: await link() });
  idp.next({ subject: '22', login: 'eli' });
  const page = await (await eli.go('/api/session/oauth/start')).res.text();
  expect(page).toContain('value="@invite">');
  expect(page).not.toMatch(/value="@invite" checked/);
  expect(page).toContain('value="kolab:new">');
  expect(page).not.toMatch(/name="kolab" value="[^"]*" checked/);   // nothing chosen for him
  const none = await eli.consent({ csrf: csrfOf(page), decision: 'allow', role: 'engineer' });
  expect(await none.res.text()).toContain('Choose the kolab to work in.');
  await eli.consent({ csrf: csrfOf(page), decision: 'allow', kolab: 'kolab:new', role: 'engineer' });
  expect(await (await eli.api('me')).json()).toMatchObject({ kolab: 'new', role: 'engineer' });
  // Ann, in the kolab called `invite`, signs in again and chooses it by name.
  idp.next({ subject: '21', login: 'ann' });
  const again = await (await ann.go('/api/session/oauth/start')).res.text();
  await ann.consent({ csrf: csrfOf(again), decision: 'allow', kolab: 'kolab:invite', role: 'engineer' });
  expect(await (await ann.api('me')).json()).toMatchObject({ kolab: 'invite', role: 'engineer' });
});

test('behind the TLS proxy the invite cookie is __Host-: Secure, Path=/, no Domain', async () => {
  const kolab = await openKolab();
  const { createServer } = await import('node:http');
  const port = await new Promise<number>((resolve) => { const t = createServer().listen(0, '127.0.0.1', () => { const p = (t.address() as { port: number }).port; t.close(() => resolve(p)); }); });
  closeAtEnd(await startServer({ adminToken: 'admin-token', kolab, port, webRoot: null, publicHost: 'kolab.example.com', identity: new StubIdentity() }));
  const { actor } = await kolab.signInWith({ provider: 'stub', subject: '21', login: 'ann' });
  await kolab.makeOwnKolab(actor, 'anns', 'Ann\'s');
  const { token } = await kolab.createInvite(await kolab.openSession(actor, 'product', { kolab: 'anns' }), { level: 'read' });
  const cookies = await new Promise<string[]>((resolve, reject) => {
    const body = JSON.stringify({ token });
    const r = request({ host: '127.0.0.1', port, path: '/api/session/invite', method: 'POST', headers: { host: 'kolab.example.com', origin: 'https://kolab.example.com', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (x) => { x.resume(); resolve(x.headers['set-cookie'] ?? []); });
    r.on('error', reject);
    r.end(body);
  });
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatch(/^__Host-konjir_invite=kji_[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800$/);
});
