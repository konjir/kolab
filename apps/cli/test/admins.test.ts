// Admins are people, not a token (W2.22, D69), end to end over MCP and HTTP: Lee makes himself the
// first admin with the break-glass token, then runs admin verbs from his own GitHub sign-in, straight
// after signing in (D111). His agents, his hand-issued sessions and people who aren't admins can't;
// removing an admin stops them on their next request; each use of the break-glass token is recorded;
// hand-issued tokens expire; and the alarms' log lines are logged. With the break-glass disabled, the
// last admin stays one.
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

async function boot(adminToken: string | null = BREAK_GLASS) {
  const kolab = await openKolab();
  // Ann alone writes the functional layer, so her versions commit without review; Lee reads.
  await people(kolab, 'ann', { layers: ['functional'] });
  await people(kolab, 'icedlee337', { level: 'read' });
  await kolab.linkIdentity('icedlee337', { provider: 'stub', ...LEE });
  await kolab.linkIdentity('ann', { provider: 'stub', ...ANN });
  await kolab.addActor('icedlee337-claude', { owner: 'icedlee337' });
  await kolab.grant('test', 'icedlee337-claude', 'read');
  const server = await startServer({ adminToken, kolab, webRoot: null, identity: new StubIdentity() });
  closeAtEnd(server);
  const base = new URL(server.url).origin;
  const as = async (token: string) => { const c = await connect(server.url, token); closeAtEnd(c); return c; };
  return { kolab, server, base, as };
}

const tools = async (c: Awaited<ReturnType<typeof connect>>) => (await c.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('konjir_admin_')).sort();

test('Lee bootstraps himself as the first admin with the break-glass token, then applies a ruling from his own sign-in, straight after signing in, recorded as his (D47, D69, D111)', async () => {
  const { kolab, as } = await boot();
  const glass = await as(BREAK_GLASS);
  expect(await call(glass, 'admin_make_admin', { actor: 'icedlee337' })).toStrictEqual({ actor: 'icedlee337', admin: true });
  expect(await call(glass, 'admin_list_admins')).toMatchObject({ admins: [{ actor: 'icedlee337', granted_by: 'admin', archived: false, signs_in: true }], break_glass: true });

  // Signed in as himself, he sees and runs the admin verbs, with no other step, and whoami says he is one.
  const lee = await as(await signedIn(kolab, 'icedlee337'));
  expect((await tools(lee)).length).toBeGreaterThan(20);
  expect((await call(lee, 'whoami') as { konjir_admin: unknown }).konjir_admin).toBe(true);

  // A ruling of his, applied as the node's author would write it, records him as who applied it.
  const ann = await as(await kolab.openSession('ann', 'product'));
  await call(ann, 'create_node', { kind: 'spec', title: 'Spec', id: 'spec' });
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
  expect(mine.map((e) => [e.action, e.by])).toStrictEqual([['admin.granted', 'admin'], ['grant.set', 'admin']]);

  // Each verb the break-glass token ran is in the audit log, by admin, naming the verb.
  const glassUses = (await call(lee, 'admin_audit', {}) as { events: { action: string; subject: string; by: string }[] }).events.filter((e) => e.action === 'break_glass.used');
  expect(glassUses.map((e) => [e.subject, e.by])).toStrictEqual([['konjir_admin_list_admins', 'admin'], ['konjir_admin_make_admin', 'admin']]);
  expect(glassUses.some((e) => e.subject === 'konjir_admin_grant')).toBe(false);

});

test('raising is gone: /oauth/raise answers 404, and konjir_admin_elevate is neither listed nor runs, for any session (D111)', async () => {
  const { kolab, base, as } = await boot();
  await kolab.makeAdmin('icedlee337');
  const lee = await as(await signedIn(kolab, 'icedlee337'));
  const glass = await as(BREAK_GLASS);
  for (const c of [lee, glass]) {
    expect(await tools(c)).not.toContain('konjir_admin_elevate');
    await expect(call(c, 'admin_elevate')).rejects.toThrow(/konjir_admin_elevate/);
  }
  const link = `${base}/oauth/raise?request=kje_${'a'.repeat(43)}`;
  expect((await fetch(link, { redirect: 'manual' })).status).toBe(404);
  expect((await fetch(`${base}/oauth/raise`, { redirect: 'manual' })).status).toBe(404);
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
  expect(await call(agent, 'whoami')).not.toHaveProperty('konjir_admin');
  await expect(call(agent, 'admin_apply_ruling', { ruling: 'D1', actor: 'ann', node: 'test/spec', elements: [] })).rejects.toThrow(/is an admin verb/);
  // A person who isn't an admin.
  const ann = await as(await signedIn(kolab, 'ann'));
  expect(await tools(ann)).toStrictEqual([]);
  await expect(call(ann, 'admin_list_kolabs')).rejects.toThrow(/is an admin verb/);
  expect(await call(ann, 'whoami')).not.toHaveProperty('konjir_admin');
  // A hand-issued session of an admin's: not signed in with the identity provider. It expires in 30 days.
  const opened = await call(glass, 'admin_open_session', { actor: 'icedlee337', role: 'product', kolab: 'test' }) as { token: string; session: string; expires_at: string };
  expect(Math.abs(Date.parse(opened.expires_at) - (Date.now() + 30 * 86_400_000))).toBeLessThan(60_000);
  const handIssued = await as(opened.token);
  expect(await tools(handIssued)).toStrictEqual([]);
  await expect(call(handIssued, 'admin_list_kolabs')).rejects.toThrow(/is an admin verb/);
  expect(await call(handIssued, 'whoami')).not.toHaveProperty('konjir_admin');
  // Expired, it is refused like an ended one.
  await kolab.db.query(`update session set expires_at = now() - interval '1 second' where id = $1`, [opened.session]);
  await expect(connect(server.url, opened.token)).rejects.toThrow();

  // Removed as an admin, the same session stops running admin verbs on its next call, and stays open.
  const lee = await as(await signedIn(kolab, 'icedlee337'));
  expect(await call(lee, 'admin_list_admins')).toMatchObject({ admins: [{ actor: 'icedlee337' }] });
  expect(await call(glass, 'admin_remove_admin', { actor: 'icedlee337' })).toStrictEqual({ actor: 'icedlee337', admin: false });
  await expect(call(lee, 'admin_list_admins')).rejects.toThrow(/is an admin verb/);
  expect(await call(lee, 'whoami')).not.toHaveProperty('konjir_admin');
  expect((await kolab.auditLog({ subject: 'icedlee337' })).map((e) => [e.action, e.by]).slice(0, 2)).toStrictEqual([['admin.revoked', 'admin'], ['admin.granted', 'admin']]);
});

test('on one open connection, the admin verbs are listed only while its person is an admin, and archiving them refuses the connection', async () => {
  const { kolab, as } = await boot();
  const glass = await as(BREAK_GLASS);
  const ann = await as(await signedIn(kolab, 'ann'));
  expect(await tools(ann)).toStrictEqual([]);
  await call(glass, 'admin_make_admin', { actor: 'ann' });
  expect((await tools(ann)).length).toBeGreaterThan(20);
  await call(glass, 'admin_remove_admin', { actor: 'ann' });
  expect(await tools(ann)).toStrictEqual([]);
  await call(glass, 'admin_archive', { actor: 'ann' });
  await expect(ann.listTools()).rejects.toThrow();
});

test('with the break-glass token disabled, the token reaches nothing, and the last admin who can sign in can neither remove themselves nor be archived', async () => {
  const env = await boot(null);
  const { kolab, server, as } = env;
  await kolab.makeAdmin('icedlee337');
  await expect(connect(server.url, BREAK_GLASS)).rejects.toThrow();
  const lee = await as(await signedIn(kolab, 'icedlee337'));
  expect(await call(lee, 'admin_list_admins')).toMatchObject({ break_glass: false });
  await expect(call(lee, 'admin_remove_admin', { actor: 'icedlee337' })).rejects.toThrow(/icedlee337 is the last Konjir admin, and the break-glass admin token is disabled here/);
  await expect(call(lee, 'admin_archive', { actor: 'icedlee337' })).rejects.toThrow(/icedlee337 is the last live Konjir admin/);
  // A second admin, made by the first, lets either go.
  await call(lee, 'admin_make_admin', { actor: 'ann' });
  expect((await kolab.auditLog({ subject: 'ann' }))[0]).toMatchObject({ action: 'admin.granted', by: 'icedlee337' });
  expect(await call(lee, 'admin_remove_admin', { actor: 'ann' })).toStrictEqual({ actor: 'ann', admin: false });
});

test('each log line a CloudWatch alarm counts is logged, at warn, by what it alarms on: the break-glass token, an admin made (L2)', async () => {
  // The events deploy/terraform's metric filters match, each of Kolab's own lines (_SYSTEMD_UNIT konjir.service).
  const tf = readFileSync(resolve(import.meta.dirname, '../../../deploy/terraform/modules/monitoring/main.tf'), 'utf8');
  const filtered = [...tf.matchAll(/pattern\s*=\s*"\{ \$\.event = \\"([a-z_]+)\\" && \$\._SYSTEMD_UNIT = \\"konjir\.service\\" \}"/g)].map((m) => m[1]).sort();
  // outbox_job_dead's is libs/engine/test/outbox.test.ts's to check.
  expect(filtered).toStrictEqual(['admin_granted', 'break_glass_used', 'outbox_job_dead']);

  const env = await boot();
  const { kolab, as } = env;
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (m: unknown) => { lines.push(String(m)); };
  const logged = () => lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
  try {
    const glass = await as(BREAK_GLASS);
    await call(glass, 'admin_make_admin', { actor: 'icedlee337' });
    await call(await as(await signedIn(kolab, 'icedlee337')), 'admin_list_admins');
  } finally { Object.assign(console, originals); }
  const all = logged();
  const of = (event: string) => all.filter((l) => l.event === event);

  expect(of('break_glass_used').length).toBeGreaterThan(0);
  for (const l of of('break_glass_used')) expect(l).toMatchObject({ level: 'warn', event: 'break_glass_used', message: 'the break-glass admin token was used' });
  expect(of('admin_granted')).toStrictEqual([{ time: expect.any(String), level: 'warn', message: 'icedlee337 made a Konjir admin by admin', event: 'admin_granted', actor: 'icedlee337', by: 'admin' }]);
  // No line shows a token.
  expect(lines.join('\n')).not.toMatch(/kj[a-z]_[A-Za-z0-9_-]{8,}|test-break-glass-token/);
});
