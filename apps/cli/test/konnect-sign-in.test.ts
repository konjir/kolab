// konnect's sign-in and team membership, end to end over MCP and HTTP (Lee's instruction of
// 2026-11-16): @konjir/login's signInToTeam makes a team (a kolab, private and the person's, with no
// agent) or switches to one; the owner invites a teammate by GitHub username (konjir_invite), who
// signs in with signInChoosing, naming no kolab, accepts on Kolab's page and lands in the team; the
// owner lists and withdraws invitations and removes a member; a member leaves. The identity
// provider is a stub in GitHub's place, which never calls GitHub; the "browser" follows Kolab's
// redirects with its cookies and presses the button the test names.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { StubIdentity, startServer } from '@konjir/server';
import { CHOOSE_SCOPE, SignInRefused, login, signInChoosing, signInToTeam, teamScope } from '@konjir/login';
import { call, connect } from '../src/cli.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

/** The person's browser: follows Kolab's redirects, then presses the button `press` picks from the page's buttons (name=value), or none (`undefined`). */
async function browse(start: URL, press: (buttons: string[], html: string) => Record<string, string> | undefined): Promise<string> {
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
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? '';
  const fields = press([...html.matchAll(/<button[^>]*name="([^"]+)" value="([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`), html);
  if (!fields) return html;
  const done = await go(new URL('/oauth/consent', url), {
    method: 'POST', headers: { origin: url.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: field('csrf'), sign_in: field('sign_in'), ...(field('shown') ? { shown: field('shown') } : {}), ...fields }).toString(),
  });
  // The CLI's own loopback server receives the answer.
  await (await fetch(new URL(done.headers.get('location')!))).text();
  return html;
}
const button = (b: string) => Object.fromEntries([b.split('=') as [string, string]]);
/** Presses the first button whose name=value starts with `prefix`. */
const pressing = (prefix: string) => (buttons: string[]) => { const b = buttons.find((x) => x.startsWith(prefix)); if (!b) throw new Error(`no ${prefix} button among ${buttons.join(', ')}`); return button(b); };

const quiet = { log: () => undefined };
let dir: string;
const env = { ...process.env };
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.KONJIR_TOKEN;
  dir = mkdtempSync(join(tmpdir(), 'konnect-sign-in-'));
  process.env.KONJIR_CREDENTIALS = join(dir, 'unused.json');
});
afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; });

/** The access token a person's kept sign-in holds, to talk MCP with. */
const keptToken = (path: string, url: string) => JSON.parse(readFileSync(path, 'utf8'))[url].tokens.access_token as string;

async function boot() {
  const kolab = await openKolab();
  const idp = new StubIdentity()
    .account({ subject: '11', login: 'ann' }).account({ subject: '22', login: 'bob' }).account({ subject: '99', login: 'acme-inc', person: false });
  const server = await startServer({ adminToken: 'admin', kolab, identity: idp, webRoot: null });
  closeAtEnd(server);
  const paths = { ann: join(dir, 'ann.json'), bob: join(dir, 'bob.json'), dee: join(dir, 'dee.json') };
  return { kolab, idp, server, url: server.url, paths };
}

test('the scopes konnect signs in with', () => {
  expect(CHOOSE_SCOPE).toBe('konjir choose:kolab');
  expect(teamScope('acme')).toBe('konjir team:acme');
  expect(teamScope('acme', 'join')).toBe('konjir team:acme intent:join');
  expect(teamScope('acme', 'create')).toBe('konjir team:acme intent:create');
  expect(() => teamScope('acme', 'admin' as 'join')).toThrow(/isn't an intent: join or create/);
  for (const bad of ['Acme', '', '-acme', 'a b', 'a'.repeat(41), 'acme:x']) expect(() => teamScope(bad)).toThrow(/isn't a team's name/);
});

test('a team made with no agent, a teammate invited by GitHub username who signs in naming no kolab and lands in it, then removed; a member leaves; and an invitation withdrawn', async () => {
  const { kolab, idp, url, paths } = await boot();

  // Ann makes her team: Kolab's page offers to make it, and she allows it.
  idp.next({ subject: '11', login: 'ann' });
  let page = '';
  const ann = await signInToTeam(url, 'acme', { path: paths.ann, ...quiet, open: (u) => { void browse(u, (b, h) => { page = h; return pressing('decision=allow')(b); }); } });
  expect(page).toContain('<h1>Make <code>acme</code></h1>');
  expect(ann).toStrictEqual({ kolab: 'acme', actor: 'ann', role: 'product', credentials: paths.ann, yielded: false });
  expect(await kolab.kolabRow('acme')).toMatchObject({ owner: 'ann', visibility: 'private' });
  expect(await kolab.listActors({ owner: 'ann' })).toStrictEqual([]);
  const annMcp = await connect(url, keptToken(paths.ann, url));
  closeAtEnd(annMcp);

  // She invites by GitHub username: a name with no account, or an organization's, invites no one.
  expect(await rejection(call(annMcp, 'invite', { accounts: ['bob', 'ghost'] }))).toMatch(/no GitHub account ghost: check the spelling\. Nothing was invited/);
  expect(await rejection(call(annMcp, 'invite', { accounts: ['acme-inc'] }))).toMatch(/acme-inc isn't a person's account on GitHub \(an organization's or a bot's\)/);
  const invited = await call(annMcp, 'invite', { accounts: ['@bob'] }) as { kolab: string; invited: { id: string; account: string; state: string }[] };
  expect(invited).toMatchObject({ kolab: 'acme', invited: [{ account: 'bob', state: 'open', level: 'read' }], already_invited: [], already_members: [] });
  expect(await call(annMcp, 'list_invitations')).toMatchObject({ kolab: 'acme', invitations: [{ id: invited.invited[0].id, account: 'bob' }], next: null });

  // Bob signs in naming no kolab: the page lists the invitation, and he accepts it.
  idp.next({ subject: '22', login: 'bob' });
  const bob = await signInChoosing(url, { path: paths.bob, ...quiet, open: (u) => { void browse(u, (b, h) => { page = h; return pressing('pick=accept:')(b); }); } });
  expect(page).toContain('From Stub user <code>ann</code>, with Read');
  expect(bob).toMatchObject({ kolab: 'acme', actor: 'bob', role: 'product' });
  const bobMcp = await connect(url, keptToken(paths.bob, url));
  closeAtEnd(bobMcp);
  expect((await call(bobMcp, 'list_members') as { members: { actor: string }[] }).members.map((m) => m.actor)).toStrictEqual(['ann', 'bob']);
  await call(bobMcp, 'send_message', { to: 'ann', message: 'in' });
  expect(await call(annMcp, 'list_invitations')).toMatchObject({ invitations: [] });
  // Only the owner invites, lists and removes: Bob, a member at Read, can't.
  expect(await rejection(call(bobMcp, 'invite', { accounts: ['ann'] }))).toMatch(/only the owner of kolab acme invites people there/);
  expect(await rejection(call(bobMcp, 'remove_member', { member: 'ann' }))).toMatch(/only the owner of kolab acme removes members there/);

  // Signing in again naming no kolab, his kolab is there to choose.
  idp.next({ subject: '22', login: 'bob' });
  const again = await signInChoosing(url, { path: paths.bob, ...quiet, open: (u) => { void browse(u, pressing('pick=kolab:acme')); } });
  expect(again.kolab).toBe('acme');

  // Ann removes him: his session ends.
  const bobNow = await connect(url, keptToken(paths.bob, url));
  closeAtEnd(bobNow);
  expect(await call(annMcp, 'remove_member', { member: 'bob' })).toMatchObject({ kolab: 'acme', removed: 'bob', agents: [], ended: 1 });
  expect(await rejection(call(bobNow, 'whoami'))).toMatch(/./);
  expect(await kolab.access('bob', 'acme')).toMatchObject({ level: null });

  // Invited again, and the invitation withdrawn; then once more, and he joins and leaves himself.
  await call(annMcp, 'invite', { accounts: ['bob'] });
  const { invitations: [open] } = await call(annMcp, 'list_invitations') as { invitations: { id: string }[] };
  expect(await call(annMcp, 'withdraw_invitation', { invitation: open.id })).toMatchObject({ withdrawn: { id: open.id, state: 'withdrawn', settled_by: 'ann' } });
  expect(await rejection(call(annMcp, 'withdraw_invitation', { invitation: open.id }))).toMatch(/no open invitation/);
  await call(annMcp, 'invite', { accounts: ['bob'] });
  idp.next({ subject: '22', login: 'bob' });
  await signInChoosing(url, { path: paths.bob, ...quiet, open: (u) => { void browse(u, pressing('pick=accept:')); } });
  const back = await connect(url, keptToken(paths.bob, url));
  closeAtEnd(back);
  expect(await rejection(call(annMcp, 'leave_kolab'))).toMatch(/you own kolab acme, so you can't leave it/);
  expect(await call(back, 'leave_kolab')).toMatchObject({ left: 'acme', agents: [], ended: 1 });
  expect(await kolab.access('bob', 'acme')).toMatchObject({ level: null });
}, 120_000);

test('a team name that is someone else\'s is refused with a free name, never joined; a denial says so; and with nothing to offer, the page says how to make a team', async () => {
  const { kolab, idp, url, paths } = await boot();
  const { actor: ann } = await kolab.signInWith({ provider: 'stub', subject: '11', login: 'ann' });
  await kolab.makeOwnKolab(ann, 'acme', 'Acme');

  idp.next({ subject: '33', login: 'dee' });
  const refused = await rejection(signInToTeam(url, 'acme', { path: paths.dee, ...quiet, open: (u) => { void browse(u, pressing('decision=deny')); } }));
  expect(refused).toBe('SignInRefused: the kolab name acme is taken, by a kolab you aren\'t a member of: names are unique across Konjir, and this sign-in never joins anyone else\'s kolab. The name acme-dee is free');
  idp.next({ subject: '33', login: 'dee' });
  const caught = await signInToTeam(url, 'acme', { path: paths.dee, ...quiet, open: (u) => { void browse(u, pressing('decision=deny')); } }).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(SignInRefused);
  expect(caught).toMatchObject({ denied: false, suggest: 'acme-dee' });
  expect(await kolab.access('dee', 'acme')).toMatchObject({ level: null });

  // Nothing waits for Dee and she is a member of nothing: the page says how to make a team.
  idp.next({ subject: '33', login: 'dee' });
  let page = '';
  const denied = await signInChoosing(url, { path: paths.dee, ...quiet, open: (u) => { void browse(u, (b, h) => { page = h; return pressing('decision=deny')(b); }); } }).catch((e: unknown) => e);
  expect(page).toContain('npx @konjir/konnect team &lt;name&gt;');
  expect(denied).toBeInstanceOf(SignInRefused);
  expect(denied).toMatchObject({ denied: false, nothingToChoose: true, message: expect.stringMatching(/^nothing to sign in to: no invitation waits for this account/) });

  // Denied with something to choose: the person said no.
  const { actor: dee } = await kolab.signInWith({ provider: 'stub', subject: '33', login: 'dee' });
  await kolab.makeOwnKolab(dee, 'dees', 'Dee\'s');
  idp.next({ subject: '33', login: 'dee' });
  const no = await signInChoosing(url, { path: paths.dee, ...quiet, open: (u) => { void browse(u, pressing('decision=deny')); } }).catch((e: unknown) => e);
  expect(no).toMatchObject({ denied: true, nothingToChoose: false, message: 'you denied the sign-in on Kolab\'s page' });
}, 60_000);

test('signInToTeam with an intent: join never makes a team, create never joins one; then a person removes their own agent, and a conversation\'s history is listed', async () => {
  const { kolab, idp, url, paths } = await boot();
  // join, a free name: refused as no such team, with no free name offered, and nothing made.
  idp.next({ subject: '11', login: 'ann' });
  const none = await signInToTeam(url, 'acme', { path: paths.ann, intent: 'join', ...quiet, open: (u) => { void browse(u, pressing('decision=deny')); } }).catch((e: unknown) => e);
  expect(none).toBeInstanceOf(SignInRefused);
  expect(none).toMatchObject({ denied: false, suggest: undefined, message: expect.stringMatching(/^no kolab named acme exists, so there is nothing to join and nothing was made/) });
  expect(await kolab.kolabRow('acme')).toBeUndefined();

  // create, a free name: made, as the page says.
  idp.next({ subject: '11', login: 'ann' });
  let page = '';
  const made = await signInToTeam(url, 'acme', { path: paths.ann, intent: 'create', ...quiet, open: (u) => { void browse(u, (b, h) => { page = h; return pressing('decision=allow')(b); }); } });
  expect(page).toContain('Allowing it creates a new kolab, <code>acme</code>, and joins no existing one.');
  expect(made).toMatchObject({ kolab: 'acme', actor: 'ann' });

  // create, her own team: refused with a free name.
  idp.next({ subject: '11', login: 'ann' });
  const taken = await signInToTeam(url, 'acme', { path: paths.ann, intent: 'create', ...quiet, open: (u) => { void browse(u, pressing('decision=deny')); } }).catch((e: unknown) => e);
  expect(taken).toMatchObject({ denied: false, suggest: 'acme-ann', message: expect.stringMatching(/^the kolab name acme is taken, by a kolab you are a member of/) });

  // join, her own team: signed in.
  idp.next({ subject: '11', login: 'ann' });
  const joined = await signInToTeam(url, 'acme', { path: paths.ann, intent: 'join', ...quiet, open: (u) => { void browse(u, (b, h) => { page = h; return pressing('decision=allow')(b); }); } });
  expect(page).toContain('Allowing it joins <code>acme</code>, a kolab you are already a member of, and creates nothing.');
  expect(joined).toMatchObject({ kolab: 'acme', actor: 'ann' });

  // Her agent, over MCP: a conversation's history, then she removes it.
  const annMcp = await connect(url, keptToken(paths.ann, url));
  const agent = await kolab.addOwnAgent('ann', 'claude');
  await kolab.grant('acme', agent, 'read');
  const agentMcp = await connect(url, await kolab.openSession(agent, 'product', { kolab: 'acme' }));
  closeAtEnd(annMcp, agentMcp);
  await call(annMcp, 'send_message', { to: 'ann-claude', message: 'one' });
  await call(agentMcp, 'send_message', { to: 'ann', message: 'two' });
  expect(((await call(annMcp, 'list_messages', { with: 'ann/claude', limit: 20 })) as { messages: { message: string }[] }).messages.map((m) => m.message)).toStrictEqual(['two', 'one']);
  expect(await rejection(call(agentMcp, 'remove_agent', { agent: 'claude' }))).toMatch(/ann-claude is an agent: only a person removes their agents/);
  expect(await call(annMcp, 'remove_agent', { agent: 'claude' })).toStrictEqual({ kolab: 'acme', removed: 'ann-claude', label: 'claude', revoked: 0, ended: 1 });
  expect(await rejection(call(agentMcp, 'whoami'))).toMatch(/./);
  expect(await kolab.access(agent, 'acme')).toMatchObject({ level: null });
}, 120_000);

test('konjir_invite needs GitHub sign-in on the Kolab; konjir login is as it was', async () => {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'admin', kolab, webRoot: null });
  closeAtEnd(server);
  await kolab.addActor('ann');
  await kolab.createKolab('anns', { owner: 'ann' });
  const ann = await connect(server.url, await kolab.openSession('ann', 'product', { kolab: 'anns' }));
  closeAtEnd(ann);
  expect(await rejection(call(ann, 'invite', { accounts: ['bob'] }))).toMatch(/inviting people by their GitHub accounts needs GitHub sign-in set up on this Kolab/);
  // The list and the withdrawal need no identity provider: there is nothing to list.
  expect(await call(ann, 'list_invitations')).toStrictEqual({ kolab: 'anns', invitations: [], next: null });
  expect(typeof login).toBe('function');
});

test('GitHub lookups are limited per person, whichever session asks, and counted per name: one person can\'t use up everyone\'s', async () => {
  const { kolab, idp, url, paths } = await boot();
  idp.next({ subject: '11', login: 'ann' });
  await signInToTeam(url, 'acme', { path: paths.ann, ...quiet, open: (u) => { void browse(u, pressing('decision=allow')); } });
  const viaSignIn = await connect(url, keptToken(paths.ann, url));
  const viaToken = await connect(url, await kolab.openSession('ann', 'product', { kolab: 'acme' }));
  closeAtEnd(viaSignIn, viaToken);
  const names = (n: number) => Array.from({ length: 10 }, (_, i) => `nobody-${n}-${i}`);
  for (let n = 0; n < 10; n++) expect(await rejection(call(viaSignIn, 'invite', { accounts: names(n) }))).toMatch(/no GitHub account/);
  expect(idp.lookups).toBe(100);
  // Her other session shares her budget: nothing more is asked of GitHub for her this hour.
  expect(await rejection(call(viaToken, 'invite', { accounts: ['bob'] }))).toMatch(/too many GitHub accounts looked up just now/);
  expect(idp.lookups).toBe(100);
  // Someone else's invitations go on.
  const { actor: dee } = await kolab.signInWith({ provider: 'stub', subject: '33', login: 'dee' });
  await kolab.makeOwnKolab(dee, 'dees', 'Dee\'s');
  const deeMcp = await connect(url, await kolab.openSession(dee, 'product', { kolab: 'dees' }));
  closeAtEnd(deeMcp);
  expect(await call(deeMcp, 'invite', { accounts: ['bob'] })).toMatchObject({ invited: [{ account: 'bob' }] });
}, 60_000);

test('a team sign-in that lands anywhere but the team asked for is revoked and forgotten, never kept', async () => {
  const { kolab, idp, url, paths } = await boot();
  const { actor: ann } = await kolab.signInWith({ provider: 'stub', subject: '11', login: 'ann' });
  await kolab.makeOwnKolab(ann, 'anns', 'Ann\'s');
  // A choose sign-in's page, answered as if it were the team's: the app asked for acme, and got anns.
  idp.next({ subject: '11', login: 'ann' });
  const wrong = await signInToTeam(url, 'acme', {
    path: paths.ann, ...quiet,
    open: (u) => { u.searchParams.set('scope', 'konjir choose:kolab'); void browse(u, pressing('pick=kolab:anns')); },
  }).catch((e: unknown) => e);
  expect(String(wrong)).toMatch(/Kolab signed you in to kolab anns, not acme, which was asked for: the sign-in was revoked/);
  expect(JSON.parse(readFileSync(paths.ann, 'utf8'))[url]).toBeUndefined();
  expect((await kolab.db.query(`select count(*)::int as n from oauth_grant where revoked_at is null`)).rows[0]).toStrictEqual({ n: 0 });
}, 60_000);
