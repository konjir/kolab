// A person's own sign-in that leaves the kolab to the page (Lee's instruction of 2026-11-16,
// konnect), over HTTP, with the stub identity provider in GitHub's place: `choose:kolab` lists the
// invitations waiting for the account and the person's kolabs, to accept, decline or sign in to;
// `team:<name>` makes a free kolab with no agent, signs a member in, or refuses someone else's with
// a free name. Both only for an app on the person's own computer, under the pages' strict policy and
// the consent form's origin and token checks. And GitHub's username lookup, against a fake GitHub.
import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab, type TestKolab } from '@konjir/engine/testing';
import { GitHubIdentity, StubIdentity, startServer } from '../src/server.js';

const CB = 'http://127.0.0.1:9/cb';
const VERIFIER = 'v'.repeat(43);
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const ANN = { subject: '11', login: 'ann' };
const BOB = { subject: '22', login: 'bob' };

async function serve(kolab: Kolab) {
  const idp = new StubIdentity();
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null, identity: idp });
  closeAtEnd(server);
  return { base: new URL(server.url).origin, idp };
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

async function register(base: string, redirectUris = [CB]) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'konnect', redirect_uris: redirectUris }) });
  return (await r.json() as { client_id: string }).client_id;
}

/** `who` signs in at the stub, for `scope`, and arrives at its page; `post` sends the page's form with what a button adds. */
async function page(base: string, idp: StubIdentity, client: string, scope: string, who = BOB, redirect = CB) {
  const browser = new Browser(base);
  idp.next(who);
  const u = new URL('/oauth/authorize', base);
  u.search = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, state: 'st', code_challenge: s256(VERIFIER), code_challenge_method: 'S256', resource: `${base}/mcp`, scope }).toString();
  const first = await browser.go(u);
  const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? '';
  const post = (fields: Record<string, string>, opts: { origin?: string; html?: string } = {}) => browser.go('/oauth/consent', {
    method: 'POST', headers: { origin: opts.origin ?? base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: field(opts.html ?? first.html, 'csrf'), sign_in: field(opts.html ?? first.html, 'sign_in'), ...fields }).toString(),
  });
  return { ...first, post, browser };
}

const tokenFor = async (base: string, client: string, code: string) => {
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: CB, code_verifier: VERIFIER }).toString() });
  return { status: r.status, body: await r.json() as Record<string, string> };
};

/** The buttons a page offers: each name=value. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*name="([^"]+)" value="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);

/** Ann owns `anns` and invites bob's account; Bob owns `bobs`. */
async function world(kolab: TestKolab) {
  const { actor: ann } = await kolab.signInWith({ provider: 'stub', ...ANN });
  await kolab.makeOwnKolab(ann, 'anns', 'Ann\'s');
  const { actor: bob } = await kolab.signInWith({ provider: 'stub', ...BOB });
  await kolab.makeOwnKolab(bob, 'bobs', 'Bob\'s');
  const session = await kolab.openSession(ann, 'product', { kolab: 'anns' });
  const { invited: [inv] } = await kolab.inviteAccounts(session, ['bob'], { provider: 'stub', find: async () => ({ subject: '22', login: 'bob', person: true }) });
  return { session, inv };
}

test('choose:kolab: the page lists the invitations waiting for the account and the person\'s kolabs; accepting joins and signs in there, as the person, and the token says which kolab', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const { inv } = await world(kolab);
  const client = await register(base);

  const p = await page(base, idp, client, 'konjir choose:kolab');
  expect(p.res.status).toBe(200);
  expect(/<title>([^<]*)<\/title>/.exec(p.html)?.[1]).toBe('Choose where to sign in · Kolab');
  // The pages' strict policy: nothing loaded, no script, never framed; forms to Kolab and the app's own redirect.
  const csp = p.res.headers.get('content-security-policy')!;
  expect(csp).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; form-action 'self' http:\/\/127\.0\.0\.1:9; frame-ancestors 'none'; base-uri 'none'$/);
  expect(p.html).not.toMatch(/<script/i);
  expect(p.html).toContain('<strong>konnect</strong> on this computer asks to work in Kolab as you, <code>bob</code>');
  expect(p.html).toContain('<code>anns</code> Ann&#39;s<small>ann invites you, with Read. Accept it only if you expected it.</small>');
  expect(buttons(p.html)).toStrictEqual([`pick=accept:${inv.id}`, `pick=decline:${inv.id}`, 'pick=kolab:bobs', 'decision=deny']);

  // A form from anywhere but Kolab's own page is refused, as every consent is.
  expect((await p.post({ pick: `accept:${inv.id}` }, { origin: 'https://evil.example' })).res.status).toBe(403);
  // A kolab that isn't theirs is refused, and the page shown again with the reason.
  const wrong = await p.post({ pick: 'kolab:anns' });
  expect(wrong.res.status).toBe(400);
  expect(wrong.html).toContain('you aren&#39;t a member of a kolab anns');

  const done = await p.post({ pick: `accept:${inv.id}` });
  expect(done.left?.origin + done.left!.pathname).toBe(CB);
  expect(done.left!.searchParams.get('state')).toBe('st');
  const t = await tokenFor(base, client, done.left!.searchParams.get('code')!);
  expect(t.status).toBe(200);
  expect(t.body.scope).toBe('konjir kolab:anns role:product');
  expect(await kolab.access('bob', 'anns')).toStrictEqual({ level: 'read', layers: [] });
  expect((await kolab.sessionInfo(t.body.access_token)).actor).toBe('bob');
});

test('choose:kolab: declining shows the page again without it; with nothing to offer, the page says so and how to make a team; Deny tells the app the person declined', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const { inv } = await world(kolab);
  const client = await register(base);

  const p = await page(base, idp, client, 'konjir choose:kolab');
  const declined = await p.post({ pick: `decline:${inv.id}` });
  expect(declined.res.status).toBe(200);
  expect(declined.html).toContain('You declined the invitation to anns.');
  expect(buttons(declined.html)).toStrictEqual(['pick=kolab:bobs', 'decision=deny']);
  // The same form again: declined once is declined.
  const twice = await p.post({ pick: `decline:${inv.id}` });
  expect(twice.res.status).toBe(400);
  expect(twice.html).toMatch(/that invitation isn&#39;t one waiting for you/);
  const denied = await p.post({ decision: 'deny' });
  expect(denied.left!.searchParams.get('error')).toBe('access_denied');
  expect(denied.left!.searchParams.get('error_description')).toBe('the person declined');

  // Someone new, with no invitation and no kolab.
  const q = await page(base, idp, client, 'konjir choose:kolab', { subject: '55', login: 'dee' });
  expect(q.html).toContain('No invitation waits for <code>dee</code>, and you are a member of no kolab yet.');
  expect(q.html).toContain('run <code>npx @konjir/konnect team &lt;name&gt;</code>');
  expect(buttons(q.html)).toStrictEqual(['decision=deny']);
  // Allow with nothing chosen is no choice.
  expect((await q.post({ decision: 'allow' })).res.status).toBe(400);
  // Closed, the app is told there was nothing to choose, so it can say what to do.
  const closed = await q.post({ decision: 'deny' });
  expect(closed.left!.searchParams.get('error_description')).toBe('nothing to sign in to: no invitation waits for this account, and it is a member of no kolab. Make a team, or ask a team\'s owner to invite this GitHub account');
});

test('team:<name>: a free name is made with no agent; a member is signed in; someone else\'s is refused with a free name, and the app is told so', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  await world(kolab);
  const client = await register(base);

  const make = await page(base, idp, client, 'konjir team:acme');
  expect(/<title>([^<]*)<\/title>/.exec(make.html)?.[1]).toBe('Make acme · Kolab');
  expect(make.html).toContain('<h1>Make <code>acme</code></h1>');
  expect(make.html).toContain('New: made now, private, yours. No agent is made.');
  expect(buttons(make.html)).toStrictEqual(['decision=allow', 'decision=deny']);
  expect(make.html).not.toMatch(/type="(radio|text)"/);
  const made = await make.post({ decision: 'allow', shown: 'make' });
  const t = await tokenFor(base, client, made.left!.searchParams.get('code')!);
  expect(t.body.scope).toBe('konjir kolab:acme role:product');
  expect(await kolab.kolabRow('acme')).toMatchObject({ owner: 'bob', visibility: 'private' });
  expect(await kolab.listActors({ owner: 'bob' })).toStrictEqual([]);

  const member = await page(base, idp, client, 'konjir team:acme');
  expect(member.html).toContain('<h1>Sign in to <code>acme</code></h1>');
  expect(member.html).toContain('You are a member: you hold Admin');
  // What the page showed is what Allow does: a hand-made `shown` that differs is refused.
  expect((await member.post({ decision: 'allow', shown: 'make' })).html).toContain('kolab acme changed since this page was shown');
  const signed = await member.post({ decision: 'allow', shown: 'member' });
  expect((await tokenFor(base, client, signed.left!.searchParams.get('code')!)).body.scope).toBe('konjir kolab:acme role:product');

  const theirs = await page(base, idp, client, 'konjir team:anns', { subject: '55', login: 'dee' });
  expect(theirs.html).toContain('<h1>This sign-in can\'t be allowed</h1>');
  expect(theirs.html).toContain('The name anns-dee is free.');
  expect(buttons(theirs.html)).toStrictEqual(['decision=deny']);
  // Allow from a hand-made form is refused all the same: it denies, saying why, and joins nothing.
  const forced = await theirs.post({ decision: 'allow', shown: 'member' });
  expect(forced.left!.searchParams.get('error')).toBe('access_denied');
  expect(forced.left!.searchParams.get('error_description')).toBe('the sign-in can\'t be allowed: the kolab name anns is taken, by a kolab you aren\'t a member of: names are unique across Konjir, and this sign-in never joins anyone else\'s kolab. The name anns-dee is free.');
  expect(await kolab.access('dee', 'anns')).toMatchObject({ level: null });
});

test('a sign-in that leaves the kolab to the page is only for an app on the person\'s own computer: a hosted app\'s page offers only Deny, and the app is told why', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  await world(kolab);
  const hosted = await register(base, ['https://app.example/cb']);
  for (const scope of ['konjir choose:kolab', 'konjir team:acme']) {
    const p = await page(base, idp, hosted, scope, BOB, 'https://app.example/cb');
    expect(p.html).toContain('only for an app on your own computer');
    expect(buttons(p.html)).toStrictEqual(['decision=deny']);
    const forced = await p.post({ pick: 'kolab:bobs', decision: 'allow', shown: 'make' });
    expect(forced.left!.searchParams.get('error_description')).toMatch(/^the sign-in can't be allowed: a sign-in that leaves its kolab to this page is only for an app on your own computer/);
  }
  expect(await kolab.kolabRow('acme')).toBeUndefined();
  // A scope that names it badly is refused the same way, Deny alone.
  const client = await register(base);
  const bad = await page(base, idp, client, 'konjir team:acme kolab:bobs');
  expect(bad.html).toContain('the app asked for a sign-in Kolab can&#39;t do: it mixes');
  expect(buttons(bad.html)).toStrictEqual(['decision=deny']);
  // A Konjir admin is told the app gets every admin verb.
  await kolab.makeAdmin('bob', { by: 'admin' });
  const admin = await page(base, idp, client, 'konjir team:bobs');
  expect(admin.html).toContain('You are a Konjir admin: this app can run every admin verb as you.');
});

test('GitHub\'s lookup asks GET /users/<login> as the OAuth app, for the account\'s numeric id and whether it is a person\'s; a 404 is no account, and nothing but a username reaches the path', async () => {
  const asked: { url: string; auth: string | null }[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/users/bob')) return new Response(JSON.stringify({ id: 22, login: 'Bob', type: 'User' }), { status: 200 });
    if (url.endsWith('/users/acme')) return new Response(JSON.stringify({ id: 99, login: 'acme', type: 'Organization' }), { status: 200 });
    if (url.endsWith('/users/down')) return new Response('{}', { status: 503 });
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
  const gh = new GitHubIdentity({ clientId: 'cid', clientSecret: 'secret', apiOrigin: 'https://api.github.test', fetch: fake as typeof fetch });
  expect(await gh.lookup('bob')).toStrictEqual({ subject: '22', login: 'Bob', person: true });
  expect(asked[0]).toStrictEqual({ url: 'https://api.github.test/users/bob', auth: `Basic ${Buffer.from('cid:secret').toString('base64')}` });
  expect(await gh.lookup('acme')).toStrictEqual({ subject: '99', login: 'acme', person: false });
  expect(await gh.lookup('ghost')).toBeUndefined();
  await expect(gh.lookup('down')).rejects.toThrow(/GitHub didn't say who down is \(503\)/);
  const before = asked.length;
  for (const bad of ['../orgs/x', 'a/b', 'bob?x=1', '-bob', 'a'.repeat(40)]) expect(await gh.lookup(bad)).toBeUndefined();
  expect(asked.length).toBe(before);
});
