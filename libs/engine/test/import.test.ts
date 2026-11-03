// Importing a kolab (W6.3; D15, D104, D109): one file gives a kolab's spec, its binding with its
// decisions and work packages, its rulings with their IDs and dates, and its repository, written as
// the person whose own session it is, each write the way its verb goes; checked whole before anything
// is written; idempotent and resumable; never from an agent's session. The fixture is invented.
import { expect, jest, test } from '@jest/globals';
import { IMPORT_FORMAT, type ImportReport, type Kolab } from '@konjir/engine';
import { openKolab, people, rejection, testRoot, TEST_KOLAB } from '@konjir/engine/testing';
import { JOB_KINDS } from '@konjir/types';

/** A small invented kolab: a shop's spec, its binding, three rulings and its repository. */
const fixture = () => ({
  format: IMPORT_FORMAT,
  kolab: TEST_KOLAB,
  spec: {
    name: 'shop', title: 'Shop — Functional Spec',
    elements: [
      { id: 'CHK', text: 'Checkout' },
      { id: 'CHK1', text: 'A shopper pays by card.', parent: 'CHK' },
      { id: 'CHK2', text: 'A receipt is emailed within a minute of paying.', parent: 'CHK' },
    ],
  },
  binding: {
    name: 'shop-binding', title: 'Shop — Technical Binding',
    elements: [
      { id: 'DEC1', text: 'Payments go through the card gateway.', serves: ['CHK1'] },
      { id: 'DEC2', text: 'Receipts are sent by a mail queue.', serves: ['CHK2'] },
      { id: 'W1.1', title: 'Card payments', text: 'Take card payments through the gateway.', work: { done_when: 'A test card payment succeeds end to end.', size: 'M' }, serves: ['CHK1'], relies_on: ['DEC1'] },
      { id: 'W1.2', title: 'Receipts', text: 'Email a receipt after payment.', work: { done_when: 'A receipt arrives within a minute.', depends_on: ['W1.1'], size: 'S' }, serves: ['CHK2'], relies_on: ['DEC2'] },
      { id: 'M1', text: 'Checkout ships.', work: { milestone: true, depends_on: ['W1.1', 'W1.2'] } },
    ],
  },
  rulings: [
    { id: 'D7', date: '2026-01-02', text: 'Cards only at launch; wallets later.', replaces: 'Any payment method', effect: 'change_intent', on: 'shop#CHK1' },
    { id: 'D8', date: '2026-01-05', text: 'The mail queue is the provider\'s, not ours.', on: 'shop-binding#DEC2' },
    { id: 'D9', date: '2026-02-01T09:30:00Z', text: 'Receipts are plain text.' },
  ],
  repository: { url: 'https://github.com/acme/shop', root_sha: testRoot('a') },
});
type Fixture = ReturnType<typeof fixture>;

/** A Kolab where lee, a person, holds Admin in the test kolab, signed in as product. */
async function lee() {
  const kolab = await openKolab();
  await people(kolab, 'lee', { level: 'admin' });
  const session = await kolab.openSession('lee', 'product');
  return { kolab, session };
}

const outcomes = (r: ImportReport) => Object.fromEntries(r.steps.map((s) => [s.what, s.outcome]));
const count = async (kolab: Kolab, table: string) => (await kolab.db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;

test('a full import writes the spec, the binding with its decisions, work packages and links, the rulings with their IDs and dates, and the repository, as the person (W6.3)', async () => {
  const { kolab, session } = await lee();
  const r = await kolab.importKolab(session, fixture());
  expect(outcomes(r)).toStrictEqual({
    'node kj:test/shop': 'created', 'version kj:test/shop': 'created',
    'node kj:test/shop-binding': 'created', 'repository https://github.com/acme/shop': 'created',
    'version kj:test/shop-binding': 'created', 'links kj:test/shop-binding (relies_on)': 'created',
    'ruling D7': 'created', 'ruling D8': 'created', 'ruling D9': 'created',
  });
  expect(r).toMatchObject({ kolab: 'test', by: 'lee', dry_run: false, complete: true, differs: [], waiting: [], failed: [] });
  // Nobody else may approve in this kolab, so each version committed on its checks alone (VER11), as lee's.
  expect(r.steps.find((s) => s.what === 'version kj:test/shop')!.detail).toMatch(/committed unreviewed/);

  // The spec, by its IDs: read_node and addresses.
  const spec = await kolab.readNode(session, 'shop');
  expect(spec.elements.map((e) => [e.element_id, e.parent_element_id])).toStrictEqual([['CHK', null], ['CHK1', 'CHK'], ['CHK2', 'CHK']]);
  expect(await kolab.resolve('kj:test/shop#CHK1', { session })).toMatchObject({ status: 'ok', content: 'A shopper pays by card.' });
  const specV = (await kolab.latestCommitted('shop'))!;
  expect(specV).toMatchObject({ actor_id: 'lee', active_role: 'product', state: 'committed' });

  // The binding: its decisions and work packages, binding the spec, written in the engineer's role.
  const binding = (await kolab.latestCommitted('shop-binding'))!;
  expect(binding).toMatchObject({ seq: 2, actor_id: 'lee', active_role: 'engineer' });
  expect((await kolab.db.query(`select kind, parent_node_id from node where id = 'shop-binding'`)).rows).toStrictEqual([{ kind: 'binding', parent_node_id: 'shop' }]);
  const els = await kolab.elements(binding.id);
  expect(els.map((e) => [e.element_id, e.work ?? null])).toStrictEqual([
    ['DEC1', null], ['DEC2', null],
    ['W1.1', { done_when: 'A test card payment succeeds end to end.', size: 'M' }],
    ['W1.2', { done_when: 'A receipt arrives within a minute.', depends_on: ['W1.1'], size: 'S' }],
    ['M1', { depends_on: ['W1.1', 'W1.2'], milestone: true }],
  ]);
  expect(els[2].text).toBe('Card payments\n\nTake card payments through the gateway.');
  // What each serves and relies on: dependency links, to the spec and to the binding's own decisions.
  const links = (await kolab.db.query<{ source_element_id: string; node: string; target_element_id: string }>(
    `select e.source_element_id, t.node_id as node, e.target_element_id from edge e join version t on t.id = e.target_version_id
      where e.source_version_id = $1 order by 1, 2, 3`, [binding.id])).rows.map((x) => `${x.source_element_id}→${x.node}#${x.target_element_id}`);
  expect(links).toStrictEqual([
    'DEC1→shop#CHK1', 'DEC2→shop#CHK2',
    'W1.1→shop#CHK1', 'W1.1→shop-binding#DEC1', 'W1.2→shop#CHK2', 'W1.2→shop-binding#DEC2',
  ]);

  // The open work packages are on the board, and the first is ready to pull.
  const board = await kolab.listWork(session, { binding: 'shop-binding' });
  expect(board.items.map((w) => [w.id, w.state, w.ready])).toStrictEqual([['M1', 'todo', false], ['W1.1', 'todo', false], ['W1.2', 'todo', false]]);

  // The rulings, by their IDs, dated when they were given; the one that changes the intent marks nothing,
  // since the spec's version was written after it.
  const rulings = await kolab.rulingsFor(session, {});
  expect(rulings.map((x) => [x.ref, x.on, x.effect, x.ruled_at, x.ruled_by])).toStrictEqual([
    ['D9', 'kj:shop@1', 'keep_intent', '2026-02-01T09:30:00.000Z', 'lee'],
    ['D8', 'kj:shop-binding@2#DEC2', 'keep_intent', '2026-01-05T00:00:00.000Z', 'lee'],
    ['D7', 'kj:shop@1#CHK1', 'change_intent', '2026-01-02T00:00:00.000Z', 'lee'],
  ]);
  expect(rulings[2]).toMatchObject({ replaces: 'Any payment method' });
  expect(Date.parse(rulings[2].recorded_at!)).toBeGreaterThan(Date.parse(rulings[2].ruled_at!));
  expect((await kolab.db.query(`select reason from invalidation where reason = 'ruled'`)).rows).toStrictEqual([]);
  expect(await kolab.precedentFor(session)).toMatch(/D7 on kj:shop@1#CHK1: "Cards only at launch; wallets later\." \(changes the intent; replaces "Any payment method"; ruled by lee on 2026-01-02\)/);

  // The repository, as the binding's implementation, registered by lee and audited.
  expect((await kolab.listRepositories(session)).items).toMatchObject([{ url: 'https://github.com/acme/shop', root_sha: testRoot('a'), binding: 'shop-binding', registered_by: 'lee' }]);
  expect((await kolab.auditLog({ kolab: 'test' })).map((a) => a.action)).toContain('repository.registered');
});

test('the ready work package is the board\'s, and a job taken after the import gets it with its playbook and the rulings as precedent (W6.3)', async () => {
  const { kolab, session } = await lee();
  // W1.1 is ready once nothing blocks it: the board above shows it To do; a job pulls it.
  await kolab.importKolab(session, fixture());
  const job = await kolab.takeJob(session, { machine: 'lee-laptop', kinds: [...JOB_KINDS] });
  if (!job.taken) throw new Error(job.why);
  expect(job).toMatchObject({ kind: 'build', item: 'kj:shop-binding#W1.1', agent: 'lee-engineer-1', trailer: 'Konjir-Work: kj:test/shop-binding#W1.1' });
  expect(job.instructions).toMatch(/Done when: A test card payment succeeds end to end\./);
  expect(job.instructions).toMatch(/It is done in the repository https:\/\/github\.com\/acme\/shop/);
  expect(job.instructions).toMatch(/Rulings, newest first \(3\): D9 on kj:shop@1: "Receipts are plain text\."/);
  expect(job.instructions).toMatch(/D7 on kj:shop@1#CHK1/);
  // The agent reads it with its context: the spec element it serves and the decision it relies on.
  const read = await kolab.readWork(job.token, 'kj:shop-binding#W1.1') as unknown as { elements: { address: string; rulings: { ref: string }[] }[] };
  expect(read.elements.map((e) => [e.address, e.rulings.map((x) => x.ref)])).toStrictEqual([['kj:shop@1#CHK1', ['D7']], ['kj:shop-binding@2#DEC1', []]]);
});

test('run again, an import changes nothing that is there and equal, and says so (W6.3)', async () => {
  const { kolab, session } = await lee();
  await kolab.importKolab(session, fixture());
  const before = await Promise.all(['version', 'edge', 'ruling', 'repository', 'node', 'work_event'].map((t) => count(kolab, t)));
  const again = await kolab.importKolab(session, fixture());
  expect(new Set(Object.values(outcomes(again)))).toStrictEqual(new Set(['unchanged']));
  expect(again).toMatchObject({ complete: true, created: [], differs: [] });
  expect(await Promise.all(['version', 'edge', 'ruling', 'repository', 'node', 'work_event'].map((t) => count(kolab, t)))).toStrictEqual(before);
});

test('what differs is reported and left alone; --update drafts the file\'s version of a node that differs; a ruling never changes (W6.3)', async () => {
  const { kolab, session } = await lee();
  await kolab.importKolab(session, fixture());
  const changed: Fixture = fixture();
  changed.spec.elements[1] = { id: 'CHK1', text: 'A shopper pays by card or wallet.', parent: 'CHK' };
  changed.spec.elements.push({ id: 'CHK3', text: 'A shopper may cancel before shipping.', parent: 'CHK' });
  changed.rulings[0] = { ...changed.rulings[0], text: 'Cards only.' };
  const r = await kolab.importKolab(session, changed);
  expect(outcomes(r)).toMatchObject({ 'version kj:test/shop': 'differs', 'ruling D7': 'differs', 'version kj:test/shop-binding': 'unchanged' });
  expect(r.steps.find((s) => s.what === 'version kj:test/shop')!.detail).toMatch(/shop@1 differs from the file: the file adds CHK3; the file changes CHK1/);
  expect(r.steps.find((s) => s.what === 'ruling D7')!.detail).toMatch(/with other its text; a ruling never changes/);
  expect(r.complete).toBe(false);
  expect((await kolab.latestCommitted('shop'))!.seq).toBe(1);

  const u = await kolab.importKolab(session, changed, { update: true });
  expect(outcomes(u)).toMatchObject({ 'version kj:test/shop': 'created', 'ruling D7': 'differs' });
  expect((await kolab.elements((await kolab.latestCommitted('shop'))!.id)).map((e) => e.element_id)).toStrictEqual(['CHK', 'CHK1', 'CHK2', 'CHK3']);
});

test('a dry run checks the file and says what it would write, writing nothing (W6.3)', async () => {
  const { kolab, session } = await lee();
  const tables = ['node', 'version', 'ruling', 'repository', 'rate_event'];
  const before = await Promise.all(tables.map((t) => count(kolab, t)));
  const dry = await kolab.importKolab(session, fixture(), { dryRun: true });
  expect(dry).toMatchObject({ dry_run: true, complete: false, created: [] });
  expect(new Set(Object.values(outcomes(dry)))).toStrictEqual(new Set(['would_create']));
  expect(dry.would).toHaveLength(9);
  expect(await Promise.all(tables.map((t) => count(kolab, t)))).toStrictEqual(before);
  // A file that fails its checks is refused by a dry run too.
  expect(await rejection(kolab.importKolab(session, { ...fixture(), format: 'something/2' }, { dryRun: true }))).toMatch(/format is "konjir-import\/1"/);
  // Once imported, a dry run finds everything there.
  await kolab.importKolab(session, fixture());
  expect(new Set(Object.values(outcomes(await kolab.importKolab(session, fixture(), { dryRun: true }))))).toStrictEqual(new Set(['unchanged']));
});

test('an import that fails part way leaves what it wrote, and the next run completes the rest, writing nothing twice (W6.3)', async () => {
  const { kolab, session } = await lee();
  // The binding's node fails to be made, so nothing that needs it can be written this run.
  const internals = kolab as unknown as { createNodeAs: (...a: unknown[]) => Promise<string> };
  const make = internals.createNodeAs.bind(kolab);
  const spy = jest.spyOn(internals, 'createNodeAs').mockImplementation(async (...a: unknown[]) => {
    if (a[1] === 'binding') throw new Error('the database went away');
    return make(...a);
  });
  const first = await kolab.importKolab(session, fixture());
  spy.mockRestore();
  expect(outcomes(first)).toStrictEqual({
    'node kj:test/shop': 'created', 'version kj:test/shop': 'created',
    'node kj:test/shop-binding': 'failed', 'repository https://github.com/acme/shop': 'waiting',
    'version kj:test/shop-binding': 'waiting', 'links kj:test/shop-binding (relies_on)': 'waiting',
    'ruling D7': 'created', 'ruling D8': 'waiting', 'ruling D9': 'created',
  });
  expect(first.steps.find((s) => s.what === 'node kj:test/shop-binding')!.detail).toMatch(/the database went away/);
  expect(first.complete).toBe(false);

  const second = await kolab.importKolab(session, fixture());
  expect(outcomes(second)).toStrictEqual({
    'node kj:test/shop': 'unchanged', 'version kj:test/shop': 'unchanged',
    'node kj:test/shop-binding': 'created', 'repository https://github.com/acme/shop': 'created',
    'version kj:test/shop-binding': 'created', 'links kj:test/shop-binding (relies_on)': 'created',
    'ruling D7': 'unchanged', 'ruling D8': 'created', 'ruling D9': 'unchanged',
  });
  expect(second.complete).toBe(true);
  expect(await count(kolab, 'ruling')).toBe(3);
  expect((await kolab.db.query(`select seq from version where node_id = 'shop' order by seq`)).rows).toStrictEqual([{ seq: 1 }]);
});

test('under the default policy, a spec another person may approve waits in review, the binding and its rulings wait on it, and a later run completes them (W6.3, VER11, AUT2)', async () => {
  const { kolab, session } = await lee();
  await people(kolab, 'dave', { layers: ['functional'] });
  const first = await kolab.importKolab(session, fixture());
  expect(outcomes(first)).toMatchObject({
    'version kj:test/shop': 'in_review', 'node kj:test/shop-binding': 'created', 'repository https://github.com/acme/shop': 'created',
    'version kj:test/shop-binding': 'waiting', 'links kj:test/shop-binding (relies_on)': 'waiting',
    'ruling D7': 'waiting', 'ruling D8': 'waiting', 'ruling D9': 'waiting',
  });
  expect(first.steps.find((s) => s.what === 'version kj:test/shop')).toMatchObject({ version: 1, reviewers: ['dave'] });
  // Run again while it waits: the same version is submitted again, never drafted twice.
  expect(outcomes(await kolab.importKolab(session, fixture()))).toMatchObject({ 'version kj:test/shop': 'in_review' });
  expect(await count(kolab, 'version')).toBe(1);

  const dave = await kolab.openSession('dave', 'product');
  expect(await kolab.recordReview(dave, (await kolab.db.query<{ id: string }>(`select id from version where node_id = 'shop'`)).rows[0].id, { verdict: 'approve' })).toMatchObject({ ok: true });
  const done = await kolab.importKolab(session, fixture());
  expect(done.complete).toBe(true);
  expect(outcomes(done)).toMatchObject({ 'version kj:test/shop': 'unchanged', 'version kj:test/shop-binding': 'created', 'ruling D8': 'created' });
});

test('an agent\'s session imports nothing, and neither does a file for another kolab, a person without the access it needs, or a file that fails its checks: nothing is written (W6.3)', async () => {
  const { kolab, session } = await lee();
  await people(kolab, 'lee-bot', { owner: 'lee' });
  const bot = await kolab.openSession('lee-bot', 'engineer');
  expect(await rejection(kolab.importKolab(bot, fixture()))).toMatch(/AccessError: lee-bot is an agent, and an agent imports nothing/);
  expect(await rejection(kolab.importKolab(session, { ...fixture(), kolab: 'other' }))).toMatch(/imports into kolab other, and this session works in kolab test/);
  await people(kolab, 'ann', { layers: ['functional'] });
  const ann = await kolab.openSession('ann', 'product');
  expect(await rejection(kolab.importKolab(ann, fixture()))).toMatch(/needs Write on the technical layer and Maintain or Admin, to register its repository/);

  const bad = fixture() as unknown as Record<string, any>;
  bad.spec.elements.push({ id: 'CHK1', text: 'Twice.' }, { id: 'X~1', text: 'Tilde.' });
  bad.binding.elements[0].serves = ['NOPE'];
  bad.binding.elements[3].relies_on = ['W1.1'];
  bad.binding.elements[4].work.depends_on = ['W1.1', 'W9'];
  bad.rulings.push({ id: 'D7', date: 'yesterday', text: '' }, { id: 'D10', date: '2999-01-01', text: 'Later.' });
  bad.extra = true;
  const refused = await rejection(kolab.importKolab(session, bad));
  expect(refused).toMatch(/the file has "extra", which an import file doesn't take/);
  expect(refused).toMatch(/spec has two elements CHK1/);
  expect(refused).toMatch(/spec\.elements\[4\] \(X~1\)\.id is the element's id/);
  expect(refused).toMatch(/binding element DEC1 serves NOPE, which isn't an element of the spec/);
  expect(refused).toMatch(/binding element W1.2 relies on W1.1, which is a work package/);
  expect(refused).toMatch(/rulings has two D7/);
  expect(refused).toMatch(/nothing was written/);
  // Past the shape, the engine's own checks: PLN2's, and a ruling dated in the future.
  const later = fixture() as unknown as Record<string, any>;
  later.binding.elements[4].work.depends_on = ['W1.1', 'W9'];
  later.rulings.push({ id: 'D10', date: '2999-01-01', text: 'Later.' });
  const deep = await rejection(kolab.importKolab(session, later));
  expect(deep).toMatch(/M1 depends on W9, which isn't a work package of this version/);
  expect(deep).toMatch(/ruling D10: ruled_at 2999-01-01 is in the future/);
  expect(await count(kolab, 'node')).toBe(0);
  expect(await count(kolab, 'ruling')).toBe(0);
});

test('a node already there of another kind, or a binding of another spec, refuses the import before it writes (W6.3)', async () => {
  const { kolab, session } = await lee();
  await kolab.createNode(session, 'spec', 'Another spec', 'other');
  expect(await rejection(kolab.importKolab(session, fixture()))).toMatch(/kolab test holds its spec already, other, and a kolab holds exactly one \(KON1\)/);
  expect(await count(kolab, 'version')).toBe(0);
});

test('konjir_rule takes a ref and the date a direct ruling was given; a ref is unique in its kolab (W6.3)', async () => {
  const { kolab, session } = await lee();
  await kolab.importKolab(session, { format: IMPORT_FORMAT, kolab: TEST_KOLAB, spec: fixture().spec });
  const id = await kolab.rule(session, { address: 'kj:shop#CHK2', text: 'A minute is wall-clock time.', effect: 'keep_intent', ref: 'D11', ruled_at: '2026-03-04' });
  expect((await kolab.rulingsFor(session, {})).find((r) => r.ruling === id)).toMatchObject({ ref: 'D11', ruled_at: '2026-03-04T00:00:00.000Z' });
  expect(await rejection(kolab.rule(session, { address: 'kj:shop#CHK2', text: 'Again.', effect: 'keep_intent', ref: 'D11' }))).toMatch(/kolab test already has a ruling named D11/);
  expect(await rejection(kolab.rule(session, { address: 'kj:shop#CHK2', text: 'Bad.', effect: 'keep_intent', ref: '11 D' }))).toMatch(/a ruling's ref is its name in its kolab/);
  expect(await rejection(kolab.rule(session, { address: 'kj:shop#CHK2', text: 'Bad.', effect: 'keep_intent', ruled_at: '2026-02-30' }))).toMatch(/ruled_at is the date a ruling was given/);
  // A ruling given now that changes the intent still marks the element (D51).
  await kolab.rule(session, { address: 'kj:shop#CHK2', text: 'Within two minutes.', effect: 'change_intent', ref: 'D12' });
  expect((await kolab.db.query(`select element_id from invalidation where reason = 'ruled'`)).rows).toStrictEqual([{ element_id: 'CHK2' }]);
  // The database holds a ref to its form too.
  expect(await rejection(kolab.db.query(`update ruling set ref = 'x y' where id = $1`, [id]))).toMatch(/never changes/);
});

test('policy: an agent may approve the binding under the defaults, so the binding waits for its review (W6.3, AUT2)', async () => {
  const { kolab, session } = await lee();
  await people(kolab, 'lee-engineer-1', { owner: 'lee', layers: ['technical'] });
  const r = await kolab.importKolab(session, fixture());
  expect(outcomes(r)).toMatchObject({ 'version kj:test/shop': 'created', 'version kj:test/shop-binding': 'in_review', 'links kj:test/shop-binding (relies_on)': 'waiting' });
  expect(r.steps.find((s) => s.what === 'version kj:test/shop-binding')).toMatchObject({ reviewers: ['lee-engineer-1'] });
});
