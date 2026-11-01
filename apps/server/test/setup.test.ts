// A setup (konjir connect, Lee's instruction of 2026-11-01): one page, locked to the kolab and
// agents its scope names, which makes and grants them on Allow; its code buys a setup token that is
// no session, and that token, used once, has Kolab issue each agent the person allowed its own
// sign-in, to the setup's client alone. Over HTTP, with the stub identity provider in GitHub's place.
import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { StubIdentity, startServer } from '../src/server.js';

const CB = 'http://127.0.0.1:9/cb';
const VERIFIER = 'v'.repeat(43);
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const ANN = { subject: '41', login: 'ann' };

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

async function register(base: string, redirectUris = [CB]) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'konjir connect', redirect_uris: redirectUris }) });
  return (await r.json() as { client_id: string }).client_id;
}

const setupScope = (kolab: string, agents: string[]) => ['konjir', `kolab:${kolab}`, ...agents.map((a) => `setup:${a}`)].join(' ');

/** Ann signs in at the stub, and arrives at the setup page for `scope`; `decision` is what she then clicks, if anything. */
async function setupPage(base: string, idp: StubIdentity, client: string, scope: string, o: { decision?: 'allow' | 'deny'; redirect?: string; who?: typeof ANN } = {}) {
  const browser = new Browser(base);
  idp.next(o.who ?? ANN);
  const u = new URL('/oauth/authorize', base);
  u.search = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: o.redirect ?? CB, state: 'st', code_challenge: s256(VERIFIER), code_challenge_method: 'S256', resource: `${base}/mcp`, scope }).toString();
  const page = await browser.go(u);
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(page.html)?.[1] ?? '';
  // The form as the page sends it: its sign-in, its token, and the digest of what it showed.
  const post = (decision: 'allow' | 'deny', extra: Record<string, string> = {}) => browser.go('/oauth/consent', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: field('csrf'), sign_in: field('sign_in'), shown: field('shown'), decision, ...extra }).toString(),
  });
  if (!o.decision) return { page, post, browser, field };
  return { page, post, browser, field, done: await post(o.decision) };
}

const tokenFor = async (base: string, client: string, code: string, verifier = VERIFIER) => {
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: CB, code_verifier: verifier }).toString() });
  return { status: r.status, body: await r.json() as Record<string, string> };
};

type Minted = { person: string; kolab: { id: string; made: boolean }; agents: { label: string; agent: string; role: string; made: boolean; access_token?: string; refresh_token?: string; scope?: string }[]; error?: string; error_description?: string };
const useSetup = async (base: string, bearer: string | undefined, client: string, mint = true) => {
  const r = await fetch(`${base}/oauth/setup`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ client_id: client, mint }) });
  return { status: r.status, body: await r.json() as Minted };
};

const initialize = (mcp: string, bearer: string) => fetch(mcp, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
}).then((r) => r.status);

/** What a setup page lists: each <dd> it names, with what it says of it. */
const listed = (html: string) => [...html.matchAll(/<dd><code>([^<]+)<\/code>[^<]*<small>(.*?)<\/small><\/dd>/g)].map((m) => `${m[1]}: ${m[2].replace(/<[^>]+>/g, '')}`);

/** A whole setup, allowed: the page, the code, the setup token and what it issued. */
async function allowSetup(base: string, idp: StubIdentity, client: string, scope: string, mint = true) {
  const { page, done } = await setupPage(base, idp, client, scope, { decision: 'allow' });
  const code = done!.left?.searchParams.get('code');
  if (!code) throw new Error(`no code: ${done!.res.status} ${done!.html.slice(0, 600)}`);
  const t = await tokenFor(base, client, code);
  const used = await useSetup(base, t.body.access_token, client, mint);
  return { page: page.html, code, setupToken: t.body.access_token, exchanged: t.body, used };
}

test('a setup: one page names the new kolab and each new agent, nothing to choose; Allow makes and grants them all, five agents at once; its token is no session, and, used once, issues each agent its own sign-in to the setup\'s client alone', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  const client = await register(base);
  const other = await register(base);
  const scope = setupScope('anns', ['writer:product', 'reviewer:product', 'builder:engineer', 'engineer:engineer', 'approver:engineer']);

  const { page, done } = await setupPage(base, idp, client, scope, { decision: 'allow' });
  expect(/<title>([^<]*)<\/title>/.exec(page.html)?.[1]).toBe('Set up Konjir · Kolab');
  expect(page.html).toContain('<h1>Set up 5 agents in <code>anns</code></h1>');
  expect(page.html).not.toMatch(/type="(radio|text)"/);
  expect(listed(page.html)).toStrictEqual(['anns: New: made now, private, yours', ...['writer', 'reviewer', 'builder', 'engineer', 'approver'].map((l) => `ann-${l}: New: made now`)]);
  expect(page.html).toContain('<code>ann-builder</code> as Engineer');
  const code = done!.left!.searchParams.get('code')!;
  expect(done!.left!.origin + done!.left!.pathname).toBe(CB);
  expect(done!.left!.searchParams.get('state')).toBe('st');

  // Made and granted, as the page said: the kolab private and Ann's, each agent hers, with Write there.
  expect(await kolab.listActors({ owner: 'ann' })).toHaveLength(5);
  expect((await kolab.db.query(`select owner_id, visibility from kolab where id = 'anns'`)).rows).toStrictEqual([{ owner_id: 'ann', visibility: 'private' }]);
  expect(await kolab.access('ann-approver', 'anns')).toMatchObject({ level: 'write' });

  // The code, once, with PKCE, by its own client: a setup token, no refresh token, and no session.
  expect((await tokenFor(base, other, code)).status).toBe(400);
  expect((await tokenFor(base, client, code, 'w'.repeat(43))).status).toBe(400);
  const t = await tokenFor(base, client, code);
  expect(t.status).toBe(200);
  expect(t.body).toStrictEqual({ access_token: expect.stringMatching(/^kjs_/), token_type: 'Bearer', expires_in: 300, scope });
  expect(await initialize(mcp, t.body.access_token)).toBe(401);
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant`)).rows[0]).toStrictEqual({ n: 0 });

  // Nothing but the setup token, by its own client, reaches /oauth/setup.
  const ann = await kolab.openSession('ann', 'product', { kolab: 'anns' });
  expect((await useSetup(base, ann, client)).body.error).toBe('invalid_grant');   // a person's own session
  expect((await useSetup(base, undefined, client)).status).toBe(400);
  expect((await useSetup(base, t.body.access_token, other)).body.error).toBe('invalid_grant');
  expect((await useSetup(base, 'admin-token', client)).body.error).toBe('invalid_grant');

  // Used once: each agent the page named, and no other, signed in as itself, issued to this client.
  const used = await useSetup(base, t.body.access_token, client);
  expect(used.status).toBe(200);
  expect(used.body.person).toBe('ann');
  expect(used.body.kolab).toStrictEqual({ id: 'anns', made: true });
  expect(used.body.agents.map((a) => [a.agent, a.role, a.made, a.scope])).toStrictEqual([
    ['ann-writer', 'product', true, 'konjir kolab:anns role:product'], ['ann-reviewer', 'product', true, 'konjir kolab:anns role:product'],
    ['ann-builder', 'engineer', true, 'konjir kolab:anns role:engineer'], ['ann-engineer', 'engineer', true, 'konjir kolab:anns role:engineer'],
    ['ann-approver', 'engineer', true, 'konjir kolab:anns role:engineer'],
  ]);
  for (const a of used.body.agents) {
    expect(await initialize(mcp, a.access_token!)).toBe(200);
    expect(await kolab.sessionInfo(a.access_token!)).toMatchObject({ actor: a.agent, kolab: 'anns', role: a.role });
  }
  expect((await kolab.db.query(`select distinct client_id, person_id from oauth_grant`)).rows).toStrictEqual([{ client_id: client, person_id: 'ann' }]);
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant where actor_id = 'ann'`)).rows[0]).toStrictEqual({ n: 0 });
  // Its refresh token works as any agent's, by the setup's client only.
  const refresh = (c: string) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: used.body.agents[0].refresh_token!, client_id: c }).toString() }).then((r) => r.status);
  expect(await refresh(other)).toBe(400);
  expect(await refresh(client)).toBe(200);
  // Used up: never again; the agents' sign-ins stand.
  expect((await useSetup(base, t.body.access_token, client)).body.error).toBe('invalid_grant');
  expect(await initialize(mcp, used.body.agents[1].access_token!)).toBe(200);

  // A setup token revoked before its use does nothing: /oauth/revoke takes it, by its own client.
  const { done: again } = await setupPage(base, idp, client, scope, { decision: 'allow' });
  const fresh = await tokenFor(base, client, again!.left!.searchParams.get('code')!);
  const revoke = (c: string) => fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: fresh.body.access_token, client_id: c }).toString() });
  await revoke(other);   // another client's revoke changes nothing (RFC 7009 §2.1)
  expect((await kolab.db.query(`select count(*)::int as n from oauth_setup where revoked_at is not null`)).rows[0]).toStrictEqual({ n: 0 });
  await revoke(client);
  expect((await useSetup(base, fresh.body.access_token, client)).body.error).toBe('invalid_grant');
  expect(await initialize(mcp, used.body.agents[1].access_token!)).toBe(200);
});

test('a setup for a kolab and agents Ann has: the page says so, with what she holds; allowed, they are reused and signed in afresh, ending their sessions elsewhere; without mint, nothing is issued', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  const client = await register(base);
  // Ann reaches Rae's kolab through a grant: Write on the functional layer only.
  await kolab.addActor('rae', { by: 'kolab' });
  await kolab.createKolab('raes', { owner: 'rae', title: 'Rae\'s', by: 'kolab' });
  await kolab.signInWith({ provider: 'stub', ...ANN });
  await kolab.grant('raes', 'ann', 'write', { layers: ['functional'], by: 'kolab' });
  const first = await allowSetup(base, idp, client, setupScope('raes', ['pm:product']));
  expect(listed(first.page)).toStrictEqual(['raes: Yours, existing: you hold Write on functional', 'ann-pm: New: made now']);
  expect(first.page).toContain('<code>raes</code> Rae&#39;s');
  expect(first.used.body.kolab).toStrictEqual({ id: 'raes', made: false });
  // Never more than Ann holds there (D30).
  expect(await kolab.access('ann-pm', 'raes')).toStrictEqual({ level: 'write', layers: ['functional'] });
  const before = first.used.body.agents[0].access_token!;
  expect(await initialize(mcp, before)).toBe(200);

  // Again: existing, signed in elsewhere; allowed, the same agent, signed in afresh; the old session ends (ENF4).
  const again = await allowSetup(base, idp, client, setupScope('raes', ['pm:product']));
  expect(listed(again.page)).toStrictEqual(['raes: Yours, existing: you hold Write on functional', 'ann-pm: Yours, existing, signed in elsewhere now: allowing this ends that session.']);
  expect(again.used.body.agents[0]).toMatchObject({ agent: 'ann-pm', made: false });
  expect(await initialize(mcp, before)).toBe(401);
  expect(await initialize(mcp, again.used.body.agents[0].access_token!)).toBe(200);
  expect(await kolab.listActors({ owner: 'ann' })).toHaveLength(1);

  // Without mint (OpenCode's entries sign in by themselves): what was set up, and no sign-in issued.
  const quiet = await allowSetup(base, idp, client, setupScope('raes', ['pm:product', 'dev:engineer']), false);
  expect(quiet.used.body.agents).toStrictEqual([
    { label: 'pm', agent: 'ann-pm', role: 'product', made: false },
    { label: 'dev', agent: 'ann-dev', role: 'engineer', made: true },
  ]);
  expect(await initialize(mcp, again.used.body.agents[0].access_token!)).toBe(200);   // untouched
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant where actor_id = 'ann-dev'`)).rows[0]).toStrictEqual({ n: 0 });
});

test('a setup that can\'t be allowed says why on the page, with Deny alone; Allow posted anyway makes nothing; Deny tells the app why. A kolab someone else holds, a reserved or too long new name, an agent name not free, past the cap, not on this computer', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  await kolab.addActor('rae', { by: 'kolab' });
  await kolab.createKolab('raes', { owner: 'rae', by: 'kolab' });
  const why = async (scope: string, c = client, redirect?: string) => {
    const { page } = await setupPage(base, idp, c, scope, { redirect });
    expect(page.html).toContain('<h1>This setup can\'t be allowed</h1>');
    expect(page.html).not.toContain('value="allow"');
    return /<p class="err" role="alert">([^<]*)<\/p>/.exec(page.html)?.[1].replace(/&#39;/g, '\'');
  };
  expect(await why(setupScope('raes', ['pm:product']))).toBe('a kolab named raes already exists, and you can\'t reach it: kolab names are unique across Konjir. Choose another name, or ask its owners to invite you. You reach no kolab yet.');
  expect(await why(setupScope('konjir-site', ['pm:product']))).toBe('the kolab name konjir-site is reserved for Konjir\'s own kolabs: choose another');
  expect(await why(setupScope('x'.repeat(41), ['pm:product']))).toMatch(/can't be a new kolab's name: up to 40/);
  expect(await why('konjir kolab:anns setup:pm:product agent:rae-x role:product')).toMatch(/the app asked for a setup Kolab can't do: it mixes a setup with a single sign-in/);
  // A hosted app: never, however it names things.
  const hosted = await register(base, ['https://app.example/cb']);
  expect(await why(setupScope('anns', ['pm:product']), hosted, 'https://app.example/cb')).toBe('a setup is only for an app on your own computer, such as konjir connect, and this one receives its answer elsewhere');

  // Allow posted anyway: refused, and nothing made. Deny: the app is told why.
  const allowed = await setupPage(base, idp, client, setupScope('raes', ['pm:product']), { decision: 'allow' });
  expect(allowed.done!.res.status).toBe(400);
  expect(allowed.done!.html).toContain('a kolab named raes already exists');
  expect(await kolab.listActors({ owner: 'ann' })).toStrictEqual([]);
  const denied = await setupPage(base, idp, client, setupScope('raes', ['pm:product']), { decision: 'deny' });
  expect(denied.done!.left!.searchParams.get('error')).toBe('access_denied');
  expect(denied.done!.left!.searchParams.get('error_description')).toBe('the setup can\'t be allowed: a kolab named raes already exists, and you can\'t reach it: kolab names are unique across Konjir. Choose another name, or ask its owners to invite you. Kolab\'s page in your browser lists the kolabs you do reach: run konjir connect again with one of their names');
  const plain = await setupPage(base, idp, client, setupScope('anns', ['pm:product']), { decision: 'deny' });
  expect(plain.done!.left!.searchParams.get('error_description')).toBe('the person declined');
  expect((await kolab.db.query(`select count(*)::int as n from kolab where id = 'anns'`)).rows[0]).toStrictEqual({ n: 0 });

  // An agent name that isn't Ann's to take: a person called ann-pm signed up first.
  await kolab.addActor('ann-pm', { by: 'kolab' });
  expect(await why(setupScope('anns', ['pm:product']))).toBe('the name ann-pm isn\'t available: choose another label for that agent');
  // An archived agent of hers keeps its name (D52).
  await kolab.addOwnAgent('ann', 'old', { pool: true });
  await kolab.archive({ actor: 'ann-old' }, { by: 'kolab' });
  expect(await why(setupScope('anns', ['old:product']))).toBe('your agent ann-old is archived, and its name stays its own (D52): choose another label for it');
  // The cap on live agents holds: 8 live, and 3 more would be past 10.
  for (const l of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) await kolab.addOwnAgent('ann', l, { pool: true });
  expect(await why(setupScope('anns', ['x:product', 'y:product', 'z:engineer']))).toMatch(/^you have 8 live agents, and this would make 3 more: a person has at most 10 here/);
  // …while a setup that makes only what fits, or reuses them, goes ahead.
  const fits = await allowSetup(base, idp, client, setupScope('anns', ['a:product', 'x:product', 'y:engineer']));
  expect(fits.used.body.agents.map((a) => [a.agent, a.made])).toStrictEqual([['ann-a', false], ['ann-x', true], ['ann-y', true]]);
});

test('setups that make agents count once each against a rate of their own: three in ten minutes, then a fourth that makes one is refused, and one that makes none goes ahead', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  for (const [k, labels] of [['one', ['a:product', 'b:product', 'c:engineer', 'd:engineer']], ['two', ['e:product']], ['three', ['f:product']]] as const) {
    expect((await allowSetup(base, idp, client, setupScope(k, labels as unknown as string[]))).used.status).toBe(200);
  }
  expect(await kolab.listActors({ owner: 'ann' })).toHaveLength(6);   // past addOwnAgent's 3 in 10 minutes, one at a time
  const { page } = await setupPage(base, idp, client, setupScope('one', ['g:product']));
  expect(page.html).toContain('you ran 3 setups that made agents in the last 10 minutes; wait a while before making more');
  expect((await allowSetup(base, idp, client, setupScope('one', ['a:product', 'e:engineer']))).used.status).toBe(200);
});

test('a setup\'s code used twice revokes the setup and every sign-in it issued; a setup token expires', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  const client = await register(base);
  const s = await allowSetup(base, idp, client, setupScope('anns', ['pm:product', 'dev:engineer']));
  for (const a of s.used.body.agents) expect(await initialize(mcp, a.access_token!)).toBe(200);
  expect((await tokenFor(base, client, s.code)).status).toBe(400);
  for (const a of s.used.body.agents) expect(await initialize(mcp, a.access_token!)).toBe(401);
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant where revoked_at is null`)).rows[0]).toStrictEqual({ n: 0 });

  // A setup token past its time does nothing.
  const { done } = await setupPage(base, idp, client, setupScope('anns', ['pm:product']), { decision: 'allow' });
  const t = await tokenFor(base, client, done!.left!.searchParams.get('code')!);
  await kolab.db.query(`update oauth_setup set token_expires_at = now() - interval '1 second'`);
  expect((await useSetup(base, t.body.access_token, client)).body.error).toBe('invalid_grant');
});

test('a name and title swapped when the kolab was made (Lee\'s m5-check): the setup page points it out, naming the person\'s own kolabs and nobody else\'s', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  await kolab.signInWith({ provider: 'stub', ...ANN });
  // On the web form, the name and title went into each other's boxes.
  await kolab.makeOwnKolab('ann', 'm5-check', 'm5-check-ann');
  await kolab.makeOwnKolab('ann', 'brisket', 'brisket');
  await kolab.addActor('rae', { by: 'kolab' });
  await kolab.createKolab('raes-secret', { owner: 'rae', title: 'm5-check-ann', by: 'kolab' });

  // A new kolab of that name would be made: the page says which of hers is titled so, before Allow.
  const { page } = await setupPage(base, idp, client, setupScope('m5-check-ann', ['pm:product']));
  expect(page.html).toContain('value="allow"');
  const note = /<p class="err" role="alert">([^<]*)<\/p>/.exec(page.html)?.[1].replace(/&#39;/g, '\'').replace(/&quot;/g, '"');
  expect(note).toBe('You have no kolab named m5-check-ann, so allowing this makes a new one. Did you mean m5-check? Its title is m5-check-ann; its name is what --kolab takes. If you did, choose Deny and run konjir connect again with --kolab m5-check.');
  expect(page.html).not.toContain('raes-secret');

  // Someone else's kolab of that name: refused. Her page names hers, the one titled so first;
  // the app, at its redirect URI, is told only that, never her list.
  await kolab.createKolab('m5-check-ann', { owner: 'rae', by: 'kolab' });
  const refused = await setupPage(base, idp, client, setupScope('m5-check-ann', ['pm:product']));
  const why = /<p class="err" role="alert">([^<]*)<\/p>/.exec(refused.page.html)?.[1].replace(/&#39;/g, '\'').replace(/&quot;/g, '"');
  expect(why).toBe('a kolab named m5-check-ann already exists, and you can\'t reach it: kolab names are unique across Konjir. Choose another name, or ask its owners to invite you. Did you mean m5-check? Its title is m5-check-ann; its name is what --kolab takes. Yours: brisket, m5-check (titled "m5-check-ann").');
  const denied = await refused.post('deny');
  const told = denied.left!.searchParams.get('error_description')!;
  expect(told).toBe('the setup can\'t be allowed: a kolab named m5-check-ann already exists, and you can\'t reach it: kolab names are unique across Konjir. Choose another name, or ask its owners to invite you. Kolab\'s page in your browser lists the kolabs you do reach, and one whose title is that name: run konjir connect again with one of their names');
  expect(told).not.toMatch(/brisket|m5-check[^-]|Yours/);
});

test('the web sign-in page\'s new-kolab form says which box is the name konjir connect --kolab takes, and an empty title takes the name', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  const { page } = await setupPage(base, idp, client, 'konjir');
  expect(page.html).toContain('<strong>Name</strong>: its address, unique across Konjir, the one <code>konjir connect --kolab</code> takes.');
  expect(page.html).toContain('<strong>Title</strong>: what people read. Leave it empty to use the name.');
  // A new kolab with its title left empty, from a sign-in of its own.
  const browser = new Browser(base);
  idp.next(ANN);
  const u = new URL('/oauth/authorize', base);
  u.search = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: CB, state: 'st', code_challenge: s256(VERIFIER), code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'konjir' }).toString();
  const shown = await browser.go(u);
  const f = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(shown.html)?.[1] ?? '';
  const done = await browser.go('/oauth/consent', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: f('csrf'), sign_in: f('sign_in'), decision: 'allow', as: 'new-agent', agent_label: 'cli', kolab: '@new', new_kolab_name: 'linkly-ann', new_kolab_title: '', role: 'product' }).toString(),
  });
  expect(done.left?.searchParams.get('code')).toBeTruthy();
  expect((await kolab.db.query(`select title from kolab where id = 'linkly-ann'`)).rows).toStrictEqual([{ title: 'linkly-ann' }]);
});

test('a Deny while Allow is being carried out is refused, and a setup that made agents always counts toward the rate: Deny and Allow at once, either way', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  for (let round = 0; round < 3; round++) {
    const scope = setupScope(`race-${round}`, [`r${round}:product`]);
    const { page, browser, field } = await setupPage(base, idp, client, scope);
    const binding = [...browser.cookies].find(([k]) => k.startsWith('konjir_oauth_'))![1];
    const [allow, deny] = await Promise.allSettled([kolab.consentSetup(binding, field('csrf'), field('shown')), kolab.declineAuthorization(binding, field('csrf'))]);
    expect(page.html).toContain('value="allow"');
    const made = (await kolab.listActors({ owner: 'ann' })).some((a) => a.id === `ann-r${round}`);
    if (allow.status === 'fulfilled') {
      // Allowed: the Deny found it claimed, and declined nothing; the setup is recorded.
      expect(deny).toStrictEqual({ status: 'fulfilled', value: undefined });
      expect(made).toBe(true);
    } else {
      // Denied first: nothing made, and no setup recorded.
      expect(deny.status === 'fulfilled' && deny.value).toBeTruthy();
      expect(made).toBe(false);
    }
    // Whatever happened, every agent a setup made is in a setup's row, so the rate sees it.
    expect((await kolab.db.query(`select count(*)::int as n from actor a where a.owner_id = 'ann' and not exists (select 1 from oauth_setup s where s.person_id = 'ann' and s.agents @> jsonb_build_array(jsonb_build_object('agent', a.id)))`)).rows[0]).toStrictEqual({ n: 0 });
  }
  // A claimed sign-in, as one being allowed: no Deny, no page for it, and the browser is told so.
  const { browser, field, post } = await setupPage(base, idp, client, setupScope('claimed', ['c:product']));
  const binding = [...browser.cookies].find(([k]) => k.startsWith('konjir_oauth_'))![1];
  await kolab.db.query(`update oauth_request set claimed_at = now()`);
  expect(await kolab.declineAuthorization(binding, field('csrf'))).toBeUndefined();
  expect(await kolab.pendingAuthorization(binding)).toBeUndefined();
  const refused = await post('deny');
  expect(refused.res.status).toBe(400);
  expect(refused.html).toContain('This sign-in is being allowed right now');
});

test('two setups at once can\'t both pass the rate: at the third, of two posted together one makes its agent and the other is refused', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  for (const k of ['one', 'two']) expect((await allowSetup(base, idp, client, setupScope(k, [`${k}:product`]))).used.status).toBe(200);
  const a = await setupPage(base, idp, client, setupScope('one', ['x:product']));
  const b = await setupPage(base, idp, client, setupScope('one', ['y:product']));
  const both = await Promise.all([a.post('allow'), b.post('allow')]);
  expect(both.filter((d) => d.left?.searchParams.get('code'))).toHaveLength(1);
  const other = both.find((d) => !d.left)!;
  expect(other.res.status).toBe(400);
  expect(other.html).toContain('you ran 3 setups that made agents in the last 10 minutes');
  expect((await kolab.listActors({ owner: 'ann' })).map((x) => x.id).filter((id) => id === 'ann-x' || id === 'ann-y')).toHaveLength(1);
  expect((await kolab.db.query(`select count(*)::int as n from oauth_setup where made_agents > 0`)).rows[0]).toStrictEqual({ n: 3 });
});

test('Allow carries out what the page showed: a setup that changed since (its kolab made meanwhile) is refused, and nothing is made', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  const { page, post } = await setupPage(base, idp, client, setupScope('anns', ['pm:product']));
  expect(listed(page.html)).toStrictEqual(['anns: New: made now, private, yours', 'ann-pm: New: made now']);
  // Meanwhile the kolab is made, in another tab, say: the page showed it new.
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  const done = await post('allow');
  expect(done.res.status).toBe(400);
  expect(done.html).toContain('the setup changed since this page was shown: deny it, and run konjir connect again');
  expect(await kolab.listActors({ owner: 'ann' })).toStrictEqual([]);
  // Without the digest at all (a hand-made form): refused the same.
  const bare = await setupPage(base, idp, client, setupScope('anns', ['pm:product']));
  expect((await bare.post('allow', { shown: '' })).html).toContain('the setup changed since this page was shown');
  expect((await kolab.db.query(`select count(*)::int as n from oauth_setup`)).rows[0]).toStrictEqual({ n: 0 });
});

test('Allow posted for a hosted client\'s setup is refused at consent too, and makes nothing', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const hosted = await register(base, ['https://app.example/cb']);
  const { page, post } = await setupPage(base, idp, hosted, setupScope('anns', ['pm:product']), { redirect: 'https://app.example/cb' });
  expect(page.html).not.toContain('value="allow"');
  const done = await post('allow');
  expect(done.res.status).toBe(400);
  expect(done.html).toContain('a setup is only for an app on your own computer');
  expect(await kolab.listActors({ owner: 'ann' })).toStrictEqual([]);
  expect((await kolab.db.query(`select count(*)::int as n from kolab where id = 'anns'`)).rows[0]).toStrictEqual({ n: 0 });
});

test('a setup\'s code replayed before its token is used: the token it bought does nothing, and no agent is signed in', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  const client = await register(base);
  const { done } = await setupPage(base, idp, client, setupScope('anns', ['pm:product']), { decision: 'allow' });
  const code = done!.left!.searchParams.get('code')!;
  const first = await tokenFor(base, client, code);
  expect(first.status).toBe(200);
  expect((await tokenFor(base, client, code)).status).toBe(400);
  expect((await useSetup(base, first.body.access_token, client)).body.error).toBe('invalid_grant');
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant`)).rows[0]).toStrictEqual({ n: 0 });
});
