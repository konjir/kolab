// Admins are people, not a token (W2.22, D69), end to end over MCP and HTTP: Lee makes himself the
// first admin with the break-glass token, then runs admin verbs from his own GitHub sign-in once he
// raises it. Asking over MCP raises nothing: only his own browser, signed in with GitHub (its account picker) and
// confirming on Kolab's page, does (Lee's ruling of 2026-10-23), so no agent driving his session
// can. His agents, and people who aren't admins, can't; each use of the break-glass token is
// recorded; hand-issued tokens expire; and the alarms' log lines are logged. With the break-glass
// disabled, the last admin stays one.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab, people } from '@konjir/engine/testing';
import { StubIdentity, startServer } from '@konjir/server';
import { breakGlassToken, call, connect } from '../src/cli.js';

const BREAK_GLASS = 'test-break-glass-token';
const LEE = { subject: '337', login: 'icedlee337' };
const ANN = { subject: '2', login: 'ann' };
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** `person` signs in with the identity provider, as themselves or as an agent of theirs, and gets an access token. */
async function signedIn(kolab: Kolab, person: string, as: Parameters<Kolab['consent']>[2]['as'] = { kind: 'self' }): Promise<string> {
  const client = (await kolab.registerClient({ name: 'Test client', redirectUris: ['http://127.0.0.1:9/cb'] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'stub', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256(verifier) });
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  const { code, redirectUri } = await kolab.consent(binding, csrf, { as, kolab: 'test', role: 'product' });
  return (await kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier })).accessToken;
}

/** A browser: a cookie jar (paths aside) that follows redirects, and submits Kolab's forms as its pages do. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  private async fetch(url: URL, init: RequestInit = {}) {
    const headers = { ...(init.headers as Record<string, string> | undefined), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const name = kv.slice(0, kv.indexOf('=')).trim();
      const value = kv.slice(kv.indexOf('=') + 1).trim();
      if (!value || /max-age=0/i.test(c)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return res;
  }
  async go(url: string | URL, init?: RequestInit): Promise<{ status: number; html: string }> {
    let at = new URL(url, this.base);
    let res = await this.fetch(at, init);
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
      at = new URL(res.headers.get('location')!, at);
      res = await this.fetch(at);
    }
    return { status: res.status, html: await res.text() };
  }
  /** Submits a page's form with this decision, from `origin` (Kolab's own, as the page would). */
  submit(html: string, decision: 'allow' | 'deny', origin = this.base) {
    const field = (n: string) => new RegExp(`name="${n}" value="([^"]+)"`).exec(html)?.[1] ?? '';
    return this.go('/oauth/consent', {
      method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sign_in: field('sign_in'), csrf: field('csrf'), decision }).toString(),
    });
  }
}

async function boot(adminToken: string | null = BREAK_GLASS) {
  const kolab = await openKolab();
  // Ann alone writes the functional layer, so her versions commit without review; Lee reads.
  await people(kolab, 'ann', { layers: ['functional'] });
  await people(kolab, 'icedlee337', { level: 'read' });
  await kolab.linkIdentity('icedlee337', { provider: 'stub', ...LEE });
  await kolab.linkIdentity('ann', { provider: 'stub', ...ANN });
  await kolab.addActor('icedlee337-claude', { owner: 'icedlee337' });
  await kolab.grant('test', 'icedlee337-claude', 'read');
  const idp = new StubIdentity();
  const server = await startServer({ adminToken, kolab, webRoot: null, identity: idp });
  closeAtEnd(server);
  const base = new URL(server.url).origin;
  const as = async (token: string) => { const c = await connect(server.url, token); closeAtEnd(c); return c; };
  /** Opens a raise link in a fresh browser, as `who` at the identity provider, and answers its page with `decision`. */
  const inBrowser = async (url: string, who: { subject: string; login: string }, decision: 'allow' | 'deny' = 'allow') => {
    const browser = new Browser(base);
    idp.next(who);
    const page = await browser.go(url);
    const done = page.status === 200 && page.html.includes('name="csrf"') ? await browser.submit(page.html, decision) : undefined;
    return { page, done, browser };
  };
  return { kolab, server, base, idp, as, inBrowser };
}

const tools = async (c: Awaited<ReturnType<typeof connect>>) => (await c.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('konjir_admin_')).sort();

/** Asks for a raise over MCP, and completes it in the person's own browser. */
async function raise(env: Awaited<ReturnType<typeof boot>>, c: Awaited<ReturnType<typeof connect>>, who = LEE) {
  const asked = await call(c, 'admin_elevate') as { raise_url: string };
  const { done } = await env.inBrowser(asked.raise_url, who);
  expect(done?.html).toContain('<h1>Raised</h1>');
}

test('Lee bootstraps himself as the first admin with the break-glass token, then applies a ruling from his own sign-in, raised in his browser, recorded as his (D47, D69)', async () => {
  const env = await boot();
  const { kolab, base, idp, as } = env;
  const glass = await as(BREAK_GLASS);
  expect(await call(glass, 'admin_make_admin', { actor: 'icedlee337' })).toStrictEqual({ actor: 'icedlee337', admin: true });
  expect(await call(glass, 'admin_list_admins')).toMatchObject({ admins: [{ actor: 'icedlee337', granted_by: 'admin', archived: false, signs_in: true }], break_glass: true });

  // Signed in as himself, he sees only the verb that asks for a raise, and whoami says nothing of how to get one.
  const lee = await as(await signedIn(kolab, 'icedlee337'));
  expect(await tools(lee)).toStrictEqual(['konjir_admin_elevate']);
  expect((await call(lee, 'whoami') as { konjir_admin: unknown }).konjir_admin).toStrictEqual({ raised: false });
  await expect(call(lee, 'admin_apply_ruling', { ruling: 'D1', actor: 'ann', node: 'test/spec', elements: [] })).rejects.toThrow(/is an admin verb/);

  // Asking raises nothing: it answers with a link for his browser.
  const asked = await call(lee, 'admin_elevate') as { raise_url: string; raised: boolean; next: string };
  expect(asked).toMatchObject({ actor: 'icedlee337', raised: false, raise_url: expect.stringMatching(new RegExp(`^${base}/oauth/raise\\?request=kje_[A-Za-z0-9_-]{43}$`)) });
  expect(asked.next).toMatch(/Open raise_url in your own browser/);
  expect(await tools(lee)).toStrictEqual(['konjir_admin_elevate']);

  // In his browser: a GitHub sign-in through the account picker (GitHub has no forced re-authentication),
  // then Kolab's page, which names the session by what Kolab knows of it and says what raising gives.
  const { page, done } = await env.inBrowser(asked.raise_url, LEE);
  expect(idp.asked.at(-1)).toStrictEqual({ redirectUri: `${base}/oauth/callback/stub`, fresh: true });
  expect(page.status).toBe(200);
  expect(page.html).toContain('Raise your session to run Konjir\'s admin verbs');
  const { session, client } = await kolab.db.query<{ session: string; client: string }>(
    `select s.id as session, g.client_id as client from session s join oauth_grant g on g.id = s.grant_id where s.actor_id = 'icedlee337' and s.ended_at is null`).then((r) => r.rows[0]);
  expect(page.html).toContain(`This request was made over MCP by a session of yours: <code>icedlee337</code>&#39;s session <code>${session}</code>`.replace('&#39;', '\''));
  expect(page.html).toContain(`through an app registered with Kolab as <code>${client}</code>, which receives its sign-ins at <code>http://127.0.0.1:9</code>`);
  // The name the client chose for itself is shown only as that, unverified.
  expect(page.html).toContain('It calls itself “Test client”, a name it chose when it registered: <strong>unverified</strong>');
  expect(page.html).not.toContain('<strong>Test client</strong>');
  expect(page.html).toContain('Raise it only if you asked for this yourself, just now, from that session.');
  expect(done).toMatchObject({ status: 200, html: expect.stringContaining('<h1>Raised</h1>') });
  expect((await tools(lee)).length).toBeGreaterThan(20);
  expect((await call(lee, 'whoami') as { konjir_admin: unknown }).konjir_admin).toStrictEqual({ raised: true });

  // A ruling of his, applied as the node's author would write it, records him as who applied it.
  const ann = await as(await kolab.openSession('ann', 'product'));
  await call(ann, 'create_node', { kind: 'functional_spec', title: 'Spec', id: 'spec' });
  await call(ann, 'draft', { node: 'spec', elements: [{ id: 'R1', text: 'One.' }] });
  await call(ann, 'submit_for_review', { node: 'spec', version: 1 });
  expect(await call(lee, 'admin_apply_ruling', { ruling: 'D69', actor: 'ann', node: 'test/spec', elements: [{ id: 'R1', text: 'One, ruled.' }] }))
    .toMatchObject({ ok: true, ruling: 'D69', committed: 'kj:test/spec@2', review: expect.stringMatching(/^Applied as ruling D69 through icedlee337's own admin session, written as ann/) });
  expect((await kolab.db.query(`select v.actor_id, v.submitted_by from version v join node n on n.id = v.node_id where n.name = 'spec' and v.seq = 2`)).rows)
    .toStrictEqual([{ actor_id: 'ann', submitted_by: 'icedlee337' }]);
  // So does every other admin write of his.
  await call(lee, 'admin_grant', { kolab: 'test', to: 'ann', level: 'maintain' });
  const audit = await call(lee, 'admin_audit', { subject: 'ann' }) as { events: { action: string; by: string }[] };
  expect(audit.events[0]).toMatchObject({ action: 'grant.set', by: 'icedlee337' });
  const mine = (await call(lee, 'admin_audit', { subject: 'icedlee337' }) as { events: { action: string; by: string }[] }).events;
  expect(mine.map((e) => [e.action, e.by])).toStrictEqual([['admin.elevated', 'icedlee337'], ['admin.granted', 'admin'], ['grant.set', 'admin']]);

  // Each verb the break-glass token ran is in the audit log, by admin, naming the verb.
  const glassUses = (await call(lee, 'admin_audit', {}) as { events: { action: string; subject: string; by: string }[] }).events.filter((e) => e.action === 'break_glass.used');
  expect(glassUses.map((e) => [e.subject, e.by])).toStrictEqual([['konjir_admin_list_admins', 'admin'], ['konjir_admin_make_admin', 'admin']]);
  expect(glassUses.some((e) => e.subject === 'konjir_admin_grant')).toBe(false);

  // Lowered, his session runs admin verbs no more, at once; lowering needs no browser.
  expect(await call(lee, 'admin_elevate', { lower: true })).toMatchObject({ admin_until: null, lowered: true });
  await expect(call(lee, 'admin_list_kolabs')).rejects.toThrow(/is an admin verb/);
});

test('a raise asked for over MCP is never completed by anything MCP reaches: only its own person\'s browser, through every check a sign-in has, completes it', async () => {
  const env = await boot();
  const { kolab, base, as } = env;
  await kolab.makeAdmin('icedlee337');
  await kolab.makeAdmin('ann');
  const lee = await as(await signedIn(kolab, 'icedlee337'));

  // Asked for again and again, as an agent driving the session might: nothing is raised, and nothing else the session reaches raises it.
  const first = await call(lee, 'admin_elevate') as { raise_url: string };
  const second = await call(lee, 'admin_elevate') as { raise_url: string };
  expect(first.raise_url).not.toBe(second.raise_url);
  expect(await tools(lee)).toStrictEqual(['konjir_admin_elevate']);
  await expect(call(lee, 'admin_list_admins')).rejects.toThrow(/is an admin verb/);
  expect((await call(lee, 'whoami') as { konjir_admin: unknown }).konjir_admin).toStrictEqual({ raised: false });

  // With the link but no browser sign-in: the confirmation form, sent without its sign-in's cookie, is refused.
  const bare = await new Browser(base).go('/oauth/consent', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'sign_in=AAAAAAAAAAA&csrf=nothing&decision=allow',
  });
  expect(bare.status).toBe(400);
  // A used-up link is refused before the identity provider is reached, so no one is queued there.
  const usedUp = async (url: string) => {
    const again = await new Browser(base).go(url);
    expect(again.status).toBe(400);
    expect(again.html).toContain('This raise link is unknown, used or expired');
  };

  // Cancelled at the identity provider (it signs no one in): nothing is raised, and the link is used up.
  const cancelled = await new Browser(base).go(first.raise_url);
  expect(cancelled.html).toContain('<h1>Not raised</h1>');
  await usedUp(first.raise_url);
  expect(await tools(lee)).toStrictEqual(['konjir_admin_elevate']);

  // Another person's browser never completes it: Ann, an admin herself, signed in with her own GitHub.
  // A link that reached someone else is used up too.
  const byAnn = await env.inBrowser(second.raise_url, ANN);
  expect(byAnn.page.status).toBe(403);
  expect(byAnn.page.html).toContain('This raise is for icedlee337&#39;s session, and only icedlee337 can confirm it. You signed in with Stub as ann, who is ann here. Nothing was raised, and the link is used up.');
  expect(byAnn.done).toBeUndefined();
  await usedUp(second.raise_url);
  // Nor a GitHub account no one in Kolab has, who isn't signed up by trying.
  const third = await call(lee, 'admin_elevate') as { raise_url: string };
  const byStranger = await env.inBrowser(third.raise_url, { subject: '999', login: 'mallory' });
  expect(byStranger.page.html).toContain('who isn&#39;t anyone in Kolab');
  expect((await kolab.listActors()).map((a) => a.id)).not.toContain('mallory');
  await usedUp(third.raise_url);
  expect(await tools(lee)).toStrictEqual(['konjir_admin_elevate']);

  // His own browser, choosing Don't raise: nothing is raised, and that link can never raise later,
  // however he is asked to click it again.
  const fourth = await call(lee, 'admin_elevate') as { raise_url: string };
  const own = await env.inBrowser(fourth.raise_url, LEE, 'deny');
  expect(own.done?.html).toContain('<h1>Not raised</h1>');
  expect(own.done?.html).toContain('the link is used up');
  await usedUp(fourth.raise_url);
  expect(await tools(lee)).toStrictEqual(['konjir_admin_elevate']);

  // The form is checked as every consent form is: from Kolab's own origin only.
  const fifth = await call(lee, 'admin_elevate') as { raise_url: string };
  const browser = new Browser(base);
  env.idp.next(LEE);
  const page = await browser.go(fifth.raise_url);
  expect((await browser.submit(page.html, 'allow', 'https://evil.example')).status).toBe(403);
  expect(await tools(lee)).toStrictEqual(['konjir_admin_elevate']);
  expect((await browser.submit(page.html, 'allow')).html).toContain('<h1>Raised</h1>');
  expect((await tools(lee)).length).toBeGreaterThan(20);
  // Used once: the link starts nothing more.
  await usedUp(fifth.raise_url);
  // Raised only as asked: one admin.elevated, his.
  expect((await kolab.auditLog({ subject: 'icedlee337' })).filter((e) => e.action === 'admin.elevated').map((e) => e.by)).toStrictEqual(['icedlee337']);
});

test('the raise page names the session by what Kolab knows, never vouching for a name a client gave itself (L2)', async () => {
  const env = await boot();
  const { kolab } = env;
  await kolab.makeAdmin('icedlee337');
  // A client that registers itself as Kolab's own web page, and Lee signs in through it as himself.
  const client = (await kolab.registerClient({ name: 'Kolab\'s web page', redirectUris: ['https://evil.example/cb'] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await kolab.beginAuthorization({ provider: 'stub', clientId: client, redirectUri: 'https://evil.example/cb', codeChallenge: s256(verifier) });
  const { csrf } = await kolab.identifyAuthorization(binding, state, 'icedlee337');
  const { code, redirectUri } = await kolab.consent(binding, csrf, { as: { kind: 'self' }, kolab: 'test', role: 'product' });
  const lee = await env.as((await kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier })).accessToken);
  const asked = await call(lee, 'admin_elevate') as { raise_url: string };
  const { page } = await env.inBrowser(asked.raise_url, LEE, 'deny');
  expect(page.html).toContain(`through an app registered with Kolab as <code>${client}</code>, which receives its sign-ins at <code>https://evil.example</code>. It calls itself “Kolab&#39;s web page”, a name it chose when it registered: <strong>unverified</strong>`);
  expect(page.html).not.toContain('through Kolab&#39;s own web page');
});

test('KONJIR_ADMIN_TOKEN: off in any case disables the break-glass; whitespace, and behind a public host a short token, are refused', () => {
  for (const off of ['off', 'Off', 'OFF', ' off ', 'off\n']) expect(breakGlassToken(off, { publicHost: 'kolab.example.com' })).toBeNull();
  expect(breakGlassToken(undefined)).toBeUndefined();
  expect(breakGlassToken('short')).toBe('short');   // a local Kolab: tests and the demo
  expect(() => breakGlassToken('short', { publicHost: 'kolab.example.com' })).toThrow(/too short for a Kolab on a public host: at least 32 characters/);
  const deployed = `kja_${'a'.repeat(40)}`;
  expect(breakGlassToken(deployed, { publicHost: 'kolab.example.com' })).toBe(deployed);
  expect(() => breakGlassToken(`${deployed} `)).toThrow(/holds whitespace/);
  expect(() => breakGlassToken('  ')).toThrow(/is empty/);
});

test('an agent, even an admin\'s own, a person who isn\'t an admin, and a hand-issued session never run admin verbs; removing an admin stops them at once', async () => {
  const env = await boot();
  const { kolab, server, as } = env;
  const glass = await as(BREAK_GLASS);
  await call(glass, 'admin_make_admin', { actor: 'icedlee337' });
  // Never an agent: not made one, and its sign-in never carries admin.
  await expect(call(glass, 'admin_make_admin', { actor: 'icedlee337-claude' })).rejects.toThrow(/an agent is never a Konjir admin/);
  const agent = await as(await signedIn(kolab, 'icedlee337', { kind: 'agent', agent: 'icedlee337-claude' }));
  expect(await tools(agent)).toStrictEqual([]);
  await expect(call(agent, 'admin_elevate')).rejects.toThrow(/is an admin verb/);
  await expect(call(agent, 'admin_apply_ruling', { ruling: 'D1', actor: 'ann', node: 'test/spec', elements: [] })).rejects.toThrow(/is an admin verb/);
  // A person who isn't an admin.
  const ann = await as(await signedIn(kolab, 'ann'));
  expect(await tools(ann)).toStrictEqual([]);
  await expect(call(ann, 'admin_elevate')).rejects.toThrow(/is an admin verb/);
  // A hand-issued session of an admin's: not signed in with the identity provider. It expires in 30 days.
  const opened = await call(glass, 'admin_open_session', { actor: 'icedlee337', role: 'product', kolab: 'test' }) as { token: string; session: string; expires_at: string };
  expect(Math.abs(Date.parse(opened.expires_at) - (Date.now() + 30 * 86_400_000))).toBeLessThan(60_000);
  const handIssued = await as(opened.token);
  expect(await tools(handIssued)).toStrictEqual([]);
  // Expired, it is refused like an ended one.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where id = $1`, [opened.session]);
  await expect(connect(server.url, opened.token)).rejects.toThrow();

  // Removed as an admin, a raised session stops running admin verbs on its next call.
  const lee = await as(await signedIn(kolab, 'icedlee337'));
  await raise(env, lee);
  expect(await call(lee, 'admin_list_admins')).toMatchObject({ admins: [{ actor: 'icedlee337' }] });
  expect(await call(glass, 'admin_remove_admin', { actor: 'icedlee337' })).toStrictEqual({ actor: 'icedlee337', admin: false });
  await expect(call(lee, 'admin_list_admins')).rejects.toThrow(/is an admin verb/);
  expect((await kolab.auditLog({ subject: 'icedlee337' })).map((e) => [e.action, e.by]).slice(0, 2)).toStrictEqual([['admin.revoked', 'admin'], ['admin.elevated', 'icedlee337']]);
});

test('with the break-glass token disabled, the token reaches nothing, and the last admin who can sign in can neither remove themselves nor be archived', async () => {
  const env = await boot(null);
  const { kolab, server, as } = env;
  await kolab.makeAdmin('icedlee337');
  await expect(connect(server.url, BREAK_GLASS)).rejects.toThrow();
  const lee = await as(await signedIn(kolab, 'icedlee337'));
  await raise(env, lee);
  expect(await call(lee, 'admin_list_admins')).toMatchObject({ break_glass: false });
  await expect(call(lee, 'admin_remove_admin', { actor: 'icedlee337' })).rejects.toThrow(/icedlee337 is the last Konjir admin, and the break-glass admin token is disabled here/);
  await expect(call(lee, 'admin_archive', { actor: 'icedlee337' })).rejects.toThrow(/icedlee337 is the last live Konjir admin/);
  // A second admin, made by the first, lets either go.
  await call(lee, 'admin_make_admin', { actor: 'ann' });
  expect((await kolab.auditLog({ subject: 'ann' }))[0]).toMatchObject({ action: 'admin.granted', by: 'icedlee337' });
  expect(await call(lee, 'admin_remove_admin', { actor: 'ann' })).toStrictEqual({ actor: 'ann', admin: false });
});

test('each log line a CloudWatch alarm counts is logged, at warn, by what it alarms on: the break-glass token, an admin made, a session raised (L2)', async () => {
  // The events deploy/terraform's metric filters match, each of Kolab's own lines (_SYSTEMD_UNIT konjir.service).
  const tf = readFileSync(resolve(import.meta.dirname, '../../../deploy/terraform/modules/monitoring/main.tf'), 'utf8');
  const filtered = [...tf.matchAll(/pattern\s*=\s*"\{ \$\.event = \\"([a-z_]+)\\" && \$\._SYSTEMD_UNIT = \\"konjir\.service\\" \}"/g)].map((m) => m[1]).sort();
  // outbox_job_dead's is libs/engine/test/outbox.test.ts's to check.
  expect(filtered).toStrictEqual(['admin_elevated', 'admin_granted', 'break_glass_used', 'outbox_job_dead']);

  const env = await boot();
  const { kolab, as } = env;
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (m: unknown) => { lines.push(String(m)); };
  const logged = () => lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  let beforeRaise: Record<string, unknown>[];
  try {
    const glass = await as(BREAK_GLASS);
    await call(glass, 'admin_make_admin', { actor: 'icedlee337' });
    const lee = await as(await signedIn(kolab, 'icedlee337'));
    const asked = await call(lee, 'admin_elevate') as { raise_url: string };
    beforeRaise = logged();
    await env.inBrowser(asked.raise_url, LEE);
  } finally { Object.assign(console, originals); }
  const all = logged();
  const of = (event: string) => all.filter((l) => l.event === event);

  expect(of('break_glass_used').length).toBeGreaterThan(0);
  for (const l of of('break_glass_used')) expect(l).toMatchObject({ level: 'warn', event: 'break_glass_used', message: 'the break-glass admin token was used' });
  expect(of('admin_granted')).toStrictEqual([{ time: expect.any(String), level: 'warn', message: 'icedlee337 made a Konjir admin by admin', event: 'admin_granted', actor: 'icedlee337', by: 'admin' }]);
  // Asking for a raise logs no admin_elevated; the browser step does, once.
  expect(beforeRaise.filter((l) => l.event === 'admin_elevated')).toStrictEqual([]);
  expect(beforeRaise.filter((l) => l.event === 'admin_raise_requested')).toMatchObject([{ level: 'info', actor: 'icedlee337' }]);
  expect(of('admin_elevated')).toStrictEqual([{
    time: expect.any(String), level: 'warn', message: expect.stringMatching(/^icedlee337 raised their session to run admin verbs until .*, in their browser$/),
    event: 'admin_elevated', actor: 'icedlee337', session: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), until: expect.any(String),
  }]);
  // No line shows a token or a raise link's secret.
  expect(lines.join('\n')).not.toMatch(/kj[a-z]_[A-Za-z0-9_-]{8,}|test-break-glass-token/);
});
