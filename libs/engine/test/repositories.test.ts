// Repositories, and evidence tied to them (W5.2a; KON7, PLN16, D98 rulings 1 and 2, D102; migration
// 0032): only a person with Maintain or Admin registers a repository, never an agent, pinned by its
// root commit; commit and pull-request evidence names a registered repository (the package's own by
// default), with its links inside it; the first approval by someone other than the registrar and the
// assignee confirms it; a package's repo names a registered repository (PLN2); repositories are the
// kolab's own, immutable but for confirming and archiving once.
import { expect, test } from '@jest/globals';
import { type Kolab } from '@konjir/engine';
import { els, openKolab, people, registeredRepository, rejection, testRoot, testStore, TEST_KOLAB } from '@konjir/engine/testing';
import { ADMIN_DOER, type ElementInput } from '@konjir/types';

const POSTGRES = !!process.env.KONJIR_TEST_DATABASE_URL;
const ORDERS = 'https://github.com/acme/orders';
const sha = (c: string) => c.repeat(40);
const COMMIT = (c = 'a', extra: Record<string, unknown> = {}) => ({ kind: 'commit' as const, sha: sha(c), title: `Build it (${c})`, files: ['src/orders.ts'], ...extra });

const PLAN: ElementInput[] = [
  { id: 'W1', text: 'Build the cancel endpoint.', work: { done_when: 'It cancels.' } },
  { id: 'W2', text: 'Build the shipping queue.' },
  { id: 'W3', text: 'Build the tracking page.' },
];

/**
 * A kolab with a spec, its binding orders-pg and a plan of three packages, each delivering one binding
 * element. Mia, a person with Maintain, registers repositories; bob and eve are engineers (persons);
 * carol only reads.
 */
async function planned(opts: { databaseUrl?: string } = {}) {
  const kolab = await openKolab(opts.databaseUrl ? { databaseUrl: opts.databaseUrl } : {});
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.', R2: 'Orders ship in a day.', R3: 'Orders can be tracked.' }) });
  await kolab.createNode(bob, 'binding', 'Orders on Postgres', 'orders-pg');
  const spec = (await kolab.latestCommitted('orders'))!.id;
  const bv = await kolab.draft(bob, 'orders-pg', {
    elements: els({ b1: 'A cancel endpoint.', b2: 'A shipping queue.', b3: 'A tracking page.' }),
    links: ['b1', 'b2', 'b3'].map((b, i) => ({ kind: 'dependency' as const, sourceElement: b, target: spec, targetElement: `R${i + 1}` })),
  });
  expect((await kolab.submit(bob, bv)).ok).toBe(true);
  await kolab.createNode(bob, 'plan', 'Plan', 'orders-plan');
  const delivers = (from: string, to: string) => ({ kind: 'dependency' as const, sourceElement: from, target: bv, targetElement: to });
  const pv = await kolab.draft(bob, 'orders-plan', { elements: PLAN, links: [delivers('W1', 'b1'), delivers('W2', 'b2'), delivers('W3', 'b3')] });
  expect((await kolab.submit(bob, pv)).ok).toBe(true);
  await people(kolab, 'eve', { layers: ['technical'] });
  await people(kolab, 'mia', { level: 'maintain' });
  await people(kolab, 'carol', { level: 'read' });
  const eve = await kolab.openSession('eve', 'engineer');
  const mia = await kolab.openSession('mia', 'engineer');
  const carol = await kolab.openSession('carol', 'engineer');
  return { kolab, product, bob, eve, mia, carol, binding: bv };
}

const W = (id: string) => `kj:orders-plan#${id}`;

async function pull(kolab: Kolab, session: string): Promise<string> {
  const r = await kolab.pullWork(session);
  if (!r.pulled) throw new Error(r.why);
  return r.item.id;
}

const evidenceCount = async (kolab: Kolab) => (await kolab.db.query<{ n: number }>(`select count(*)::int as n from evidence`)).rows[0].n;

test('only a person with Maintain or Admin registers a repository, never an agent; it is pinned by its root commit, unconfirmed, and audited (D98 ruling 1)', async () => {
  const { kolab, bob, mia, product, carol } = await planned();
  // An agent is refused, whatever its access; so is a person who holds only Write.
  await kolab.addActor('mia-bot', { owner: 'mia', by: ADMIN_DOER });
  await kolab.grant(TEST_KOLAB, 'mia-bot', 'write', { by: ADMIN_DOER });
  const bot = await kolab.openSession('mia-bot', 'engineer');
  expect(await rejection(kolab.registerRepository(bot, { url: ORDERS, root_sha: testRoot() })))
    .toBe('AccessError: mia-bot is an agent, and an agent registers no repository: a person with Maintain or Admin in kolab test registers it (D98)');
  expect(await rejection(kolab.registerRepository(bob, { url: ORDERS, root_sha: testRoot() })))
    .toMatch(/^AccessError: registering a repository in kolab test needs Maintain or Admin there \(D98\); bob holds/);
  expect(await rejection(kolab.registerRepository(product, { url: ORDERS, root_sha: testRoot() }))).toMatch(/^AccessError: registering a repository in kolab test needs Maintain/);
  expect((await kolab.db.query(`select 1 from repository`)).rows).toStrictEqual([]);
  // Mia registers it, from either role, as the binding's implementation: its URL canonical, its root commit lower case.
  const r = await kolab.registerRepository(mia, { url: 'https://GitHub.com/acme/orders.git/', root_sha: 'F'.repeat(40), binding: 'orders-pg' });
  expect(r).toStrictEqual({
    id: expect.any(String), url: ORDERS, root_sha: testRoot(), binding: 'orders-pg', registered_by: 'mia', registered_at: expect.any(String),
    confirmed: false, confirmed_by: null, confirmed_at: null, confirmed_by_work: null, archived_at: null,
  });
  expect((await kolab.auditLog({ kolab: TEST_KOLAB })).filter((a) => a.action.startsWith('repository.')))
    .toStrictEqual([expect.objectContaining({ action: 'repository.registered', subject: r.id, by: 'mia', detail: { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' } })]);
  // Every session of the kolab lists it, one that holds only Read too.
  expect((await kolab.listRepositories(carol)).items.map((x) => x.url)).toStrictEqual([ORDERS]);
}, 60_000);

test('a repository\'s URL and root commit are checked: https only, with no user, password, query or fragment, refused rather than stripped; one live registration a URL, one implementation a binding (D98, D38)', async () => {
  const { kolab, mia } = await planned();
  const refused = (url: unknown, root: unknown = testRoot()) => rejection(kolab.registerRepository(mia, { url, root_sha: root }));
  expect(await refused('http://github.com/acme/orders')).toMatch(/^GateError: a repository is named by its https URL, not http/);
  expect(await refused('git@github.com:acme/orders.git')).toMatch(/^GateError: .* isn't a URL|^GateError: a repository is named by its https URL/);
  expect(await refused('https://x-access-token:ghp_secret@github.com/acme/orders')).toMatch(/carries a user or password, which may be a credential/);
  expect(await refused('https://github.com/acme/orders?token=ghp_secret')).toMatch(/has no query or fragment/);
  expect(await refused('https://github.com/acme/orders#access_token=x')).toMatch(/has no query or fragment/);
  expect(await refused('https://github.com/')).toMatch(/names no repository/);
  expect(await refused(`https://github.com/${'a'.repeat(250)}`)).toMatch(/the limit is 200/);
  expect(await refused(ORDERS, 'abc')).toMatch(/^GateError: root_sha is the repository's root commit, its full sha/);
  expect(await refused(ORDERS, 'g'.repeat(40))).toMatch(/root_sha is the repository's root commit/);
  // No credential reached the database or the audit log.
  expect((await kolab.db.query(`select 1 from repository`)).rows).toStrictEqual([]);
  expect(JSON.stringify(await kolab.auditLog({ kolab: TEST_KOLAB }))).not.toMatch(/ghp_secret/);
  // A SHA-256 root commit is taken.
  await kolab.registerRepository(mia, { url: 'https://gitlab.example.com:8443/group/sub/orders', root_sha: 'a'.repeat(64) });
  // One live registration a URL, in any case; the binding takes one implementation, and a binding only.
  const r = await kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' });
  expect(await refused('https://github.com/ACME/Orders')).toBe(`GateError: https://github.com/ACME/Orders is already registered in kolab test (konjir_list_repositories)`);
  expect(await rejection(kolab.registerRepository(mia, { url: 'https://github.com/acme/other', root_sha: testRoot(), binding: 'orders-pg' })))
    .toMatch(/^GateError: binding orders-pg already has its implementation: a binding is implemented in one repository \(D38\)/);
  expect(await rejection(kolab.registerRepository(mia, { url: 'https://github.com/acme/other', root_sha: testRoot(), binding: 'orders-plan' })))
    .toBe('GateError: orders-plan is a plan, not a binding: a repository implements a binding (KON7, D38)');
  expect(await rejection(kolab.registerRepository(mia, { url: 'https://github.com/acme/other', root_sha: testRoot(), binding: 'elsewhere/orders-pg' }))).toMatch(/no node|not found|isn't|elsewhere/);
  // Archiving it frees its URL and its binding; it is listed again only when asked. An agent archives nothing.
  await kolab.addActor('mia-bot', { owner: 'mia', by: ADMIN_DOER });
  await kolab.grant(TEST_KOLAB, 'mia-bot', 'write', { by: ADMIN_DOER });
  expect(await rejection(kolab.archiveRepository(await kolab.openSession('mia-bot', 'engineer'), ORDERS))).toMatch(/^AccessError: mia-bot is an agent, and an agent archives no repository/);
  expect(await kolab.archiveRepository(mia, 'https://github.com/acme/orders.git')).toMatchObject({ id: r.id, archived_at: expect.any(String) });
  expect(await rejection(kolab.archiveRepository(mia, r.id))).toBe(`GateError: ${ORDERS} is archived already`);
  expect((await kolab.listRepositories(mia)).items.map((x) => x.url)).toStrictEqual(['https://gitlab.example.com:8443/group/sub/orders']);
  expect((await kolab.listRepositories(mia, { archived: true })).items.map((x) => [x.url, !!x.archived_at])).toStrictEqual([
    [ORDERS, true], ['https://gitlab.example.com:8443/group/sub/orders', false],
  ]);
  const again = await kolab.registerRepository(mia, { url: ORDERS, root_sha: 'e'.repeat(40), binding: 'orders-pg' });
  expect(again.id).not.toBe(r.id);
  expect((await kolab.auditLog({ kolab: TEST_KOLAB })).filter((a) => a.action.startsWith('repository.')).map((a) => a.action).sort())
    .toStrictEqual(['repository.archived', 'repository.registered', 'repository.registered', 'repository.registered']);
  // Pages: one at a time, by URL.
  const first = await kolab.listRepositories(mia, { archived: true }, { limit: 1 });
  expect(first.items).toHaveLength(1);
  const rest = await kolab.listRepositories(mia, { archived: true }, { cursor: first.next! });
  expect([...first.items, ...rest.items].map((x) => x.id).sort()).toStrictEqual([r.id, again.id, (await kolab.listRepositories(mia)).items.find((x) => x.url.includes('gitlab'))!.id].sort());
}, 60_000);

test('evidence names its repository: the package\'s own by default; none, an unregistered or archived one, another than its own, or a link outside it is refused, and nothing is written (D98 ruling 2)', async () => {
  const { kolab, bob, mia } = await planned();
  const id = await pull(kolab, bob);
  // No repository yet: the commit has nowhere to be.
  expect(await rejection(kolab.addEvidence(bob, W(id), [COMMIT()])))
    .toMatch(/^GateError: evidence 1 \(a commit\) names no repository, and kj:orders-plan#W1 has none of its own/);
  expect(await rejection(kolab.addEvidence(bob, W(id), [COMMIT('a', { repo: ORDERS })])))
    .toMatch(/^GateError: https:\/\/github\.com\/acme\/orders isn't a repository registered in kolab test, or it is archived/);
  // A test run needs none, and takes none.
  expect(await kolab.addEvidence(bob, W(id), [{ kind: 'test_run', title: 'npm test: 1 passed' }])).toMatchObject({ recorded: 1 });
  expect(await rejection(kolab.addEvidence(bob, W(id), [{ kind: 'test_run', title: 'x', repo: ORDERS }]))).toMatch(/is a test run, which takes no repo/);
  await kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' });
  await kolab.registerRepository(mia, { url: 'https://github.com/acme/other', root_sha: testRoot('e') });
  const before = await evidenceCount(kolab);
  // Its own repository by default, or named; another is refused, and so is a link outside its own.
  expect(await rejection(kolab.addEvidence(bob, W(id), [COMMIT('b'), COMMIT('c', { repo: 'https://github.com/acme/other' })])))
    .toBe('GateError: evidence 2 (a commit) is in https://github.com/acme/other, and kj:orders-plan#W1 is done in https://github.com/acme/orders (it is its binding\'s implementation, KON7): record that repository\'s commits and pull requests, or change the package\'s repo in the plan');
  for (const url of ['https://github.com/evil/orders/pull/1', 'https://github.com/acme/orders-evil/pull/1', 'https://github.com/acme/orders']) {
    expect(await rejection(kolab.addEvidence(bob, W(id), [{ kind: 'pull_request', url }]))).toMatch(/^GateError: evidence 1 \(a pull request\)'s url .* isn't inside its repository, https:\/\/github\.com\/acme\/orders/);
  }
  expect(await rejection(kolab.addEvidence(bob, W(id), [COMMIT('b', { url: `https://github.com/evil/orders/commit/${sha('b')}` })]))).toMatch(/\(a commit\)'s url .* isn't inside its repository/);
  expect(await rejection(kolab.addEvidence(bob, W(id), [COMMIT('b', { repo: 'http://github.com/acme/orders' })]))).toMatch(/^GateError: evidence 1's repo: a repository is named by its https URL/);
  expect(await evidenceCount(kolab)).toBe(before);
  // Accepted: its own repository, named or not, in any case and with .git; a pull request under it, whatever the case.
  expect(await kolab.addEvidence(bob, W(id), [COMMIT('b'), COMMIT('c', { repo: 'https://GITHUB.com/acme/orders.git', url: `${ORDERS}/commit/${sha('c')}` }),
    { kind: 'pull_request', url: 'https://github.com/Acme/Orders/pull/7', pr: 7 }])).toMatchObject({ recorded: 3, already: 0 });
  // Delivered again: already counted.
  expect(await kolab.addEvidence(bob, W(id), [COMMIT('b', { repo: ORDERS }), COMMIT('c'), { kind: 'pull_request', url: 'https://github.com/acme/orders/pull/7/' }]))
    .toMatchObject({ recorded: 0, already: 3 });
  const w = await kolab.readWork(bob, W(id));
  expect(w.repository).toStrictEqual({ url: ORDERS, root_sha: testRoot(), confirmed: false, via: 'binding' });
  expect(w.evidence.map((e) => [e.kind, e.repository, e.confirmed]).sort()).toStrictEqual([
    ['commit', ORDERS, false], ['commit', ORDERS, false], ['pull_request', ORDERS, false], ['test_run', undefined, undefined],
  ]);
  // Archived: no evidence names it from then on, and submitting with it is refused.
  await kolab.archiveRepository(mia, ORDERS);
  expect(await rejection(kolab.submitWork(bob, W(id), { evidence: [COMMIT('d', { repo: ORDERS })] }))).toMatch(/isn't a repository registered in kolab test, or it is archived/);
  // Its evidence keeps naming it.
  expect((await kolab.readWork(bob, W(id))).evidence.filter((e) => e.kind !== 'test_run').map((e) => e.repository)).toStrictEqual([ORDERS, ORDERS, ORDERS]);
}, 60_000);

test('a package\'s repo names a registered repository: PLN2 refuses one that isn\'t, and its evidence goes there, not to the binding\'s (KON7, D38)', async () => {
  const { kolab, bob, mia } = await planned();
  await kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' });
  const withRepo = PLAN.map((e) => (e.id === 'W2' ? { ...e, work: { repo: 'https://github.com/acme/queue.git' } } : e));
  const refused = await kolab.submit(bob, await kolab.draft(bob, 'orders-plan', { elements: withRepo }));
  expect(refused.ok).toBe(false);
  expect(refused.note).toMatch(/^Plan checks failed \(PLN2\): W2's repo https:\/\/github\.com\/acme\/queue\.git isn't a repository registered in kolab test \(KON7\)/);
  await kolab.registerRepository(mia, { url: 'https://github.com/acme/queue', root_sha: testRoot('d') });
  expect((await kolab.submit(bob, refused.version)).ok).toBe(true);
  expect(await pull(kolab, bob)).toBe('W1');
  await kolab.releaseWork(bob, W('W1'));
  await kolab.reassignWork(mia, W('W2'), 'bob');
  const w = await kolab.readWork(bob, W('W2'));
  expect(w.repository).toStrictEqual({ url: 'https://github.com/acme/queue', root_sha: testRoot('d'), confirmed: false, via: 'repo' });
  expect(await rejection(kolab.addEvidence(bob, W('W2'), [COMMIT('a', { repo: ORDERS })])))
    .toMatch(/is in https:\/\/github\.com\/acme\/orders, and kj:orders-plan#W2 is done in https:\/\/github\.com\/acme\/queue \(its repo names it, KON7\)/);
  await kolab.addEvidence(bob, W('W2'), [COMMIT('a')]);
  expect((await kolab.readWork(bob, W('W2'))).evidence.map((e) => e.repository)).toStrictEqual(['https://github.com/acme/queue']);
  // Archived, the repo no longer passes PLN2, and the package's context names no repository.
  await kolab.archiveRepository(mia, 'https://github.com/acme/queue');
  expect((await kolab.readWork(bob, W('W2'))).repository).toBeNull();
  const again = await kolab.submit(bob, await kolab.draft(bob, 'orders-plan', { deltas: [{ kind: 'override', element: 'W1', text: 'Build the cancel endpoint, again.' }] }));
  expect(again.note).toMatch(/W2's repo .* isn't a repository registered/);
}, 60_000);

test('the first approval by someone other than the registrar and the assignee confirms a repository; a request for changes, an approval by the registrar and Done unreviewed don\'t (D98 ruling 1, D102)', async () => {
  const { kolab, bob, eve, mia } = await planned();
  const r = await kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' });
  const confirmed = async () => (await kolab.listRepositories(bob)).items.find((x) => x.id === r.id)!;
  // W1: changes requested by eve, then approved by mia, its registrar: still unconfirmed.
  await pull(kolab, bob);
  expect((await kolab.submitWork(bob, W('W1'), { evidence: [COMMIT('a')] })).state).toBe('in_review');
  expect(await kolab.reviewWork(eve, W('W1'), { verdict: 'request_changes', note: 'Test the refund.' })).toMatchObject({ confirmed_repositories: [] });
  await kolab.submitWork(bob, W('W1'), { evidence: [COMMIT('b')] });
  expect(await kolab.reviewWork(mia, W('W1'), { verdict: 'approve' })).toMatchObject({ state: 'done', confirmed_repositories: [] });
  expect(await confirmed()).toMatchObject({ confirmed: false, confirmed_by: null });
  // W2: approved by eve, neither its registrar nor its assignee: confirmed, by eve, naming the package.
  expect(await pull(kolab, bob)).toBe('W2');
  await kolab.submitWork(bob, W('W2'), { evidence: [{ kind: 'pull_request', url: `${ORDERS}/pull/2` }] });
  expect(await kolab.reviewWork(eve, W('W2'), { verdict: 'approve' })).toMatchObject({ state: 'done', confirmed_repositories: [ORDERS] });
  expect(await confirmed()).toMatchObject({ confirmed: true, confirmed_by: 'eve', confirmed_at: expect.any(String), confirmed_by_work: W('W2') });
  // Every item of evidence in it now reads as confirmed, W1's too.
  expect((await kolab.readWork(bob, W('W1'))).evidence.map((e) => e.confirmed)).toStrictEqual([true, true]);
  // A later approval leaves the first confirmation as it was.
  expect(await pull(kolab, eve)).toBe('W3');
  await kolab.submitWork(eve, W('W3'), { evidence: [COMMIT('c')] });
  expect(await kolab.reviewWork(bob, W('W3'), { verdict: 'approve' })).toMatchObject({ confirmed_repositories: [] });
  expect(await confirmed()).toMatchObject({ confirmed_by: 'eve', confirmed_by_work: W('W2') });
}, 60_000);

test('a package Done unreviewed confirms nothing, and an approval by the registrar who is also a reviewer doesn\'t either (D98 ruling 1)', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const product = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'engineer');
  await kolab.createNode(product, 'spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.createNode(bob, 'binding', 'Orders on Postgres', 'orders-pg');
  const spec = (await kolab.latestCommitted('orders'))!.id;
  const bv = await kolab.draft(bob, 'orders-pg', { elements: els({ b1: 'A cancel endpoint.' }), links: [{ kind: 'dependency', sourceElement: 'b1', target: spec, targetElement: 'R1' }] });
  expect((await kolab.submit(bob, bv)).ok).toBe(true);
  await kolab.createNode(bob, 'plan', 'Plan', 'orders-plan');
  const pv = await kolab.draft(bob, 'orders-plan', { elements: [{ id: 'W1', text: 'Build it.' }], links: [{ kind: 'dependency', sourceElement: 'W1', target: bv, targetElement: 'b1' }] });
  expect((await kolab.submit(bob, pv)).ok).toBe(true);
  // The registrar's grant is removed once it registers, so bob is alone on the technical layer.
  const r = await registeredRepository(kolab, { binding: 'orders-pg' });
  await pull(kolab, bob);
  expect(await kolab.submitWork(bob, W('W1'), { evidence: [COMMIT()] })).toMatchObject({ state: 'done', unreviewed: true });
  expect((await kolab.listRepositories(bob)).items).toStrictEqual([expect.objectContaining({ id: r.id, confirmed: false })]);
}, 60_000);

test('separation of duty is per actor, as for versions (D102): an agent of the registrar\'s own person confirms; the registrar itself never does', async () => {
  const { kolab, bob, mia } = await planned();
  await kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' });
  await kolab.addActor('mia-bot', { owner: 'mia', by: ADMIN_DOER });
  await kolab.grant(TEST_KOLAB, 'mia-bot', 'write', { layers: ['technical'], by: ADMIN_DOER });
  const bot = await kolab.openSession('mia-bot', 'engineer');
  await pull(kolab, bob);
  await kolab.submitWork(bob, W('W1'), { evidence: [COMMIT()] });
  expect(await kolab.reviewWork(bot, W('W1'), { verdict: 'approve' })).toMatchObject({ confirmed_repositories: [ORDERS] });
}, 60_000);

test('only Kolab\'s trusted role writes repositories; what identifies one never changes, it is confirmed and archived once, never removed, and stays in its kolab (ENF2, D49, 0032)', async () => {
  const { kolab, bob, eve, mia } = await planned();
  const r = await kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' });
  const asRole = async (role: string, sql: string, params: unknown[] = []) => kolab.db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (role === 'kj_agent') await tx.query(`select set_config('kj.session', $1, true)`, [(await import('@konjir/engine')).sessionKey(bob)]);
    return tx.query(sql, params);
  });
  expect(await rejection(asRole('kj_agent', `insert into repository(id, kolab_id, url, root_sha, registered_by) values ('x', 'test', 'https://github.com/a/b', $1, 'bob')`, [testRoot()]))).toMatch(/permission denied/);
  expect(await rejection(asRole('kj_agent', `update repository set root_sha = $1`, [testRoot('e')]))).toMatch(/permission denied/);
  expect((await asRole('kj_agent', `select id from repository`)).rows).toStrictEqual([{ id: r.id }]);
  for (const sql of [`update repository set root_sha = '${testRoot('e')}'`, `update repository set url = 'https://github.com/evil/orders'`,
    `update repository set binding_node_id = null`, `update repository set registered_by = 'bob'`]) {
    expect(await rejection(asRole('kj_system', sql))).toMatch(/a repository's URL, root commit, binding and registration never change/);
  }
  // Not even Kolab's own login removes one.
  expect(await rejection(kolab.db.query('delete from repository'))).toMatch(/a repository's URL, root commit, binding and registration never change/);
  expect(await rejection(kolab.db.query(`update repository set root_sha = '${testRoot('e')}'`))).toMatch(/never change/);
  // Confirmed by its registrar: refused by the database too.
  expect(await rejection(asRole('kj_system', `update repository set confirmed_by = 'mia', confirmed_at = now(), confirmed_plan_node_id = 'x', confirmed_element_id = 'W1'`))).toMatch(/repository_confirmed|violates/);
  await pull(kolab, bob);
  await kolab.submitWork(bob, W('W1'), { evidence: [COMMIT()] });
  await kolab.reviewWork(eve, W('W1'), { verdict: 'approve' });
  expect(await rejection(asRole('kj_system', `update repository set confirmed_by = 'bob'`))).toMatch(/confirmed and archived once/);
  await kolab.archiveRepository(mia, ORDERS);
  expect(await rejection(asRole('kj_system', `update repository set archived_by = 'bob'`))).toMatch(/confirmed and archived once/);
  // A redaction keeps an item's repository; nothing moves it.
  expect(await rejection(asRole('kj_system', `update evidence set repository_id = null`))).toMatch(/evidence is never edited or removed/);
  // Another kolab sees none of it, and can't name it.
  await kolab.createKolab('other', { owner: 'test-org' });
  await kolab.addActor('nia', { by: ADMIN_DOER });
  await kolab.grant('other', 'nia', 'maintain', { by: ADMIN_DOER });
  const elsewhere = await kolab.openSession('nia', 'engineer', { kolab: 'other' });
  expect((await kolab.listRepositories(elsewhere, { archived: true })).items).toStrictEqual([]);
  expect(await rejection(kolab.archiveRepository(elsewhere, r.id))).toMatch(/isn't a repository registered in kolab other/);
  // The same URL may be registered there: nobody squats a URL for another kolab.
  expect((await kolab.registerRepository(elsewhere, { url: ORDERS, root_sha: testRoot() })).url).toBe(ORDERS);
  // Evidence never names another kolab's repository (composite key).
  expect(await rejection(asRole('kj_system', `insert into evidence(id, plan_node_id, element_id, event_id, kind, ref, recorded_by, repository_id)
      select 'e9', plan_node_id, element_id, event_id, 'commit', '${sha('9')}', 'bob', (select id from repository where kolab_id = 'other') from evidence limit 1`)))
    .toMatch(/evidence_repository_kolab_fkey|violates foreign key/);
}, 60_000);

test('repository calls are tool calls, which renew the caller\'s lease; read quietly, they renew none (PLN15, D100)', async () => {
  const { kolab, bob } = await planned();
  await registeredRepository(kolab, { binding: 'orders-pg' });
  const id = await pull(kolab, bob);
  const left = async () => Number((await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = $1`, [id])).rows[0].s);
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '100 seconds' where element_id = $1`, [id]);
  await kolab.quietly(() => kolab.listRepositories(bob));
  expect(await left()).toBeLessThan(101);
  await kolab.listRepositories(bob);
  expect(await left()).toBeGreaterThan(1700);
}, 60_000);

test('approvals at once of packages citing the same repositories, in either order, confirm each once and never deadlock (D98 ruling 1)', async () => {
  const store = await testStore();
  const { kolab, bob, eve, mia } = await planned(store);
  // No implementation: each package names its repositories itself.
  await kolab.registerRepository(mia, { url: 'https://github.com/acme/a', root_sha: testRoot('a') });
  await kolab.registerRepository(mia, { url: 'https://github.com/acme/b', root_sha: testRoot('b') });
  await people(kolab, 'frank', { layers: ['technical'] });
  const frank = await kolab.openSession('frank', 'engineer');
  expect(await pull(kolab, bob)).toBe('W1');
  await kolab.submitWork(bob, W('W1'), { evidence: [COMMIT('1', { repo: 'https://github.com/acme/a' }), COMMIT('2', { repo: 'https://github.com/acme/b' })] });
  expect(await pull(kolab, mia)).toBe('W2');
  await kolab.submitWork(mia, W('W2'), { evidence: [COMMIT('3', { repo: 'https://github.com/acme/b' }), COMMIT('4', { repo: 'https://github.com/acme/a' })] });
  // eve may confirm both; frank too. Mia registered them, so her package's approval by eve still confirms.
  const [one, two] = await Promise.all([
    kolab.reviewWork(eve, W('W1'), { verdict: 'approve' }),
    kolab.reviewWork(frank, W('W2'), { verdict: 'approve' }),
  ]);
  expect([...one.confirmed_repositories, ...two.confirmed_repositories].sort()).toStrictEqual(['https://github.com/acme/a', 'https://github.com/acme/b']);
  const repos = (await kolab.listRepositories(bob)).items;
  expect(repos.map((x) => x.confirmed)).toStrictEqual([true, true]);
  for (const x of repos) expect(['eve', 'frank']).toContain(x.confirmed_by);
}, 120_000);

test('two registrations of one URL at once: one stands, the other is refused as already registered (D98)', async () => {
  const store = await testStore();
  const { kolab, mia } = await planned(store);
  await people(kolab, 'nia', { level: 'maintain' });
  const nia = await kolab.openSession('nia', 'engineer');
  const results = await Promise.allSettled([
    kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot() }),
    kolab.registerRepository(nia, { url: 'https://github.com/Acme/Orders', root_sha: testRoot('e') }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/is already registered in kolab test/);
  expect((await kolab.listRepositories(mia)).items).toHaveLength(1);
}, 60_000);

(POSTGRES ? test : test.skip)('on Postgres: an archive waits for evidence that names the repository, and evidence after it is refused (D98)', async () => {
  const store = await testStore();
  const { kolab, bob, mia } = await planned(store);
  await kolab.registerRepository(mia, { url: ORDERS, root_sha: testRoot(), binding: 'orders-pg' });
  await pull(kolab, bob);
  const pg = (await import('pg')).default;
  const other = new pg.Client({ connectionString: store.databaseUrl });
  await other.connect();
  try {
    // Another transaction holds the repository, as evidence being recorded does: the archive waits.
    await other.query('begin');
    await other.query(`select 1 from repository where url = $1 for share`, [ORDERS]);
    let done = false;
    const archived = kolab.archiveRepository(mia, ORDERS).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await other.query('commit');
    expect(await archived).toMatchObject({ archived_at: expect.any(String) });
    expect(await rejection(kolab.addEvidence(bob, W('W1'), [COMMIT()]))).toMatch(/names no repository|archived/);
  } finally {
    await other.end();
  }
}, 60_000);
