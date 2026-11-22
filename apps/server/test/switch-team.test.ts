// One sign-in, every team (Lee's instruction of 2026-11-21, konnect's app): over HTTP, with the stub
// identity provider in GitHub's place. konnect's own app shows a person with a team a page about who
// signed in alone, and takes invitations and new teams in the app; every other client sees its page as before;
// konjir_list_my_teams lists the person's kolabs with their own unread there, as their answers count
// it and nothing of any other kolab; konjir_switch_team moves the app's grant to another of them, its
// session ended and a new one opened in one transaction, the new access token taken by a refresh.
import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { sessionKey, type Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab, type TestKolab } from '@konjir/engine/testing';
import { GitHubIdentity, StubIdentity, startServer } from '../src/server.js';

const APP = 'com.konjir.konnect:/oauth';
const CB = 'http://127.0.0.1:9/cb';
const VERIFIER = 'v'.repeat(43);
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const ANN = { subject: '11', login: 'ann' };
const BOB = { subject: '22', login: 'bob' };
const CAROL = { subject: '33', login: 'carol' };
const DAVE = { subject: '44', login: 'dave' };
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

async function register(base: string, redirectUris = [APP, 'com.konjir.konnect.dev:/oauth', 'com.konjir.konnect.preview:/oauth']) {
  const r = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'konnect', redirect_uris: redirectUris }) });
  return (await r.json() as { client_id: string }).client_id;
}

/** `who` signs in at the stub for `scope`: where Kolab's answer leaves for the app (`left`), or the page it shows instead, whose form `post` sends. */
async function signIn(base: string, idp: StubIdentity, client: string, who: { subject: string; login: string }, opts: { scope?: string; redirect?: string } = {}) {
  const browser = new Browser(base);
  idp.next(who);
  const u = new URL('/oauth/authorize', base);
  u.search = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: opts.redirect ?? APP, state: 'st', code_challenge: s256(VERIFIER), code_challenge_method: 'S256', resource: `${base}/mcp`, scope: opts.scope ?? 'konjir choose:kolab' }).toString();
  const first = await browser.go(u);
  const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? '';
  /** Sends the form of the page `html`, in this browser, with what a button adds. */
  const postOn = (html: string, fields: Record<string, string>, o: { from?: string } = {}) => browser.go('/oauth/consent', {
    method: 'POST', headers: { origin: o.from ?? base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: field(html, 'csrf'), sign_in: field(html, 'sign_in'), ...fields }).toString(),
  });
  const post = (fields: Record<string, string>, o: { from?: string } = {}) => postOn(first.html, fields, o);
  return { ...first, post, postOn };
}

const tokenEndpoint = async (base: string, form: Record<string, string>) => {
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  return { status: r.status, body: await r.json() as Record<string, string> };
};
const exchange = (base: string, client: string, code: string, redirect = APP) =>
  tokenEndpoint(base, { grant_type: 'authorization_code', code, client_id: client, redirect_uri: redirect, code_verifier: VERIFIER });
const refresh = (base: string, client: string, refreshToken: string) =>
  tokenEndpoint(base, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client });

/** The app's tokens, signed in through the app's redirect and exchanged. */
async function appTokens(base: string, idp: StubIdentity, client: string, who: { subject: string; login: string }, scope?: string) {
  const s = await signIn(base, idp, client, who, { scope });
  // The app's Continue, or a team page's Allow.
  const left = (await s.post(s.html.includes('value="continue"') ? { pick: 'continue' } : { decision: 'allow', shown: 'member' })).left!;
  const t = await exchange(base, client, left.searchParams.get('code')!);
  if (t.status !== 200) throw new Error(JSON.stringify(t.body));
  return t.body;
}

/** One request to /mcp as a 2026-07-28 client sends it, with the session's token. */
async function rpc(mcp: string, token: string, method: string, params: Record<string, unknown>): Promise<{ status: number; result?: Record<string, unknown>; error?: { message: string } }> {
  const name = typeof params.name === 'string' ? params.name : String(params.uri);
  const res = await fetch(mcp, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, 'mcp-method': method, 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }),
  });
  if (res.status !== 200) return { status: res.status };
  const text = await res.text();
  const body = JSON.parse(text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)![1]) as { result?: Record<string, unknown>; error?: { message: string } };
  return { status: 200, ...body };
}

/** A tool's structured result, or its error's text. */
async function tool(mcp: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ ok?: Record<string, unknown>; error?: string; status?: number }> {
  const r = await rpc(mcp, token, 'tools/call', { name, arguments: args });
  if (r.status !== 200) return { status: r.status };
  if (r.error) return { error: r.error.message };
  const result = r.result as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
  return result.isError ? { error: result.content[0].text } : { ok: result.structuredContent };
}

/** The person's answers resource in their session's kolab. */
async function answers(mcp: string, token: string, kolab: string, actor: string) {
  const r = await rpc(mcp, token, 'resources/read', { uri: `konjir://answers/${kolab}/${actor}` });
  const contents = (r.result as { contents: { text: string }[] }).contents;
  return JSON.parse(contents[0].text) as { messages: { unread: number }; channels: { channel: string; following: boolean; unread: number; unread_more: boolean; mentions: number; mentions_more: boolean }[] };
}

/** What konjir_list_my_teams should say of a kolab, from the answers there: DM unread plus followed channels' unread, and every channel's mentions. */
function fromAnswers(a: Awaited<ReturnType<typeof answers>>) {
  const followed = a.channels.filter((c) => c.following);
  return {
    unread: a.messages.unread + followed.reduce((n, c) => n + c.unread, 0), unread_more: followed.some((c) => c.unread_more),
    mentions: a.channels.reduce((n, c) => n + c.mentions, 0), mentions_more: a.channels.some((c) => c.mentions_more),
  };
}

/** A listen stream on `uri`, opened by hand with the token: whether it has ended. */
async function listen(mcp: string, token: string, uri: string) {
  const res = await fetch(mcp, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'subscriptions/listen' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'listen:1', method: 'subscriptions/listen', params: { _meta: META, notifications: { resourceSubscriptions: [uri] } } }),
  });
  let ended = false;
  const frames: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) frames.push(decoder.decode(chunk, { stream: true }));
    ended = true;
  })().catch(() => { ended = true; });
  return { status: res.status, ended: () => ended, frames };
}

async function until(what: string, check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Ann owns `anns`, where Bob holds Read and Dave too; Bob owns `bobs`; Carol owns `carols`, which Bob can't reach. */
async function world(kolab: TestKolab) {
  for (const who of [ANN, BOB, CAROL, DAVE]) await kolab.signInWith({ provider: 'stub', ...who });
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  await kolab.makeOwnKolab('bob', 'bobs', 'Bob\'s');
  await kolab.makeOwnKolab('carol', 'carols', 'Carol\'s');
  await kolab.grant('anns', 'bob', 'read');
  await kolab.grant('anns', 'dave', 'read');
}

/** A page's title, and every button it offers, name=value. */
const titleOf = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const buttons = (html: string) => [...html.matchAll(/<button[^>]*name="([^"]+)" value="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);

test('konnect\'s app shows a person with a team a page about who signed in alone, Continue on one button, naming and choosing no team; Continue opens where they worked last, or the first by name; an invitation waiting changes nothing; no team at all gets the chooser', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  for (const who of [ANN, BOB, CAROL, DAVE]) await kolab.signInWith({ provider: 'stub', ...who });
  await kolab.makeOwnKolab('bob', 'bobs', 'Bob\'s');
  const app = await register(base);

  const only = await signIn(base, idp, app, BOB);
  expect([only.res.status, only.left]).toStrictEqual([200, undefined]);
  expect(titleOf(only.html)).toBe('Continue as @bob · Kolab');
  expect(only.html).toContain('<h1>Continue as <code>@bob</code></h1>');
  expect(only.html).toContain('Signed in with Stub as <code>bob</code>.');
  expect(only.html).toContain(`<strong>konnect</strong> on this device asks to work in Kolab as you, <code>bob</code>, and gets its answer at <code>${APP}</code>. Its name is what it calls itself`);
  // One primary button and the other-account link, and nothing about any team.
  expect(buttons(only.html)).toStrictEqual(['pick=continue', 'pick=other-account']);
  expect(only.html.match(/class="primary"/g)).toHaveLength(1);
  expect(only.html).toContain('<button class="link" type="submit" name="pick" value="other-account">Use a different Stub account</button>');
  for (const team of ['bobs', 'Bob&#39;s', 'kolab:', 'Team', 'team you worked in', 'Choose another', 'Your kolabs']) expect([team, only.html.includes(team)]).toStrictEqual([team, false]);
  expect(only.html).not.toContain('Konjir admin');
  expect(only.res.headers.get('content-security-policy')).toContain('form-action \'self\' com.konjir.konnect:;');
  // No code until the page's own form is posted: a form from anywhere else is refused, and nothing reaches the app.
  const forged = await only.post({ pick: 'continue' }, { from: 'https://evil.example' });
  expect([forged.res.status, forged.left]).toStrictEqual([403, undefined]);
  const done = await only.post({ pick: 'continue' });
  expect(done.res.status).toBe(303);
  expect(done.left!.toString()).toMatch(/^com\.konjir\.konnect:\/oauth\?code=kjc_[^&]+&state=st&iss=/);
  const t = await exchange(base, app, done.left!.searchParams.get('code')!);
  expect([t.status, t.body.scope]).toStrictEqual([200, 'konjir kolab:bobs role:product']);
  expect((await kolab.sessionInfo(t.body.access_token)).actor).toBe('bob');
  // The same form again: used once is used.
  expect((await only.post({ pick: 'continue' })).left).toBeUndefined();

  // A second team, never worked in: Continue still opens where they worked last.
  await kolab.makeOwnKolab('ann', 'anns', 'Ann\'s');
  await kolab.grant('anns', 'bob', 'read');
  const continued = async (who: typeof BOB) => {
    const p = await signIn(base, idp, app, who);
    expect([who.login, buttons(p.html)]).toStrictEqual([who.login, ['pick=continue', 'pick=other-account']]);
    return (await exchange(base, app, (await p.post({ pick: 'continue' })).left!.searchParams.get('code')!)).body.scope;
  };
  expect(await continued(BOB)).toBe('konjir kolab:bobs role:product');
  // A session of theirs in anns, on any machine, makes anns the newest.
  await kolab.openSession('bob', 'product', { kolab: 'anns' });
  expect(await continued(BOB)).toBe('konjir kolab:anns role:product');
  // Several teams, none ever used: no chooser, the first by name.
  await kolab.makeOwnKolab('carol', 'carols', 'Carol\'s');
  await kolab.makeOwnKolab('carol', 'aardvarks', 'Aardvarks');
  expect(await continued(CAROL)).toBe('konjir kolab:aardvarks role:product');

  // An invitation waiting: the same page, no chooser and no Accept; the app takes invitations itself.
  const inCarols = await kolab.openSession('carol', 'product', { kolab: 'carols' });
  await kolab.inviteAccounts(inCarols, ['bob', 'dave'], { provider: 'stub', find: async (login) => ({ subject: login === 'bob' ? '22' : '44', login, person: true }) });
  const invited = await signIn(base, idp, app, BOB);
  expect(titleOf(invited.html)).toBe('Continue as @bob · Kolab');
  expect(buttons(invited.html)).toStrictEqual(['pick=continue', 'pick=other-account']);
  expect(invited.html).not.toContain('carols');
  expect(await kolab.access('bob', 'carols')).toMatchObject({ level: null });

  // A Konjir admin is told what the app can do, on this page too.
  await kolab.makeAdmin('bob');
  expect((await signIn(base, idp, app, BOB)).html).toContain('You are a Konjir admin: this app can run every admin verb as you.');

  // No team at all: the chooser, since a session must be in a kolab, with the invitation waiting to accept there.
  const none = await signIn(base, idp, app, DAVE);
  expect(titleOf(none.html)).toBe('Choose where to sign in · Kolab');
  const [accept] = buttons(none.html).filter((b) => b.startsWith('pick=accept:'));
  expect(accept).toBeTruthy();
  const joined = await none.post({ pick: accept.slice('pick='.length) });
  expect((await exchange(base, app, joined.left!.searchParams.get('code')!)).body.scope).toBe('konjir kolab:carols role:product');
  // And with nothing at all, it says so, and closing it tells the app there was nothing to choose, as before.
  const nothing = await signIn(base, idp, app, { subject: '55', login: 'eve' });
  expect(nothing.html).toContain('you are a member of no kolab yet');
  expect((await nothing.post({ decision: 'deny' })).left!.searchParams.get('error_description')).toMatch(/^nothing to sign in to/);
});

test('Use a different GitHub account forgets who signed in and asks the identity provider again with prompt=select_account, for the same sign-in: its client, PKCE and state, now for whoever signs in', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  await world(kolab);
  const app = await register(base);
  const p = await signIn(base, idp, app, BOB);
  expect(titleOf(p.html)).toBe('Continue as @bob · Kolab');
  expect(idp.prompts.at(-1)).toBeUndefined();
  // From anywhere but the page, refused, and nothing restarts.
  expect((await p.post({ pick: 'other-account' }, { from: 'https://evil.example' })).res.status).toBe(403);
  // From the page: back to the provider, asked to let the person choose, and its answer is Ann.
  idp.next(ANN);
  const again = await p.post({ pick: 'other-account' });
  expect(idp.prompts.at(-1)).toBe('select_account');
  expect([again.res.status, again.left]).toStrictEqual([200, undefined]);
  expect(titleOf(again.html)).toBe('Continue as @ann · Kolab');
  expect(again.html).toContain('Signed in with Stub as <code>ann</code>.');
  // Bob's form is no longer this sign-in's: Continue on it is refused, and nothing reaches the app.
  const stale = await p.post({ pick: 'continue' });
  expect([stale.res.status, stale.left]).toStrictEqual([400, undefined]);
  // Ann's Continue: the code goes to the same redirect with the client's own state, and the client's verifier exchanges it, for Ann.
  const done = await p.postOn(again.html, { pick: 'continue' });
  expect(done.left!.searchParams.get('state')).toBe('st');
  const t = await exchange(base, app, done.left!.searchParams.get('code')!);
  expect([t.status, t.body.scope]).toStrictEqual([200, 'konjir kolab:anns role:product']);
  expect((await kolab.sessionInfo(t.body.access_token)).actor).toBe('ann');

  // GitHub is asked for its account picker only then, and the page's forms may lead to it.
  const gh = new GitHubIdentity({ clientId: 'cid', clientSecret: 'secret' });
  const plain = new URL(gh.authorizationUrl({ redirectUri: `${base}/cb`, state: 's', codeChallenge: 'c' }));
  const picking = new URL(gh.authorizationUrl({ redirectUri: `${base}/cb`, state: 's', codeChallenge: 'c', prompt: 'select_account' }));
  expect([plain.searchParams.get('prompt'), picking.searchParams.get('prompt')]).toStrictEqual([null, 'select_account']);
  expect(gh.authorizationOrigin).toBe('https://github.com');
});

test('konjir_accept_invitation, konjir_decline_invitation and konjir_make_team take invitations and make teams in the app, as the sign-in page does, audited alike; refused to an agent and to any sign-in but the app\'s', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  await world(kolab);
  const inCarols = await kolab.openSession('carol', 'product', { kolab: 'carols' });
  const lookup = { provider: 'stub', find: async (login: string) => ({ subject: login === 'bob' ? '22' : '44', login, person: true }) };
  await kolab.inviteAccounts(inCarols, ['bob', 'dave'], lookup);
  await kolab.endSession(await kolab.openSession('bob', 'product', { kolab: 'bobs' }));
  const app = await register(base);
  const t = await appTokens(base, idp, app, BOB);
  expect(t.scope).toBe('konjir kolab:bobs role:product');
  const me = t.access_token;

  // Accept: Bob is a member of carols now, his session still in bobs; the switch takes it there.
  expect((await tool(mcp, me, 'konjir_accept_invitation', { kolab: 'carols' })).ok).toStrictEqual({ kolab: 'carols', role: 'product' });
  expect(await kolab.access('bob', 'carols')).toStrictEqual({ level: 'read', layers: [] });
  expect((await kolab.sessionInfo(me)).kolab).toBe('bobs');
  const listed = (await tool(mcp, me, 'konjir_list_my_teams')).ok!;
  expect([(listed.teams as { kolab: string }[]).map((x) => x.kolab), listed.invitations]).toStrictEqual([['anns', 'bobs', 'carols'], []]);
  // Accepted once is accepted; and no invitation waits for a kolab nobody invited him to, whether or not it exists.
  for (const k of ['carols', 'anns', 'nosuch', '']) {
    expect([k, (await tool(mcp, me, 'konjir_accept_invitation', { kolab: k })).error]).toStrictEqual([k, expect.stringMatching(/^TenancyError: no invitation to a kolab [^:]*waits for you: konjir_list_my_teams lists those that do\./)]);
  }
  // The same grant and audit as Dave's Accept on the sign-in page (here through the CLI's chooser).
  const cli = await register(base, [CB]);
  const page = await signIn(base, idp, cli, DAVE, { redirect: CB });
  const accept = buttons(page.html).find((b) => b.startsWith('pick=accept:'))!;
  expect((await page.post({ pick: accept.slice('pick='.length) })).left!.searchParams.get('code')).toBeTruthy();
  const audit = (await kolab.db.query<{ subject: string; action: string; kolab_id: string; done_by: string; detail: { level: string; layers: string[]; invitation: string } }>(
    `select subject, action, kolab_id, done_by, detail from audit_event where kolab_id = 'carols' and subject in ('bob', 'dave') order by subject`)).rows;
  expect(audit.map(({ detail: { invitation, ...d }, ...r }) => ({ ...r, detail: d, invitation: /^ivt_/.test(invitation) }))).toStrictEqual([
    { subject: 'bob', action: 'grant.set', kolab_id: 'carols', done_by: 'bob', detail: { level: 'read', layers: [] }, invitation: true },
    { subject: 'dave', action: 'grant.set', kolab_id: 'carols', done_by: 'dave', detail: { level: 'read', layers: [] }, invitation: true },
  ]);
  const settled = (await kolab.db.query<{ accepted_by: string }>(`select accepted_by from kolab_invitation where kolab_id = 'carols' and accepted_at is not null order by accepted_by`)).rows;
  expect(settled.map((r) => r.accepted_by)).toStrictEqual(['bob', 'dave']);

  // Decline: as Decline on the page, by him; then it is neither listed nor acceptable.
  await kolab.makeOwnKolab('carol', 'carols-2', 'Carol\'s too');
  await kolab.endSession(inCarols);
  const inCarols2 = await kolab.openSession('carol', 'product', { kolab: 'carols-2' });
  await kolab.inviteAccounts(inCarols2, ['bob'], lookup);
  expect((await tool(mcp, me, 'konjir_list_my_teams')).ok!.invitations).toMatchObject([{ kolab: 'carols-2', invited_by: 'carol' }]);
  expect((await tool(mcp, me, 'konjir_decline_invitation', { kolab: 'carols-2' })).ok).toStrictEqual({ declined: true });
  expect((await kolab.db.query(`select 1 from kolab_invitation where kolab_id = 'carols-2' and declined_by = 'bob' and declined_at is not null`)).rows).toHaveLength(1);
  expect((await tool(mcp, me, 'konjir_list_my_teams')).ok!.invitations).toStrictEqual([]);
  expect((await tool(mcp, me, 'konjir_decline_invitation', { kolab: 'carols-2' })).error).toMatch(/no invitation to a kolab carols-2 waits for you/);
  expect((await tool(mcp, me, 'konjir_accept_invitation', { kolab: 'carols-2' })).error).toMatch(/no invitation to a kolab carols-2 waits for you/);

  // Make: his, private, no agent, the session still where it was.
  expect((await tool(mcp, me, 'konjir_make_team', { name: 'acme' })).ok).toStrictEqual({ kolab: 'acme', role: 'product' });
  expect(await kolab.kolabRow('acme')).toMatchObject({ owner: 'bob', visibility: 'private' });
  expect(await kolab.listActors({ owner: 'bob' })).toStrictEqual([]);
  expect((await kolab.sessionInfo(me)).kolab).toBe('bobs');
  // As team:<name> intent:create refuses: taken, his own too, with a free name; reserved; not a name.
  expect((await tool(mcp, me, 'konjir_make_team', { name: 'acme' })).error).toMatch(/the kolab name acme is taken, by a kolab you are a member of.*The name acme-bob is free\./);
  expect((await tool(mcp, me, 'konjir_make_team', { name: 'carols' })).error).toMatch(/the kolab name carols is taken/);
  expect((await tool(mcp, me, 'konjir_make_team', { name: 'konjir-x' })).error).toMatch(/reserved/);
  expect((await tool(mcp, me, 'konjir_make_team', { name: 'Bad Name' })).error).toMatch(/can't be a kolab's name/);

  // Refused to an agent, a hand-issued session and the CLI's sign-in, each saying so, and nothing changes.
  await kolab.addOwnAgent('bob', 'bot');
  await kolab.grant('bobs', 'bob-bot', 'read');
  const agent = await kolab.openSession('bob-bot', 'product', { kolab: 'bobs' });
  const hand = await kolab.openSession('bob', 'product', { kolab: 'bobs' });
  const bobCli = await exchange(base, cli, (await (await signIn(base, idp, cli, BOB, { redirect: CB })).post({ pick: 'kolab:bobs' })).left!.searchParams.get('code')!, CB);
  await kolab.makeOwnKolab('carol', 'carols-3', 'Carol\'s third');
  await kolab.endSession(inCarols2);
  await kolab.inviteAccounts(await kolab.openSession('carol', 'product', { kolab: 'carols-3' }), ['bob'], lookup);
  const calls: [string, Record<string, string>][] = [['konjir_accept_invitation', { kolab: 'carols-3' }], ['konjir_decline_invitation', { kolab: 'carols-3' }], ['konjir_make_team', { name: 'other' }]];
  for (const [name, args] of calls) {
    expect([name, (await tool(mcp, agent, name, args)).error]).toStrictEqual([name, expect.stringMatching(/bob-bot is an agent: only a person/)]);
    expect([name, (await tool(mcp, hand, name, args)).error]).toStrictEqual([name, expect.stringMatching(/this session is no sign-in through an app/)]);
    expect([name, (await tool(mcp, bobCli.body.access_token, name, args)).error]).toStrictEqual([name, expect.stringMatching(/is for konnect's own app only/)]);
  }
  expect(await kolab.access('bob', 'carols-3')).toMatchObject({ level: null });
  expect(await kolab.kolabRow('other')).toBeUndefined();
  expect((await tool(mcp, me, 'konjir_list_my_teams')).ok!.invitations).toMatchObject([{ kolab: 'carols-3' }]);
});

test('every other client sees the page as before: konnect\'s CLI on loopback, and the app itself naming its team', async () => {
  const kolab = await openKolab();
  const { base, idp } = await serve(kolab);
  await world(kolab);
  await kolab.openSession('bob', 'product', { kolab: 'bobs' });
  const cli = await register(base, [CB]);
  const p = await signIn(base, idp, cli, BOB, { redirect: CB });
  expect(p.left).toBeUndefined();
  expect(/<title>([^<]*)<\/title>/.exec(p.html)?.[1]).toBe('Choose where to sign in · Kolab');
  expect(p.html).toContain('on this computer asks to work in Kolab as you');
  // With one team only, too.
  const solo = await signIn(base, idp, cli, CAROL, { redirect: CB });
  expect(solo.left).toBeUndefined();
  expect(solo.html).toContain('value="kolab:carols"');
  // The app naming its team signs in on the team page, Allow or Deny, as before.
  const app = await register(base);
  const team = await signIn(base, idp, app, BOB, { scope: 'konjir team:bobs intent:join' });
  expect(team.left).toBeUndefined();
  expect(team.html).toContain('<h1>Sign in to <code>bobs</code></h1>');
  // A client mixing the app's scheme with another redirect: only Deny, whatever the person has.
  const mixed = await register(base, [APP, CB]);
  const m = await signIn(base, idp, mixed, CAROL);
  expect(m.left).toBeUndefined();
  expect(m.html).toContain('only for an app on your own computer or phone');
});

test('konjir_list_my_teams: every kolab the person is a member of, with their own unread there as their answers count it, nothing of any kolab they can\'t reach; refused to an agent', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  await world(kolab);
  // Carol's kolab, where Bob was a member, and was written to, until his grant went; and a public kolab of hers.
  await kolab.makeOwnKolab('carol', 'gone', 'Gone');
  await kolab.grant('gone', 'bob', 'read');
  await kolab.createKolab('pub', { owner: 'carol', visibility: 'public' });
  const inGone = await kolab.openSession('carol', 'product', { kolab: 'gone' });
  await kolab.sendMessage(inGone, 'bob', 'in gone');
  await kolab.sendChannelMessage(inGone, 'general', 'bob, in gone', { mentions: ['bob'] });
  await kolab.revoke('gone', 'bob');
  await kolab.endSession(inGone);

  // In anns: two messages to Bob and one to Dave; three in #general, which Bob follows, one mentioning him; two in #side, which he doesn't, one mentioning him.
  const annSession = await kolab.openSession('ann', 'product', { kolab: 'anns' });
  await kolab.sendMessage(annSession, 'bob', 'one');
  await kolab.sendMessage(annSession, 'bob', 'two');
  await kolab.sendMessage(annSession, 'dave', 'for dave');
  await kolab.sendChannelMessage(annSession, 'general', 'hello');
  await kolab.sendChannelMessage(annSession, 'general', 'bob, look', { mentions: ['bob'] });
  await kolab.sendChannelMessage(annSession, 'general', 'and dave', { mentions: ['dave'] });
  await kolab.makeChannel(annSession, 'side');
  await kolab.sendChannelMessage(annSession, 'side', 'aside');
  await kolab.sendChannelMessage(annSession, 'side', 'bob, aside', { mentions: ['bob'] });

  const app = await register(base);
  await kolab.endSession(await kolab.openSession('bob', 'product', { kolab: 'bobs' }));
  const t = await appTokens(base, idp, app, BOB);
  expect(t.scope).toBe('konjir kolab:bobs role:product');
  const listed = await tool(mcp, t.access_token, 'konjir_list_my_teams');
  expect(listed.ok).toStrictEqual({
    teams: [
      { kolab: 'anns', role: 'product', owner: false, current: false, unread: 5, unread_more: false, mentions: 2, mentions_more: false },
      { kolab: 'bobs', role: 'product', owner: true, current: true, unread: 0, unread_more: false, mentions: 0, mentions_more: false },
    ],
    invitations: [],
  });
  // The same numbers as Bob's answers in each kolab, read by a session of his there.
  const inAnns = await kolab.openSession('bob', 'product', { kolab: 'anns' });
  const teams = listed.ok!.teams as { kolab: string }[];
  const { kolab: _k, role: _r, owner: _o, current: _c, ...annsCounts } = teams[0] as Record<string, unknown>;
  expect(annsCounts).toStrictEqual(fromAnswers(await answers(mcp, inAnns, 'anns', 'bob')));
  const { kolab: _k2, role: _r2, owner: _o2, current: _c2, ...bobsCounts } = teams[1] as Record<string, unknown>;
  expect(bobsCounts).toStrictEqual(fromAnswers(await answers(mcp, t.access_token, 'bobs', 'bob')));
  // Neither the kolab he left, written to while he was there, nor a public one, nor Carol's, is among them.
  expect(teams.map((x) => x.kolab)).toStrictEqual(['anns', 'bobs']);
  // Dave's are his own: his message and his mention, never Bob's.
  const daves = await tool(mcp, (await appTokens(base, idp, app, DAVE)).access_token, 'konjir_list_my_teams');
  expect(daves.ok!.teams).toStrictEqual([{ kolab: 'anns', role: 'product', owner: false, current: true, unread: 4, unread_more: false, mentions: 1, mentions_more: false }]);

  // Reading counts marks nothing: the answers still hold the same.
  expect((await answers(mcp, inAnns, 'anns', 'bob')).messages.unread).toBe(2);

  // An invitation waiting for him is listed, by who invited him and when.
  const inCarols = await kolab.openSession('carol', 'product', { kolab: 'carols' });
  const { invited: [inv] } = await kolab.inviteAccounts(inCarols, ['bob'], { provider: 'stub', find: async () => ({ subject: '22', login: 'bob', person: true }) });
  expect((await tool(mcp, t.access_token, 'konjir_list_my_teams')).ok!.invitations).toStrictEqual([{ kolab: 'carols', invited_by: 'carol', invited_at: inv.created_at }]);

  // An agent's session is refused, even its owner's agent.
  await kolab.addOwnAgent('bob', 'bot');
  await kolab.grant('bobs', 'bob-bot', 'read');
  const agent = await kolab.openSession('bob-bot', 'product', { kolab: 'bobs' });
  expect((await tool(mcp, agent, 'konjir_list_my_teams')).error).toMatch(/bob-bot is an agent: only a person lists their teams/);
  // And to any sign-in but the app's: a hand-issued session of his, or his CLI's.
  expect((await tool(mcp, inAnns, 'konjir_list_my_teams')).error).toMatch(/this session is no sign-in through an app: listing your teams is for konnect's own app/);
  const cli = await register(base, [CB]);
  const p = await signIn(base, idp, cli, BOB, { redirect: CB });
  const c = await exchange(base, cli, (await p.post({ pick: 'kolab:bobs' })).left!.searchParams.get('code')!, CB);
  expect((await tool(mcp, c.body.access_token, 'konjir_list_my_teams')).error).toMatch(/listing your teams is for konnect's own app only/);
});

test('konjir_switch_team moves the app\'s grant to another team: the session ends and its streams close, the old access token is dead, and the same refresh token signs in there', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  await world(kolab);
  const ended: string[] = [];
  kolab.onEvent((e) => { if ('session' in e && e.session === 'ended') ended.push(e.id); });
  const app = await register(base);
  await kolab.openSession('bob', 'product', { kolab: 'bobs' });
  const t = await appTokens(base, idp, app, BOB);
  const before = await kolab.sessionInfo(t.access_token);
  expect(before.kolab).toBe('bobs');
  const stream = await listen(mcp, t.access_token, 'konjir://answers/bobs/bob');
  expect(stream.status).toBe(200);

  const r = await tool(mcp, t.access_token, 'konjir_switch_team', { kolab: 'anns' });
  expect(r.ok).toStrictEqual({ kolab: 'anns', role: 'product' });
  // The old session ended, as one event, and its stream closed.
  expect(ended).toStrictEqual([before.session]);
  await until('the old session\'s stream to close', stream.ended);
  // Its access token works no more, for tools or a new stream.
  expect(await kolab.sessionOpen(t.access_token)).toBe(false);
  expect((await tool(mcp, t.access_token, 'konjir_whoami')).status).toBe(401);
  // The grant names its new kolab now.
  const grant = (await kolab.db.query<{ scope: string; open: number }>(
    `select g.scope, (select count(*)::int from session s where s.grant_id = g.id and s.ended_at is null) as open
       from oauth_grant g join oauth_refresh_token r on r.grant_id = g.id where r.key = $1`, [sessionKey(t.refresh_token)])).rows[0];
  expect(grant).toStrictEqual({ scope: 'konjir kolab:anns role:product', open: 1 });

  // The same refresh token: a new access token, in anns, on the session the switch opened; the refresh token rotates.
  const n = await refresh(base, app, t.refresh_token);
  expect([n.status, n.body.scope]).toStrictEqual([200, 'konjir kolab:anns role:product']);
  expect(n.body.refresh_token).not.toBe(t.refresh_token);
  const after = await kolab.sessionInfo(n.body.access_token);
  expect([after.actor, after.kolab, after.role]).toStrictEqual(['bob', 'anns', 'product']);
  expect(after.session).not.toBe(before.session);
  expect((await tool(mcp, n.body.access_token, 'konjir_whoami')).ok).toMatchObject({ actor: 'bob', kolab: 'anns' });
  expect(((await tool(mcp, n.body.access_token, 'konjir_list_my_teams')).ok!.teams as { kolab: string; current: boolean }[]).map((x) => [x.kolab, x.current]))
    .toStrictEqual([['anns', true], ['bobs', false]]);
  // A stream on the new kolab's answers listens.
  expect((await listen(mcp, n.body.access_token, 'konjir://answers/anns/bob')).status).toBe(200);

  // And back again, the same way. To the kolab it works in already, nothing changes.
  expect((await tool(mcp, n.body.access_token, 'konjir_switch_team', { kolab: 'anns' })).ok).toStrictEqual({ kolab: 'anns', role: 'product' });
  expect(await kolab.sessionOpen(n.body.access_token)).toBe(true);
  expect((await tool(mcp, n.body.access_token, 'konjir_switch_team', { kolab: 'bobs' })).ok).toStrictEqual({ kolab: 'bobs', role: 'product' });
  const back = await refresh(base, app, n.body.refresh_token);
  expect(back.body.scope).toBe('konjir kolab:bobs role:product');
});

test('konjir_switch_team refuses a kolab the person can\'t reach (alike whether it exists), an agent, a hand-issued session and any other client\'s grant, and changes nothing', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  await world(kolab);
  await kolab.createKolab('pub', { owner: 'carol', visibility: 'public' });
  await kolab.makeOwnKolab('carol', 'gone', 'Gone');
  await kolab.grant('gone', 'bob', 'read');
  await kolab.revoke('gone', 'bob');
  const app = await register(base);
  await kolab.endSession(await kolab.openSession('bob', 'product', { kolab: 'bobs' }));
  const t = await appTokens(base, idp, app, BOB);
  for (const k of ['carols', 'nosuch', 'pub', 'gone', 'Bad Name', '']) {
    expect([k, (await tool(mcp, t.access_token, 'konjir_switch_team', { kolab: k })).error]).toStrictEqual([k, expect.stringMatching(/^AccessError: you aren't a member of a kolab [^:]*: konjir_list_my_teams lists yours\./)]);
  }
  expect(await kolab.sessionOpen(t.access_token)).toBe(true);
  expect((await kolab.sessionInfo(t.access_token)).kolab).toBe('bobs');
  expect((await refresh(base, app, t.refresh_token)).body.scope).toBe('konjir kolab:bobs role:product');

  // An agent's session, its owner's agent, signed in or hand-issued.
  await kolab.addOwnAgent('bob', 'bot');
  await kolab.grant('bobs', 'bob-bot', 'read');
  await kolab.grant('anns', 'bob-bot', 'read');
  const agent = await kolab.openSession('bob-bot', 'product', { kolab: 'bobs' });
  expect((await tool(mcp, agent, 'konjir_switch_team', { kolab: 'anns' })).error).toMatch(/bob-bot is an agent: only a person switches teams/);
  // A hand-issued session of the person's own: no grant to move.
  const hand = await kolab.openSession('bob', 'product', { kolab: 'bobs' });
  expect((await tool(mcp, hand, 'konjir_switch_team', { kolab: 'anns' })).error).toMatch(/this session is no sign-in through an app/);
  expect((await kolab.sessionInfo(hand)).kolab).toBe('bobs');
  // konnect's CLI on loopback, signed in on choose:kolab as the app is: each kolab is its own sign-in there.
  const cli = await register(base, [CB]);
  const p = await signIn(base, idp, cli, BOB, { redirect: CB });
  const code = (await p.post({ pick: 'kolab:bobs' })).left!.searchParams.get('code')!;
  const c = await exchange(base, cli, code, CB);
  expect((await tool(mcp, c.body.access_token, 'konjir_switch_team', { kolab: 'anns' })).error).toMatch(/switching teams is for konnect's own app only/);
  expect((await kolab.sessionInfo(c.body.access_token)).kolab).toBe('bobs');
  expect((await refresh(base, cli, c.body.refresh_token)).body.scope).toBe('konjir kolab:bobs role:product');
  // A revoked grant's session can't switch either: it has ended.
  await kolab.revokeToken(t.refresh_token);
  expect((await tool(mcp, t.access_token, 'konjir_switch_team', { kolab: 'anns' })).status).toBe(401);
});

test('a switch and a refresh at once land in one order: the grant keeps one open session, where its last refresh says; rotation still holds, and a replayed refresh token still revokes the moved grant', async () => {
  const kolab = await openKolab();
  const { base, mcp, idp } = await serve(kolab);
  await world(kolab);
  const app = await register(base);
  await kolab.openSession('bob', 'product', { kolab: 'bobs' });
  for (let i = 0; i < 3; i++) {
    const t = await appTokens(base, idp, app, BOB);
    const from = (await kolab.sessionInfo(t.access_token)).kolab;
    const to = from === 'bobs' ? 'anns' : 'bobs';
    const [s, r] = await Promise.all([tool(mcp, t.access_token, 'konjir_switch_team', { kolab: to }), refresh(base, app, t.refresh_token)]);
    expect(r.status).toBe(200);
    const open = (await kolab.db.query<{ kolab_id: string }>(
      `select s.kolab_id from session s join oauth_refresh_token k on k.grant_id = s.grant_id where k.key = $1 and s.ended_at is null`, [sessionKey(r.body.refresh_token)])).rows;
    expect(open.length).toBe(1);
    // Switched first, the refresh renews the new session; refreshed first, the switch's token was already dead.
    if (s.ok) expect([open[0].kolab_id, r.body.scope]).toStrictEqual([to, `konjir kolab:${to} role:product`]);
    else expect([open[0].kolab_id, r.body.scope]).toStrictEqual([from, `konjir kolab:${from} role:product`]);
    expect((await kolab.sessionInfo(r.body.access_token)).kolab).toBe(open[0].kolab_id);
  }

  // Rotation, after a switch: the used refresh token, again within the grace, is refused and revokes nothing.
  const t = await appTokens(base, idp, app, BOB);
  const to = (await kolab.sessionInfo(t.access_token)).kolab === 'bobs' ? 'anns' : 'bobs';
  expect((await tool(mcp, t.access_token, 'konjir_switch_team', { kolab: to })).ok).toMatchObject({ kolab: to });
  const n = await refresh(base, app, t.refresh_token);
  expect(n.status).toBe(200);
  expect((await refresh(base, app, t.refresh_token)).body.error).toBe('invalid_grant');
  expect(await kolab.sessionOpen(n.body.access_token)).toBe(true);
  // Past it, it is a replay: the grant is revoked, and its session in the new kolab ends.
  await kolab.db.query(`update oauth_refresh_token set used_at = now() - interval '1 minute' where key = $1`, [sessionKey(t.refresh_token)]);
  expect((await refresh(base, app, t.refresh_token)).body.error).toBe('invalid_grant');
  expect(await kolab.sessionOpen(n.body.access_token)).toBe(false);
  expect((await refresh(base, app, n.body.refresh_token)).body.error).toBe('invalid_grant');
});
