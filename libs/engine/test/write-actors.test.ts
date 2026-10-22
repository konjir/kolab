// Every write records who made it (W2.20, D70). Kolab's public methods that write are read from
// its source and held to WRITE_ACTORS, which says where each records its actor; the database
// refuses a row that names no one (migration 0024); and each new place is filled, by the session's
// actor, the person signing in, the admin, or Kolab, as the write was made.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { ADMIN_DOER, AUDIT_ACTIONS } from '@konjir/types';
import { Kolab, SYSTEM_ACTOR, SYSTEM_WRITES, WRITE_ACTORS, activity, sessionKey } from '../src/index.js';
import { els, openKolab, people, rejection, TEST_KOLAB } from '../src/testing.js';

/** A write in SQL: an insert, an update or a delete, of any table. */
const WRITE = /\b(insert\s+into|delete\s+from|update\s+[a-z_]+(\s+[a-z]+)?\s+set)\b/i;

/**
 * Kolab's public methods that write, from kolab.ts: those whose own SQL writes, or that call (as
 * this.<method>, or a function of the module) something that does, other than SYSTEM_WRITES.
 * Methods are found by their header, two spaces in, in the class Kolab; functions at the top level.
 */
function writingMethods(): string[] {
  const lines = readFileSync(new URL('../src/kolab.ts', import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^export class Kolab\b/.test(l));
  let end = start + 1;
  while (!/^}/.test(lines[end])) end++;
  type Unit = { name: string; method: boolean; private: boolean; body: string[] };
  const units = new Map<string, Unit>();
  const header = /^ {2}(?:(?:private|protected|public|static|readonly|async|override)\s+)*([A-Za-z_]\w*)\s*(?:<[^(]*>)?\(/;
  let cur: Unit | undefined;
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(header);
    if (m) units.set(`this.${m[1]}`, cur = { name: m[1], method: true, private: /^\s+(private|protected)\b/.test(lines[i]), body: [] });
    cur?.body.push(lines[i]);
  }
  cur = undefined;
  for (let i = 0; i < lines.length; i++) {
    if (i >= start && i <= end) { cur = undefined; continue; }
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/);
    if (m) { units.set(m[1], cur = { name: m[1], method: false, private: false, body: [] }); continue; }
    if (/^(export |const |let |interface |type |class |\/\*\*)/.test(lines[i])) cur = undefined;
    cur?.body.push(lines[i]);
  }
  const stop = new Set(SYSTEM_WRITES.map((n) => `this.${n}`));
  const calls = new Map([...units].map(([k, u]) => {
    const b = u.body.join('\n');
    const named = [...b.matchAll(/this\.(\w+)\s*[(<]/g)].map((m) => `this.${m[1]}`).concat([...b.matchAll(/(?<![.\w])(\w+)\s*\(/g)].map((m) => m[1]));
    return [k, named.filter((c) => units.has(c) && c !== k && !stop.has(c))];
  }));
  const writes = (k: string, seen = new Set<string>()): boolean => {
    if (seen.has(k)) return false;
    seen.add(k);
    return WRITE.test(units.get(k)!.body.join('\n')) || calls.get(k)!.some((c) => writes(c, seen));
  };
  expect(units.has('this.createNode') && units.has('insertSession')).toBe(true);   // the reading works
  return [...units].filter(([k, u]) => u.method && !u.private && u.name !== 'constructor' && writes(k)).map(([, u]) => u.name).sort();
}

test('every public method of Kolab that writes says where it records who made the write, and none is listed that no longer writes', () => {
  expect(writingMethods()).toStrictEqual(Object.keys(WRITE_ACTORS).sort());
  // The helpers whose writes are Kolab's own are still there to be skipped.
  const src = readFileSync(new URL('../src/kolab.ts', import.meta.url), 'utf8');
  for (const name of SYSTEM_WRITES) expect([name, new RegExp(`private async ${name}\\(`).test(src)]).toStrictEqual([name, true]);
});

test('each place WRITE_ACTORS names is a column of the schema, or an action of the audit log', async () => {
  const kolab = await openKolab();
  const columns = new Set((await kolab.db.query<{ c: string }>(
    `select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'`)).rows.map((r) => r.c));
  for (const [method, how] of Object.entries(WRITE_ACTORS)) {
    if (!('recorded' in how)) continue;
    expect([method, how.recorded.length > 0]).toStrictEqual([method, true]);
    for (const place of how.recorded) {
      const ok = place.startsWith('audit_event:') ? (AUDIT_ACTIONS as readonly string[]).includes(place.slice('audit_event:'.length)) : columns.has(place);
      expect([method, place, ok]).toStrictEqual([method, place, true]);
    }
  }
});

test('the database refuses a row that names no one, and a session ended, an invite or grant revoked, or a version submitted without saying by whom', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const s = await kolab.openSession('alice', 'product');
  const nobody = /must name who made this write/;
  expect(await rejection(kolab.db.query(`insert into node(id, name, kind, layer, title, kolab_id) values ('n', 'n', 'functional_spec', 'functional', 'N', $1)`, [TEST_KOLAB]))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`insert into account(id, kind, name) values ('zed', 'user', 'Zed')`))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`insert into kolab(id, owner_id, title) values ('k2', 'test-org', 'K')`))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`insert into team(id, org_id, name) values ('test-org/t', 'test-org', 't')`))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`update session set ended_at = now() where id = $1`, [sessionKey(s)]))).toMatch(nobody);
  const node = await kolab.createNode(s, 'functional_spec', 'Orders', 'orders');
  const draft = await kolab.draft(s, node, { elements: els({ R1: 'Orders can be cancelled.' }) });
  expect(await rejection(kolab.db.query(`update version set state = 'committed' where id = $1`, [draft]))).toMatch(nobody);
  const { invite } = await kolab.createInvite(await adminSession(kolab), { level: 'read' });
  expect(await rejection(kolab.db.query(`update kolab_invite set revoked_at = now() where id = $1`, [invite.id]))).toMatch(nobody);
  // No actor may be called admin: it names the admin token.
  expect(await rejection(kolab.addActor('Admin'))).toMatch(/"admin" is reserved/);
  expect(await rejection(kolab.db.query(`insert into actor(id, name, kind, created_by) values ('admin', 'x', 'person', 'admin')`))).toMatch(/actor_not_admin/);
});

/** A person holding Admin in the test kolab, with a session there. */
async function adminSession(kolab: Kolab) {
  if (!(await kolab.listActors()).some((a) => a.id === 'ada')) {
    await kolab.addActor('ada');
    await kolab.grant(TEST_KOLAB, 'ada', 'admin');
  }
  return kolab.openSession('ada', 'product');
}

const row = async (kolab: Kolab, sql: string, params: unknown[] = []) => (await kolab.db.query<Record<string, unknown>>(sql, params)).rows[0];

test('accounts, actors, kolabs, teams, identities and sessions record who made them: the admin, the person signing up, or the owner', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'bob']);
  expect(await row(kolab, `select created_by from account where id = 'test-org'`)).toStrictEqual({ created_by: ADMIN_DOER });
  expect(await row(kolab, `select a.created_by as actor, o.created_by as account from actor a join account o on o.id = a.id where a.id = 'alice'`)).toStrictEqual({ actor: ADMIN_DOER, account: ADMIN_DOER });
  expect(await row(kolab, `select created_by from kolab where id = $1`, [TEST_KOLAB])).toStrictEqual({ created_by: ADMIN_DOER });
  // An admin who is a person (W2.22) passes who they are.
  await kolab.addTeam('test-org', 'ops', { by: 'alice' });
  expect(await row(kolab, `select created_by from team where id = 'test-org/ops'`)).toStrictEqual({ created_by: 'alice' });
  await kolab.linkIdentity('alice', { provider: 'github', subject: '7' });
  expect(await row(kolab, `select linked_by from identity where actor_id = 'alice'`)).toStrictEqual({ linked_by: ADMIN_DOER });

  // A person signing up makes themselves, and the agents and kolab they make are theirs.
  const { actor: lee } = await kolab.signInWith({ provider: 'github', subject: '42', login: 'leen' });
  expect(await row(kolab, `select a.created_by as actor, o.created_by as account, i.linked_by from actor a join account o on o.id = a.id join identity i on i.actor_id = a.id where a.id = $1`, [lee]))
    .toStrictEqual({ actor: lee, account: lee, linked_by: lee });
  const agent = await kolab.addOwnAgent(lee, 'cli');
  expect(await row(kolab, `select created_by from actor where id = $1`, [agent])).toStrictEqual({ created_by: lee });
  await kolab.makeOwnKolab(lee, 'leens', 'Lee\'s');
  expect(await row(kolab, `select created_by from kolab where id = 'leens'`)).toStrictEqual({ created_by: lee });

  // Sessions: opened by the admin; ended by their own actor signing out, or by the admin.
  const a = await kolab.openSession('alice', 'product');
  const b = await kolab.openSession('bob', 'engineer');
  expect(await row(kolab, `select opened_by, ended_by from session where id = $1`, [sessionKey(a)])).toStrictEqual({ opened_by: ADMIN_DOER, ended_by: null });
  await kolab.endSession(a);
  await kolab.endSession({ actor: 'bob' }, { by: ADMIN_DOER });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(a)])).toStrictEqual({ ended_by: 'alice' });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(b)])).toStrictEqual({ ended_by: ADMIN_DOER });
  // Switching kolab or role: the person ends the old one and opens the new one.
  const c = await kolab.openSession('alice', 'product');
  const d = await kolab.switchSession(c, { kolab: TEST_KOLAB, role: 'engineer' });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(c)])).toStrictEqual({ ended_by: 'alice' });
  expect(await row(kolab, `select opened_by from session where id = $1`, [sessionKey(d)])).toStrictEqual({ opened_by: 'alice' });
  // A session that loses its access is ended by whoever took it, or by Kolab when it finds out on its own.
  await kolab.revoke(TEST_KOLAB, 'alice', { by: 'ada' });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(d)])).toStrictEqual({ ended_by: 'ada' });
  await kolab.grant(TEST_KOLAB, 'alice', 'write');
  const e = await kolab.openSession('alice', 'product');
  await kolab.db.query(`delete from kolab_grant where user_id = 'alice'`);   // outside Kolab's verbs
  await rejection(kolab.sessionInfo(e));
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(e)])).toStrictEqual({ ended_by: SYSTEM_ACTOR });
});

test('changes of access, memberships and outbox retries leave no row of their own, so the audit log records them, with who made them', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  // An outbox retry, by the admin.
  const s = await kolab.openSession('alice', 'product');
  const node = await kolab.createNode(s, 'functional_spec', 'Orders', 'orders');
  const v = await kolab.commit(s, node, { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.db.query(`insert into outbox(id, kind, version_id, state, attempts) values ('01JOB', 'after_commit', $1, 'dead', 10) on conflict do nothing`, [v]);
  const job = (await kolab.outboxJobs({ state: 'dead' }))[0].id;
  expect(await kolab.retryOutboxJob(job)).toBe(true);
  expect(await kolab.auditLog({ kolab: TEST_KOLAB, subject: job })).toMatchObject([{ action: 'outbox.retried', subject: job, by: ADMIN_DOER }]);

  await kolab.addActor('cy');
  await kolab.addMember('test-org', 'cy', 'member');
  await kolab.addTeam('test-org', 'ops');
  await kolab.addTeamMember('test-org/ops', 'cy');
  await kolab.grant(TEST_KOLAB, 'test-org/ops', 'read');
  await kolab.removeTeamMember('test-org/ops', 'cy');
  await kolab.removeMember('test-org', 'cy');
  await kolab.revoke(TEST_KOLAB, 'test-org/ops');
  // A kolab's own Admin changes a grant there (W3.6), and an invite grants what it names (W3.4).
  const ada = await adminSession(kolab);
  await kolab.changeGrant(ada, 'bob', 'read');
  await kolab.removeGrant(ada, 'bob');
  const { token } = await kolab.createInvite(ada, { level: 'triage' });
  await kolab.acceptInvite(token, 'cy');
  const log = (await kolab.auditLog()).reverse().map(({ action, kolab: k, subject, detail, by }) => ({ action, kolab: k, subject, detail, by }));
  expect(log.filter((e) => e.action !== 'outbox.retried' && (!['alice', 'bob', 'ada'].includes(e.subject) || e.by !== ADMIN_DOER))).toStrictEqual([
    { action: 'member.set', kolab: null, subject: 'cy', detail: { org: 'test-org', role: 'member' }, by: ADMIN_DOER },
    { action: 'team_member.added', kolab: null, subject: 'cy', detail: { team: 'test-org/ops' }, by: ADMIN_DOER },
    { action: 'grant.set', kolab: TEST_KOLAB, subject: 'test-org/ops', detail: { level: 'read', layers: [] }, by: ADMIN_DOER },
    { action: 'team_member.removed', kolab: null, subject: 'cy', detail: { team: 'test-org/ops' }, by: ADMIN_DOER },
    { action: 'member.removed', kolab: null, subject: 'cy', detail: { org: 'test-org' }, by: ADMIN_DOER },
    { action: 'grant.removed', kolab: TEST_KOLAB, subject: 'test-org/ops', detail: null, by: ADMIN_DOER },
    { action: 'grant.set', kolab: TEST_KOLAB, subject: 'bob', detail: { level: 'read', layers: [] }, by: 'ada' },
    { action: 'grant.removed', kolab: TEST_KOLAB, subject: 'bob', detail: null, by: 'ada' },
    { action: 'grant.set', kolab: TEST_KOLAB, subject: 'cy', detail: expect.objectContaining({ level: 'triage', layers: [] }), by: 'cy' },
  ]);
  expect((await kolab.auditLog({ subject: 'cy' })).map((e) => e.action)).toStrictEqual(['grant.set', 'member.removed', 'team_member.removed', 'team_member.added', 'member.set']);

  // The log is only ever added to, and no session reads it.
  expect(await rejection(kolab.db.query(`delete from audit_event`))).toMatch(/only ever added to/);
  expect(await rejection(kolab.db.query(`update audit_event set done_by = 'x'`))).toMatch(/only ever added to/);
  expect(await rejection(kolab.readAs(s, (q) => q.query(`select * from audit_event`)))).toMatch(/permission denied/);
});

test('nodes, invites, versions and grants record who made, revoked or submitted them; read_node and the activity feed name them', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const s = await kolab.openSession('alice', 'product');
  const node = await kolab.createNode(s, 'functional_spec', 'Orders', 'orders');
  expect(await row(kolab, `select created_by, created_at is not null as dated from node where id = $1`, [node])).toStrictEqual({ created_by: 'alice', dated: true });
  expect((await kolab.readNode(s, 'orders').catch(() => undefined))).toBeUndefined();   // no committed version yet
  const v = await kolab.commit(s, node, { elements: els({ R1: 'Orders can be cancelled.' }) });
  expect(await row(kolab, `select actor_id, submitted_by from version where id = $1`, [v])).toStrictEqual({ actor_id: 'alice', submitted_by: 'alice' });
  expect((await kolab.readNode(s, 'orders')).node.created_by).toBe('alice');
  const feed = await activity(kolab, s);
  expect(feed.find((r) => r.kind === 'node')).toMatchObject({ kind: 'node', node: 'orders', actor: 'alice', title: 'Orders' });

  // A ruling the admin applies is written as the actor given, and submitted by the admin.
  const r = await kolab.applyRuling(node, { deltas: [{ kind: 'override', element: 'R1', text: 'Orders can be cancelled before they ship.' }] }, { id: 'D70', actor: 'alice' });
  expect(await row(kolab, `select actor_id, submitted_by from version where id = $1`, [r.version])).toStrictEqual({ actor_id: 'alice', submitted_by: ADMIN_DOER });

  // An invite's revoker.
  const ada = await adminSession(kolab);
  const { invite } = await kolab.createInvite(ada, { level: 'read' });
  await kolab.revokeInvite(ada, invite.id);
  expect(await row(kolab, `select created_by, revoked_by from kolab_invite where id = $1`, [invite.id])).toStrictEqual({ created_by: 'ada', revoked_by: 'ada' });
});

test('an OAuth grant records who opened and ended its sessions, and who revoked it: its person, or Kolab on a replay', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const s256 = (x: string) => createHash('sha256').update(x).digest('base64url');
  const signIn = async () => {
    const client = (await kolab.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] })).id;
    const verifier = randomBytes(32).toString('base64url');
    const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256(verifier) });
    const { csrf } = await kolab.identifyAuthorization(binding, state, 'alice');
    const { code } = await kolab.consent(binding, csrf, { kolab: TEST_KOLAB, role: 'product', as: { kind: 'self' } });
    const exchange = () => kolab.exchangeCode({ code, clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeVerifier: verifier });
    return { tokens: await exchange(), exchange };
  };
  const first = await signIn();
  expect(await row(kolab, `select opened_by from session where id = $1`, [first.tokens.session])).toStrictEqual({ opened_by: 'alice' });
  const second = await signIn();
  // The newest sign-in wins: alice ended the first session by signing in again.
  expect(await row(kolab, `select ended_by from session where id = $1`, [first.tokens.session])).toStrictEqual({ ended_by: 'alice' });
  expect(await kolab.revokeToken(second.tokens.refreshToken)).toBe(true);
  expect(await row(kolab, `select g.revoked_by, s.ended_by from session s join oauth_grant g on g.id = s.grant_id where s.id = $1`, [second.tokens.session]))
    .toStrictEqual({ revoked_by: 'alice', ended_by: 'alice' });
  // A code used twice revokes the grant it opened: Kolab does that, not the person.
  const third = await signIn();
  await rejection(third.exchange());
  expect(await row(kolab, `select g.revoked_by, s.ended_by from session s join oauth_grant g on g.id = s.grant_id where s.id = $1`, [third.tokens.session]))
    .toStrictEqual({ revoked_by: SYSTEM_ACTOR, ended_by: SYSTEM_ACTOR });
});
