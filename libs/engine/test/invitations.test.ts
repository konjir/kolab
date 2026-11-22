// Invitations by account (migration 0053; Lee's instruction of 2026-11-16, konnect): a kolab's owner
// invites people by their GitHub usernames, each kept as the account's permanent id, so only that
// account accepts it; it waits until accepted or declined on the sign-in page, or withdrawn. A
// person's own sign-in that leaves the kolab to the page (choose:kolab, team:<name>), and a member
// removed or leaving, their agents with them. GitHub itself is never called: the lookup is injected.
import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { PERSON_SIGN_IN_ROLE, personScope, type AccountLookup } from '../src/index.js';
import { openKolab, rejection, type TestKolab } from '../src/testing.js';

const github = (subject: string, login: string) => ({ provider: 'github', subject, login });
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');
const VERIFIER = 'v'.repeat(43);
const CB = 'http://127.0.0.1:9/cb';

/** GitHub's accounts, as the lookup sees them: by login in any case. */
const ACCOUNTS: Record<string, { subject: string; login: string; person: boolean }> = {
  bob: { subject: '22', login: 'bob', person: true },
  cy: { subject: '33', login: 'cy', person: true },
  ann: { subject: '11', login: 'ann', person: true },
  'acme-org': { subject: '99', login: 'acme-org', person: false },
};
function lookup() {
  const asked: string[] = [];
  const find: AccountLookup = async (login) => { asked.push(login); return ACCOUNTS[login.toLowerCase()]; };
  return { provider: 'github', find, asked };
}

/** Ann, signed up with GitHub, owns `anns`, and works there as product. */
async function anns(kolab?: TestKolab) {
  const k = kolab ?? await openKolab();
  const { actor: ann } = await k.signInWith(github('11', 'ann'));
  await k.makeOwnKolab(ann, 'anns', 'Ann\'s');
  const session = await k.openSession(ann, 'product', { kolab: 'anns' });
  return { kolab: k, ann, session };
}

/** A person's own sign-in whose scope is `scope`, from an app on their own computer, signed in with GitHub as `who`, at its consent page. */
async function signingIn(kolab: TestKolab, who: { subject: string; login: string }, scope: string, redirectUris = [CB]) {
  const client = (await kolab.registerClient({ name: 'konnect', redirectUris })).id;
  const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: redirectUris[0], codeChallenge: s256(VERIFIER), scope });
  const { actor: person } = await kolab.signInWith(github(who.subject, who.login));
  const { csrf } = await kolab.identifyAuthorization(binding, state, person);
  const exchange = (code: string) => kolab.exchangeCode({ code, clientId: client, redirectUri: redirectUris[0], codeVerifier: VERIFIER });
  return { client, binding, csrf, person, exchange };
}

test('a scope that leaves the kolab to the page names choose:kolab or team:<name>, alone', () => {
  expect(personScope('konjir choose:kolab')).toStrictEqual({ choose: true });
  expect(personScope('konjir team:acme')).toStrictEqual({ team: 'acme' });
  expect(personScope('konjir kolab:anns role:product')).toBeUndefined();
  expect(personScope('konjir kolab:anns setup:cli:product')).toBeUndefined();
  expect(personScope(null)).toBeUndefined();
  for (const bad of ['konjir team:Acme', 'konjir team:', `konjir team:${'a'.repeat(41)}`, 'konjir choose:anything', 'konjir team:a team:b', 'konjir choose:kolab team:a',
    'konjir team:a kolab:a', 'konjir team:a agent:x', 'konjir choose:kolab role:engineer', 'konjir team:a setup:cli:product', 'konjir choose:kolab as:self']) {
    expect([bad, 'error' in (personScope(bad) ?? {})]).toStrictEqual([bad, true]);
  }
  expect(PERSON_SIGN_IN_ROLE).toBe('product');
});

test('the owner invites by GitHub username: each looked up first and kept by its permanent id; a name with no account, or an organization\'s, invites no one', async () => {
  const { kolab, session } = await anns();
  const l = lookup();
  const r = await kolab.inviteAccounts(session, ['@bob', 'Cy'], l);
  expect(r).toMatchObject({ kolab: 'anns', already_invited: [], already_members: [] });
  expect(r.invited).toMatchObject([
    { kolab: 'anns', account: 'bob', provider: 'github', level: 'read', invited_by: 'ann', state: 'open', settled_by: null, settled_at: null },
    { kolab: 'anns', account: 'Cy', provider: 'github', level: 'read', invited_by: 'ann', state: 'open' },
  ]);
  expect(r.invited[0].id).toMatch(/^ivt_[A-Za-z0-9_-]{16}$/);
  // The account's permanent id is what it keeps; the name only as typed, for display.
  expect((await kolab.db.query(`select login, provider, subject from kolab_invitation order by login`)).rows)
    .toStrictEqual([{ login: 'Cy', provider: 'github', subject: '33' }, { login: 'bob', provider: 'github', subject: '22' }]);

  // A name with no account refuses the whole call, by name, before anything is written; so does an organization's.
  expect(await rejection(kolab.inviteAccounts(session, ['ghost', 'dee', 'bob'], lookup()))).toMatch(/no GitHub account ghost, dee: check the spelling\. Nothing was invited/);
  expect(await rejection(kolab.inviteAccounts(session, ['acme-org'], lookup()))).toMatch(/acme-org isn't a person's account on GitHub \(an organization's or a bot's\)/);
  expect(await rejection(kolab.inviteAccounts(session, ['not a name'], l))).toMatch(/"not a name" isn't a GitHub username/);
  expect(await rejection(kolab.inviteAccounts(session, ['-bob'], l))).toMatch(/isn't a GitHub username/);
  expect(await rejection(kolab.inviteAccounts(session, [], l))).toMatch(/name at least one GitHub account/);
  expect(await rejection(kolab.inviteAccounts(session, Array.from({ length: 11 }, (_, i) => `u${i}`), l))).toMatch(/at most 10 accounts at once/);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_invitation`)).rows[0]).toStrictEqual({ n: 2 });

  // Again: the open invitation is the same one; the owner is a member already.
  const again = await kolab.inviteAccounts(session, ['BOB', 'ann'], l);
  expect(again).toMatchObject({ invited: [], already_invited: [{ id: r.invited[0].id, account: 'bob' }], already_members: ['ann'] });

  // The owner lists those that wait, newest first, a page at a time.
  const listed = await kolab.invitationsPage(session, { limit: 1 });
  expect(listed.items).toHaveLength(1);
  const rest = await kolab.invitationsPage(session, { cursor: listed.next! });
  expect([...listed.items, ...rest.items].map((i) => i.account).sort()).toStrictEqual(['Cy', 'bob']);
  expect(rest.next).toBeNull();
});

test('only the kolab\'s owner, a person, invites, lists and withdraws: never a member with Admin, never an agent', async () => {
  const { kolab, ann, session } = await anns();
  const { actor: eli } = await kolab.signInWith(github('44', 'eli'));
  await kolab.grant('anns', eli, 'admin');
  const admin = await kolab.openSession(eli, 'product', { kolab: 'anns' });
  const l = lookup();
  expect(await rejection(kolab.inviteAccounts(admin, ['bob'], l))).toMatch(/only the owner of kolab anns invites people there/);
  expect(await rejection(kolab.invitationsPage(admin))).toMatch(/only the owner of kolab anns lists its invitations there/);
  const agent = await kolab.addOwnAgent(ann, 'cli');
  await kolab.grant('anns', agent, 'write');
  const asAgent = await kolab.openSession(agent, 'product', { kolab: 'anns' });
  expect(await rejection(kolab.inviteAccounts(asAgent, ['bob'], l))).toMatch(/ann-cli is an agent: only a person invites people/);
  // Nothing was looked up for anyone who may not invite.
  expect(l.asked).toStrictEqual([]);
  const { invited: [inv] } = await kolab.inviteAccounts(session, ['bob'], l);
  expect(await rejection(kolab.withdrawInvitation(admin, inv.id))).toMatch(/only the owner of kolab anns withdraws its invitations there/);
  expect(await rejection(kolab.withdrawInvitation(session, 'ivt_nope'))).toMatch(/no open invitation ivt_nope in kolab anns/);
  expect(await kolab.withdrawInvitation(session, inv.id)).toMatchObject({ id: inv.id, state: 'withdrawn', settled_by: 'ann' });
  expect(await rejection(kolab.withdrawInvitation(session, inv.id))).toMatch(/no open invitation/);
  expect((await kolab.invitationsPage(session)).items).toStrictEqual([]);
});

test('the invited account, and only it, accepts on its sign-in page: it joins at Read, signs in there as itself, sends and reads messages, and brings its own agent', async () => {
  const { kolab, ann, session } = await anns();
  const { invited: [inv] } = await kolab.inviteAccounts(session, ['bob'], lookup());

  // Someone else who now calls themselves bob on GitHub (another account, another id) sees nothing, and can't take it.
  const imposter = await signingIn(kolab, { subject: '777', login: 'bob' }, 'konjir choose:kolab');
  expect(await kolab.chooseOptions(imposter.person)).toStrictEqual({ invitations: [], kolabs: [] });
  expect(await rejection(kolab.consentPerson(imposter.binding, imposter.csrf, { accept: inv.id }))).toMatch(/that invitation isn't one waiting for you/);
  expect(await kolab.reachable(imposter.person)).toStrictEqual([]);

  // The account invited, renamed on GitHub since, still has it.
  const bob = await signingIn(kolab, { subject: '22', login: 'robert' }, 'konjir choose:kolab');
  expect(bob.person).toBe('robert');
  const offered = await kolab.chooseOptions(bob.person);
  expect(offered).toStrictEqual({ kolabs: [], invitations: [{ id: inv.id, kolab: 'anns', title: 'Ann\'s', owner: 'ann', invited_by: 'ann', invited_by_login: 'ann', level: 'read', created_at: inv.created_at }] });
  // A kolab it isn't a member of can't be chosen instead.
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { kolab: 'anns' }))).toMatch(/you aren't a member of a kolab anns/);
  const done = await kolab.consentPerson(bob.binding, bob.csrf, { accept: inv.id });
  expect(done).toMatchObject({ kolab: 'anns', made: false, redirectUri: CB });
  const t = await bob.exchange(done.code);
  expect(t).toMatchObject({ actor: 'robert', kolab: 'anns', role: PERSON_SIGN_IN_ROLE, scope: 'konjir kolab:anns role:product' });
  expect(await kolab.access('robert', 'anns')).toStrictEqual({ level: 'read', layers: [] });
  expect((await kolab.invitationsPage(session)).items).toStrictEqual([]);
  expect((await kolab.db.query(`select accepted_by from kolab_invitation where id = $1`, [inv.id])).rows).toStrictEqual([{ accepted_by: 'robert' }]);
  expect((await kolab.auditLog({ kolab: 'anns', subject: 'robert' }))[0]).toMatchObject({ action: 'grant.set', by: 'robert', detail: { level: 'read', layers: [], invitation: inv.id } });

  // Read is enough to send and read messages…
  await kolab.sendMessage(t.accessToken, ann, 'hello from bob');
  expect((await kolab.readMessages(session)).messages.map((m) => m.message)).toStrictEqual(['hello from bob']);
  await kolab.sendMessage(session, 'robert', 'welcome');
  expect((await kolab.readMessages(t.accessToken)).messages.map((m) => m.message)).toStrictEqual(['welcome']);
  // …and to bring an agent of their own, which borrows their Read and sends too.
  const agentSignIn = await signingIn(kolab, { subject: '22', login: 'robert' }, 'konjir');
  const a = await kolab.consent(agentSignIn.binding, agentSignIn.csrf, { as: { kind: 'new-agent', label: 'claude' }, kolab: 'anns', role: 'product' });
  const at = await agentSignIn.exchange(a.code);
  expect(at.actor).toBe('robert-claude');
  expect(await kolab.access('robert-claude', 'anns')).toStrictEqual({ level: 'read', layers: [] });
  await kolab.sendMessage(at.accessToken, ann, 'and from my agent');

  // Accepted once: it is no longer offered, and can't be accepted again.
  const later = await signingIn(kolab, { subject: '22', login: 'robert' }, 'konjir choose:kolab');
  expect(await kolab.chooseOptions(later.person)).toMatchObject({ invitations: [], kolabs: [{ id: 'anns', access: { level: 'read' } }] });
  expect(await rejection(kolab.consentPerson(later.binding, later.csrf, { accept: inv.id }))).toMatch(/isn't one waiting for you/);
  // Choosing a kolab they are a member of signs them in there.
  const again = await kolab.consentPerson(later.binding, later.csrf, { kolab: 'anns' });
  expect(await later.exchange(again.code)).toMatchObject({ actor: 'robert', kolab: 'anns' });
});

test('accepting never lowers a grant; a declined or withdrawn invitation, or one whose kolab is archived, can\'t be accepted', async () => {
  const { kolab, session } = await anns();
  const { actor: cy } = await kolab.signInWith(github('33', 'cy'));
  const { invited: [forCy] } = await kolab.inviteAccounts(session, ['cy'], lookup());
  await kolab.grant('anns', cy, 'write', { layers: ['technical'] });
  const cyIn = await signingIn(kolab, { subject: '33', login: 'cy' }, 'konjir choose:kolab');
  await kolab.consentPerson(cyIn.binding, cyIn.csrf, { accept: forCy.id });
  expect(await kolab.access(cy, 'anns')).toStrictEqual({ level: 'write', layers: ['technical'] });

  const { invited: [forBob] } = await kolab.inviteAccounts(session, ['bob'], lookup());
  const bob = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir choose:kolab');
  // Declining is the person's own, of an invitation waiting for them alone.
  expect(await rejection(kolab.declineInvitation('cy', forBob.id))).toMatch(/isn't one waiting for you/);
  expect(await kolab.declineInvitation(bob.person, forBob.id)).toStrictEqual({ kolab: 'anns' });
  expect(await rejection(kolab.declineInvitation(bob.person, forBob.id))).toMatch(/isn't one waiting for you/);
  expect(await kolab.chooseOptions(bob.person)).toStrictEqual({ invitations: [], kolabs: [] });
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { accept: forBob.id }))).toMatch(/isn't one waiting for you/);
  expect((await kolab.db.query(`select declined_by from kolab_invitation where id = $1`, [forBob.id])).rows).toStrictEqual([{ declined_by: 'bob' }]);

  // A new one, a month later, withdrawn before it is accepted.
  await kolab.db.query(`update kolab_invitation set declined_at = now() - interval '31 days' where id = $1`, [forBob.id]);
  const { invited: [second] } = await kolab.inviteAccounts(session, ['bob'], lookup());
  expect(second.id).not.toBe(forBob.id);
  expect((await kolab.chooseOptions(bob.person)).invitations.map((i) => i.id)).toStrictEqual([second.id]);
  await kolab.withdrawInvitation(session, second.id);
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { accept: second.id }))).toMatch(/isn't one waiting for you/);

  // An archived kolab's invitations wait for no one.
  const { invited: [third] } = await kolab.inviteAccounts(session, ['bob'], lookup());
  await kolab.archive({ kolab: 'anns' });
  expect((await kolab.chooseOptions(bob.person)).invitations).toStrictEqual([]);
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { accept: third.id }))).toMatch(/isn't one waiting for you/);
  expect(await kolab.reachable(bob.person)).toStrictEqual([]);
});

test('the owner removes a member, and a member leaves: their grant goes, their agents\' with it, and every session of theirs there ends', async () => {
  const { kolab, ann, session } = await anns();
  const { actor: bob } = await kolab.signInWith(github('22', 'bob'));
  const { actor: cy } = await kolab.signInWith(github('33', 'cy'));
  for (const p of [bob, cy]) await kolab.grant('anns', p, 'read');
  const bobAgent = await kolab.addOwnAgent(bob, 'claude');
  const cyAgent = await kolab.addOwnAgent(cy, 'claude');
  await kolab.grant('anns', bobAgent, 'read');
  await kolab.grant('anns', cyAgent, 'read');
  const bobSession = await kolab.openSession(bob, 'product', { kolab: 'anns' });
  const bobAgentSession = await kolab.openSession(bobAgent, 'product', { kolab: 'anns' });
  const cySession = await kolab.openSession(cy, 'product', { kolab: 'anns' });
  const cyAgentSession = await kolab.openSession(cyAgent, 'product', { kolab: 'anns' });

  // Only the owner removes, never themselves, never an agent, never someone who isn't a member.
  expect(await rejection(kolab.removeKolabMember(bobSession, cy))).toMatch(/only the owner of kolab anns removes members there/);
  expect(await rejection(kolab.removeKolabMember(bobAgentSession, cy))).toMatch(/bob-claude is an agent: only a person removes members/);
  expect(await rejection(kolab.removeKolabMember(session, ann))).toMatch(/you own kolab anns, so you stay its member/);
  expect(await rejection(kolab.removeKolabMember(session, bobAgent))).toMatch(/bob-claude is an agent: remove its owner/);
  expect(await rejection(kolab.removeKolabMember(session, 'nobody'))).toMatch(/nobody isn't a member of kolab anns by a grant of their own, so nothing was removed/);

  const removed = await kolab.removeKolabMember(session, bob);
  expect(removed).toStrictEqual({ kolab: 'anns', removed: 'bob', agents: ['bob-claude'], ended: 2 });
  expect(await kolab.access(bob, 'anns')).toMatchObject({ level: null });
  expect(await kolab.access(bobAgent, 'anns')).toMatchObject({ level: null });
  expect(await kolab.sessionOpen(bobSession)).toBe(false);
  expect(await kolab.sessionOpen(bobAgentSession)).toBe(false);
  // The grants themselves are gone, the agent's too, so a later invitation brings back only what it gives.
  expect((await kolab.db.query(`select coalesce(user_id, agent_id) as who from kolab_grant where kolab_id = 'anns' order by 1`)).rows).toStrictEqual([{ who: 'cy' }, { who: 'cy-claude' }]);
  expect((await kolab.auditLog({ kolab: 'anns' })).filter((e) => e.action === 'grant.removed').map((e) => [e.subject, e.by])).toStrictEqual(expect.arrayContaining([['bob', 'ann'], ['bob-claude', 'ann']]));

  // A member leaves; an agent can't, and the owner can't.
  expect(await rejection(kolab.leaveKolab(cyAgentSession))).toMatch(/cy-claude is an agent: a person leaves a kolab/);
  expect(await rejection(kolab.leaveKolab(session))).toMatch(/you own kolab anns, so you can't leave it/);
  expect(await kolab.leaveKolab(cySession)).toStrictEqual({ left: 'anns', agents: ['cy-claude'], ended: 2 });
  expect(await kolab.sessionOpen(cySession)).toBe(false);
  expect(await kolab.sessionOpen(cyAgentSession)).toBe(false);
  expect(await kolab.access(cy, 'anns')).toMatchObject({ level: null });
  expect((await kolab.db.query(`select count(*)::int as n from kolab_grant where kolab_id = 'anns'`)).rows[0]).toStrictEqual({ n: 0 });
  // Ann is still there, alone.
  expect((await kolab.membersPage(session)).items.map((m) => m.actor)).toStrictEqual(['ann']);
});

test('team:<name>: a free name is made, private and the person\'s, with no agent; theirs already, it signs them in; anyone else\'s, it is refused with a free name, and never joined', async () => {
  const { kolab, session: ann } = await anns();
  // Free: made on Allow, and the sign-in works there, as the person.
  const bob = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme');
  expect(await kolab.teamPlan(bob.person, 'acme')).toStrictEqual({ kolab: 'acme', kind: 'make' });
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { team: 'other', shown: 'make' }))).toMatch(/this sign-in is for kolab acme only/);
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { kolab: 'acme' }))).toMatch(/this sign-in is for kolab acme only/);
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { team: 'acme', shown: 'member' }))).toMatch(/kolab acme changed since this page was shown/);
  expect(await kolab.kolabRow('acme')).toBeUndefined();
  const made = await kolab.consentPerson(bob.binding, bob.csrf, { team: 'acme', shown: 'make' });
  expect(made).toMatchObject({ kolab: 'acme', made: true });
  expect(await bob.exchange(made.code)).toMatchObject({ actor: 'bob', kolab: 'acme', role: 'product' });
  expect(await kolab.kolabRow('acme')).toMatchObject({ owner: 'bob', visibility: 'private', title: 'acme' });
  expect(await kolab.listActors({ owner: 'bob' })).toStrictEqual([]);

  // Theirs already: signed in, nothing made.
  const back = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme');
  expect(await kolab.teamPlan(back.person, 'acme')).toMatchObject({ kind: 'member', title: 'acme', access: { level: 'admin' } });
  const switched = await kolab.consentPerson(back.binding, back.csrf, { team: 'acme', shown: 'member' });
  expect(switched).toMatchObject({ kolab: 'acme', made: false });

  // Ann's: refused, with a free name, and an invitation waiting is pointed to; nothing joined.
  await kolab.inviteAccounts(ann, ['bob'], lookup());
  await kolab.makeOwnKolab('ann', 'anns-bob', 'taken');
  const theirs = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:anns');
  const plan = await kolab.teamPlan(theirs.person, 'anns');
  expect(plan).toMatchObject({ kolab: 'anns', kind: 'refused', suggest: 'anns-2' });
  expect(plan.kind === 'refused' && plan.refused).toBe('the kolab name anns is taken, by a kolab you aren\'t a member of: names are unique across Konjir, and this sign-in never joins anyone else\'s kolab. An invitation to anns waits for you: sign in without naming a kolab to accept it. The name anns-2 is free.');
  for (const shown of ['make', 'member']) expect(await rejection(kolab.consentPerson(theirs.binding, theirs.csrf, { team: 'anns', shown }))).toMatch(/the kolab name anns is taken/);
  expect(await kolab.access('bob', 'anns')).toMatchObject({ level: null });
  // Reserved, or past the person's limits, as makeOwnKolab refuses.
  expect(await kolab.teamPlan('bob', 'konjir-x')).toMatchObject({ kind: 'refused', refused: expect.stringMatching(/reserved for Konjir's own kolabs/) });
  // A public kolab read only because it is public is no membership.
  await kolab.db.query(`update kolab set visibility = 'public' where id = 'anns-bob'`);
  expect(await kolab.teamPlan('bob', 'anns-bob')).toMatchObject({ kind: 'refused' });
  const choosing = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir choose:kolab');
  expect((await kolab.chooseOptions(choosing.person)).kolabs.map((k) => k.id)).toStrictEqual(['acme']);
  expect(await rejection(kolab.consentPerson(choosing.binding, choosing.csrf, { kolab: 'anns-bob' }))).toMatch(/you aren't a member of a kolab anns-bob/);
});

test('a person\'s own sign-in that leaves the kolab to the page is only for an app on their own computer, only ever the person, and allowed only on its own page', async () => {
  const kolab = await openKolab();
  // A hosted app: refused, nothing made.
  const hosted = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme', ['https://app.example/cb']);
  expect(await rejection(kolab.consentPerson(hosted.binding, hosted.csrf, { team: 'acme', shown: 'make' }))).toMatch(/only for an app on your own computer/);
  expect(await kolab.kolabRow('acme')).toBeUndefined();
  // The ordinary consent refuses it, whatever it is asked: no agent, no other kolab.
  const local = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme');
  expect(await rejection(kolab.consent(local.binding, local.csrf, { as: { kind: 'new-agent', label: 'x' }, kolab: { name: 'acme', title: 'acme' }, role: 'product' })))
    .toMatch(/this sign-in is allowed on its own page only/);
  expect(await kolab.kolabRow('acme')).toBeUndefined();
  expect(await kolab.listActors({ owner: 'bob' })).toStrictEqual([]);
  // A scope that names it badly, or isn't one, is refused here too.
  const bad = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme agent:bob-x');
  expect(await rejection(kolab.consentPerson(bad.binding, bad.csrf, { team: 'acme', shown: 'make' }))).toMatch(/can't be allowed: it mixes/);
  const plain = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir');
  expect(await rejection(kolab.consentPerson(plain.binding, plain.csrf, { team: 'acme', shown: 'make' }))).toMatch(/doesn't leave its kolab to the page/);
  // Refused, the sign-in is released, and still works once corrected.
  const ok = await kolab.consentPerson(local.binding, local.csrf, { team: 'acme', shown: 'make' });
  expect(ok.kolab).toBe('acme');
  // Used once.
  expect(await rejection(kolab.consentPerson(local.binding, local.csrf, { team: 'acme', shown: 'member' }))).toMatch(/expired or was already used/);
});

test('konnect\'s own app, every redirect URI on its schemes, signs the person in as konnect\'s CLI does; a client mixing its scheme with any other redirect is refused, nothing made', async () => {
  const kolab = await openKolab();
  const native = ['https://www.konjir.com/konnect/app/oauth', 'com.konjir.konnect.dev:/oauth', 'com.konjir.konnect.preview:/oauth'];
  for (const mixed of [['https://www.konjir.com/konnect/app/oauth', 'https://app.example/cb'], ['https://www.konjir.com/konnect/app/oauth', CB]]) {
    const m = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme', mixed);
    expect([mixed, await rejection(kolab.consentPerson(m.binding, m.csrf, { team: 'acme', shown: 'make' }))])
      .toStrictEqual([mixed, 'AccessError: a sign-in that leaves its kolab to the page is only for an app on your own computer or phone, and this one receives its answer elsewhere']);
  }
  expect(await kolab.kolabRow('acme')).toBeUndefined();
  const app = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme', native);
  const r = await kolab.consentPerson(app.binding, app.csrf, { team: 'acme', shown: 'make' });
  expect([r.kolab, r.made, r.redirectUri]).toStrictEqual(['acme', true, 'https://www.konjir.com/konnect/app/oauth']);
  const t = await app.exchange(r.code);
  expect([t.actor, t.kolab, t.role, t.scope]).toStrictEqual([app.person, 'acme', 'product', 'konjir kolab:acme role:product']);
  // The code is good once: used again, it is refused, and the grant it issued is revoked.
  expect(await kolab.sessionOpen(t.accessToken)).toBe(true);
  expect(await rejection(app.exchange(r.code))).toMatch(/unknown, expired, already used/);
  expect(await kolab.sessionOpen(t.accessToken)).toBe(false);
  // choose:kolab too, from the dev build's scheme alone.
  const dev = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir choose:kolab', ['com.konjir.konnect.dev:/oauth']);
  expect((await kolab.consentPerson(dev.binding, dev.csrf, { kolab: 'acme' })).kolab).toBe('acme');
});

test('an invitation whose maker no longer owns the kolab, or is archived, waits for no one: it isn\'t listed or counted, and a new owner\'s invitation of the same account replaces it', async () => {
  const kolab = await openKolab();
  const { actor: amy } = await kolab.signInWith(github('11', 'amy'));
  const { actor: ben } = await kolab.signInWith(github('12', 'ben'));
  await kolab.addOrganization('acme');
  await kolab.addMember('acme', amy, 'owner', { by: 'admin' });
  await kolab.addMember('acme', ben, 'owner', { by: 'admin' });
  await kolab.createKolab('acme-app', { owner: 'acme' });
  const amyIn = await kolab.openSession(amy, 'product', { kolab: 'acme-app' });
  const benIn = await kolab.openSession(ben, 'product', { kolab: 'acme-app' });
  const { invited: [old] } = await kolab.inviteAccounts(amyIn, ['bob'], lookup());
  const bob = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir choose:kolab');
  expect((await kolab.chooseOptions(bob.person)).invitations.map((i) => [i.id, i.invited_by_login])).toStrictEqual([[old.id, 'amy']]);

  // Amy is an owner no more: her invitation waits for no one, and the owners' list doesn't show it.
  await kolab.addMember('acme', amy, 'member', { by: 'admin' });
  expect((await kolab.chooseOptions(bob.person)).invitations).toStrictEqual([]);
  expect((await kolab.invitationsPage(benIn)).items).toStrictEqual([]);
  // Ben invites the same account: the dead one is withdrawn, by him, and a fresh one made.
  const fresh = await kolab.inviteAccounts(benIn, ['bob'], lookup());
  expect(fresh).toMatchObject({ already_invited: [], invited: [{ invited_by: 'ben', state: 'open' }] });
  expect((await kolab.db.query(`select withdrawn_by from kolab_invitation where id = $1`, [old.id])).rows).toStrictEqual([{ withdrawn_by: 'ben' }]);
  expect((await kolab.invitationsPage(benIn)).items.map((i) => i.id)).toStrictEqual([fresh.invited[0].id]);
  expect((await kolab.chooseOptions(bob.person)).invitations.map((i) => i.invited_by)).toStrictEqual(['ben']);

  // An archived maker's invitations are no good either, as an invite whose maker lost Admin isn't.
  await kolab.archive({ actor: ben });
  expect((await kolab.chooseOptions(bob.person)).invitations).toStrictEqual([]);
  expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { accept: fresh.invited[0].id }))).toMatch(/isn't one waiting for you/);
});

test('a declined invitation sticks: the kolab can\'t ask that account again for 30 days, and says so', async () => {
  const { kolab, session } = await anns();
  const { invited: [inv] } = await kolab.inviteAccounts(session, ['bob'], lookup());
  const bob = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir choose:kolab');
  await kolab.declineInvitation(bob.person, inv.id);
  expect(await kolab.inviteAccounts(session, ['bob', 'cy'], lookup())).toMatchObject({ declined_recently: ['bob'], invited: [{ account: 'cy' }], already_invited: [] });
  expect((await kolab.chooseOptions(bob.person)).invitations).toStrictEqual([]);
  // After 30 days it may.
  await kolab.db.query(`update kolab_invitation set declined_at = now() - interval '31 days' where id = $1`, [inv.id]);
  expect(await kolab.inviteAccounts(session, ['bob'], lookup())).toMatchObject({ declined_recently: [], invited: [{ account: 'bob' }] });
});

test('removed from a public kolab, or leaving it, a member\'s sessions there end too, though anyone may read it', async () => {
  const { kolab, session } = await anns();
  await kolab.db.query(`update kolab set visibility = 'public' where id = 'anns'`);
  const { actor: bob } = await kolab.signInWith(github('22', 'bob'));
  const { actor: cy } = await kolab.signInWith(github('33', 'cy'));
  for (const p of [bob, cy]) await kolab.grant('anns', p, 'write');
  const bobIn = await kolab.openSession(bob, 'product', { kolab: 'anns' });
  const cyIn = await kolab.openSession(cy, 'product', { kolab: 'anns' });
  expect(await kolab.removeKolabMember(session, bob)).toMatchObject({ removed: 'bob', ended: 1 });
  expect(await kolab.sessionOpen(bobIn)).toBe(false);
  expect(await kolab.leaveKolab(cyIn)).toMatchObject({ left: 'anns', ended: 1 });
  expect(await kolab.sessionOpen(cyIn)).toBe(false);
  // A public kolab is still readable by them, as by anyone.
  expect(await kolab.access(bob, 'anns')).toStrictEqual({ level: 'read', layers: [] });
});

test('a member removed, or one who left, no longer reads or posts in the kolab\'s channels, even where a public kolab lets them read its nodes; what they wrote stays', async () => {
  const { kolab, session } = await anns();
  await kolab.db.query(`update kolab set visibility = 'public' where id = 'anns'`);
  const { actor: bob } = await kolab.signInWith(github('22', 'bob'));
  const { actor: cy } = await kolab.signInWith(github('33', 'cy'));
  for (const p of [bob, cy]) await kolab.grant('anns', p, 'read');
  const bobIn = await kolab.openSession(bob, 'product', { kolab: 'anns' });
  const cyIn = await kolab.openSession(cy, 'product', { kolab: 'anns' });
  await kolab.sendChannelMessage(bobIn, 'general', 'hello from bob');
  await kolab.readChannel(cyIn, 'general');
  await kolab.removeKolabMember(session, bob);
  await kolab.leaveKolab(cyIn);
  // Signed in again, as anyone may read a public kolab: no channel, to read or to post.
  for (const who of [bob, cy]) {
    const again = await kolab.openSession(who, 'product', { kolab: 'anns' });
    expect(await rejection(kolab.readChannel(again, 'general'))).toMatch(/AccessError/);
    expect(await rejection(kolab.sendChannelMessage(again, 'general', 'still here?'))).toMatch(/AccessError/);
    expect(await rejection(kolab.channelsPage(again))).toMatch(/AccessError/);
    await kolab.endSession(again);
  }
  // What bob wrote stays, for the members.
  expect((await kolab.readChannel(session, 'general')).messages.map((m) => m.message)).toContain('hello from bob');
});

test('a team sign-in\'s intent: intent:join or intent:create beside team:<name> only, once', () => {
  expect(personScope('konjir team:acme intent:join')).toStrictEqual({ team: 'acme', intent: 'join' });
  expect(personScope('konjir intent:create team:acme')).toStrictEqual({ team: 'acme', intent: 'create' });
  expect(personScope('konjir team:acme')).toStrictEqual({ team: 'acme' });
  for (const bad of ['konjir team:acme intent:', 'konjir team:acme intent:admin', 'konjir team:acme intent:join intent:create', 'konjir choose:kolab intent:join', 'konjir team:acme intent:Join']) {
    expect([bad, 'error' in (personScope(bad) ?? {})]).toStrictEqual([bad, true]);
  }
  // An intent alone is no person's sign-in.
  expect(personScope('konjir intent:join')).toBeUndefined();
});

test('intent:join never makes a kolab: a free name is refused as no such kolab; a member signs in; anyone else\'s is refused with no free name to make', async () => {
  const { kolab, session: ann } = await anns();
  const bob = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme intent:join');
  const free = await kolab.teamPlan(bob.person, 'acme', 'join');
  expect(free).toStrictEqual({ kolab: 'acme', kind: 'refused', refused: expect.stringMatching(/^no kolab named acme exists, so there is nothing to join and nothing was made/), refusedForApp: expect.any(String) });
  expect(free.kind === 'refused' && free.refused).not.toMatch(/free|create|make it/i);
  for (const shown of ['make', 'member']) expect(await rejection(kolab.consentPerson(bob.binding, bob.csrf, { team: 'acme', shown }))).toMatch(/no kolab named acme exists/);
  expect(await kolab.kolabRow('acme')).toBeUndefined();

  // Someone else's, with an invitation waiting: pointed to it, and no free name offered.
  await kolab.inviteAccounts(ann, ['bob'], lookup());
  const theirs = await kolab.teamPlan(bob.person, 'anns', 'join');
  expect(theirs).toMatchObject({ kind: 'refused', refused: expect.stringMatching(/you aren't a member of kolab anns, so this sign-in can't join it.*An invitation to anns waits for you/) });
  expect(theirs).not.toHaveProperty('suggest');
  expect(await kolab.access('bob', 'anns')).toMatchObject({ level: null });

  // A member: signed in, as without an intent.
  await kolab.makeOwnKolab('bob', 'bobs', 'Bob\'s');
  const mine = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:bobs intent:join');
  expect(await kolab.teamPlan(mine.person, 'bobs', 'join')).toMatchObject({ kind: 'member', title: 'Bob\'s' });
  expect(await kolab.consentPerson(mine.binding, mine.csrf, { team: 'bobs', shown: 'member' })).toMatchObject({ kolab: 'bobs', made: false });
});

test('intent:create only makes a kolab: a taken name is refused with a free one, even the person\'s own; a free one is made', async () => {
  const { kolab } = await anns();
  await kolab.signInWith(github('22', 'bob'));
  await kolab.makeOwnKolab('bob', 'bobs', 'Bob\'s');
  // Their own: refused, with a free name, and nothing joined or made.
  const own = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:bobs intent:create');
  const plan = await kolab.teamPlan(own.person, 'bobs', 'create');
  expect(plan).toMatchObject({ kind: 'refused', suggest: 'bobs-bob' });
  expect(plan.kind === 'refused' && plan.refused).toBe('the kolab name bobs is taken, by a kolab you are a member of: join it instead of creating it. This sign-in only creates a new kolab, and names are unique across Konjir. The name bobs-bob is free.');
  for (const shown of ['make', 'member']) expect(await rejection(kolab.consentPerson(own.binding, own.csrf, { team: 'bobs', shown }))).toMatch(/the kolab name bobs is taken/);
  // Someone else's: refused alike, with a free name.
  expect(await kolab.teamPlan('bob', 'anns', 'create')).toMatchObject({ kind: 'refused', suggest: 'anns-bob', refused: expect.stringMatching(/^the kolab name anns is taken\. This sign-in only creates/) });
  // Free: made.
  const fresh = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir team:acme intent:create');
  expect(await kolab.teamPlan(fresh.person, 'acme', 'create')).toStrictEqual({ kolab: 'acme', kind: 'make' });
  expect(await kolab.consentPerson(fresh.binding, fresh.csrf, { team: 'acme', shown: 'make' })).toMatchObject({ kolab: 'acme', made: true });
  expect(await kolab.kolabRow('acme')).toMatchObject({ owner: 'bob', visibility: 'private' });
});

test('a person removes their own agent from the kolab: its grant goes, its sign-ins there are revoked and its sessions end; never someone else\'s, never by an agent', async () => {
  const { kolab, session } = await anns();
  const { actor: bob } = await kolab.signInWith(github('22', 'bob'));
  await kolab.grant('anns', bob, 'read');
  const bobIn = await kolab.openSession(bob, 'product', { kolab: 'anns' });
  const annAgent = await kolab.addOwnAgent('ann', 'claude');
  const annOther = await kolab.addOwnAgent('ann', 'helper');
  const bobAgent = await kolab.addOwnAgent(bob, 'claude');
  for (const a of [annAgent, annOther, bobAgent]) await kolab.grant('anns', a, 'read');
  await kolab.makeOwnKolab('ann', 'elsewhere', 'Elsewhere');
  await kolab.grant('elsewhere', annAgent, 'read');
  const agentIn = await kolab.openSession(annAgent, 'product', { kolab: 'anns' });
  const bobAgentIn = await kolab.openSession(bobAgent, 'product', { kolab: 'anns' });
  // Two sign-ins of the agent's: one to this kolab, one to another.
  await kolab.db.query(`insert into oauth_grant(id, client_id, actor_id, person_id, scope, expires_at) values
    ($2, 'c', $1, 'ann', 'konjir kolab:anns role:product', now() + interval '1 day'),
    ($3, 'c', $1, 'ann', 'konjir kolab:elsewhere role:product', now() + interval '1 day')`, [annAgent, 'g'.repeat(22), 'h'.repeat(22)]);

  // Never someone else's (refused as no agent of theirs), never by an agent, never a name that is none.
  expect(await rejection(kolab.removeOwnAgent(session, 'bob-claude'))).toMatch(/AccessError: you have no agent bob-claude/);
  expect(await rejection(kolab.removeOwnAgent(session, 'bob/claude'))).toMatch(/AccessError: you have no agent bob\/claude/);
  expect(await rejection(kolab.removeOwnAgent(bobIn, 'ann-claude'))).toMatch(/AccessError: you have no agent ann-claude/);
  expect(await rejection(kolab.removeOwnAgent(agentIn, 'claude'))).toMatch(/AccessError: ann-claude is an agent: only a person removes their agents/);
  expect(await rejection(kolab.removeOwnAgent(session, 'nobody'))).toMatch(/AccessError: you have no agent nobody/);
  expect(await kolab.access(bobAgent, 'anns')).toMatchObject({ level: 'read' });

  // By its label: its grant here goes, its sign-in here is revoked, and its session here ends.
  expect(await kolab.removeOwnAgent(session, 'claude')).toStrictEqual({ kolab: 'anns', removed: 'ann-claude', label: 'claude', revoked: 1, ended: 1 });
  expect(await kolab.access(annAgent, 'anns')).toMatchObject({ level: null });
  expect(await kolab.sessionOpen(agentIn)).toBe(false);
  expect((await kolab.db.query(`select id, revoked_at is not null as revoked, revoked_by from oauth_grant order by id`)).rows)
    .toStrictEqual([{ id: 'g'.repeat(22), revoked: true, revoked_by: 'ann' }, { id: 'h'.repeat(22), revoked: false, revoked_by: null }]);
  // Elsewhere it keeps what it had; the person, the other agents, and Bob's agent are untouched.
  expect(await kolab.access(annAgent, 'elsewhere')).toMatchObject({ level: 'read' });
  await kolab.endSession(await kolab.openSession(annAgent, 'product', { kolab: 'elsewhere' }));
  expect(await kolab.sessionOpen(session)).toBe(true);
  expect(await kolab.sessionOpen(bobAgentIn)).toBe(true);
  expect(await kolab.access(annOther, 'anns')).toMatchObject({ level: 'read' });
  expect((await kolab.auditLog({ kolab: 'anns' })).filter((e) => e.action === 'grant.removed').map((e) => [e.subject, e.by])).toStrictEqual([['ann-claude', 'ann']]);
  // Removed already: nothing to remove.
  expect(await rejection(kolab.removeOwnAgent(session, 'claude'))).toMatch(/TenancyError: ann-claude holds no grant in kolab anns, so nothing was removed/);
  // By its whole name, or <owner>/<label>; and it can be given access here again.
  expect(await kolab.removeOwnAgent(session, 'ann/helper')).toMatchObject({ removed: 'ann-helper', label: 'helper', revoked: 0, ended: 0 });
  await kolab.grant('anns', annAgent, 'read');
  expect(await kolab.access(annAgent, 'anns')).toMatchObject({ level: 'read' });
  expect(await kolab.removeOwnAgent(session, 'ann-claude')).toMatchObject({ removed: 'ann-claude', ended: 0 });
});

test('a person who joins by accepting an invitation, or by an invite link, starts unread at their joining', async () => {
  const { kolab, session } = await anns();
  await kolab.sendChannelMessage(session, 'general', 'before anyone');
  const { invited: [inv] } = await kolab.inviteAccounts(session, ['bob'], lookup());
  const bob = await signingIn(kolab, { subject: '22', login: 'bob' }, 'konjir choose:kolab');
  await kolab.consentPerson(bob.binding, bob.csrf, { accept: inv.id });
  const bobIn = await kolab.openSession('bob', 'product', { kolab: 'anns' });
  expect(await kolab.unreadChannels(bobIn)).toStrictEqual([]);
  expect((await kolab.channelMessagesPage(bobIn, 'general')).items.map((m) => m.message)).toStrictEqual(['before anyone']);

  const { token } = await kolab.createInvite(session, { level: 'read' });
  const { actor: cy } = await kolab.signInWith(github('33', 'cy'));
  await kolab.acceptInvite(token, cy);
  const cyIn = await kolab.openSession(cy, 'product', { kolab: 'anns' });
  expect(await kolab.unreadChannels(cyIn)).toStrictEqual([]);
  const now = await kolab.sendChannelMessage(session, 'general', 'after both');
  for (const s of [bobIn, cyIn]) expect((await kolab.unreadChannels(s)).map((c) => c.items.map((m) => m.id))).toStrictEqual([[now.id]]);
});
