// Links and forks across kolabs (W2.16; LNK8, KON9, DAT10, DAT11, D49): a link into another kolab
// needs Read there when it is made, and rests on its holder's Read from then on. When that goes,
// the dependent element is marked access_lost in the same transaction, and nothing of the other
// kolab's later commits reaches it; when it comes back, or someone who reads it takes the link
// over, the mark settles and the link is checked against the other kolab's latest version. A fork
// is a variant of another kolab's spec, rebased onto its parent's commits while its holder reads
// the parent's kolab. Neither kolab learns anything private of the other.
import { expect, test } from '@jest/globals';
import { markDetails, sessionKey, type Kolab } from '@konjir/engine';
import { commitReviewed, els, openKolab, rejection, textOf } from '@konjir/engine/testing';

/** alice owns `orders`, bob owns `billing`, each with a spec; alice reads billing. */
async function twoKolabs() {
  const kolab = await openKolab();
  await kolab.addActor('alice');
  await kolab.addActor('bob');
  await kolab.createKolab('orders', { owner: 'alice' });
  await kolab.createKolab('billing', { owner: 'bob' });
  const alice = await kolab.openSession('alice', 'product');
  const bob = await kolab.openSession('bob', 'product');
  const checkout = await kolab.createNode(bob, 'functional_spec', 'Checkout', 'checkout');
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent monthly.', R2: 'Invoices are in euros.' }) });
  await kolab.grant('billing', 'alice', 'read');
  return { kolab, alice, bob, checkout };
}

/** Open marks of kolab `k`, as [reason, dirty address]. */
const marks = async (kolab: Kolab, k: string) => (await kolab.describeMarks({ kolab: k })).map((m) => [m.reason, m.dirty]);

/** Runs `sql` as kj_agent in `session`, so row-level security applies. */
const asAgent = <T extends Record<string, unknown>>(kolab: Kolab, session: string, sql: string, params: unknown[] = []) =>
  kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(session)]);
    return (await tx.query<T>(sql, params)).rows;
  });

/** Links `from`'s element to an address in another kolab, as the server's konjir_link does. */
async function linkAcross(kolab: Kolab, session: string, source: string, sourceElement: string, target: string) {
  const t = await kolab.versionIn(session, target, { what: 'linking', across: true });
  const [, element] = target.split('#');
  return kolab.link(session, { kind: 'dependency', source, sourceElement, target: t.id, targetElement: element });
}

test('a link into another kolab needs Read there, follows its commits, and keeps each kolab\'s private rows private', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced with the monthly invoice.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.createNode(alice, 'functional_spec', 'FAQ', 'faq');
  const f1 = await kolab.commit(alice, 'faq', { elements: els({ F1: 'Your order shows on next month\'s invoice.' }) });
  await kolab.link(alice, { kind: 'dependency', source: f1, sourceElement: 'F1', target: o1, targetElement: 'O1' });
  expect((await kolab.db.query(`select kolab_id, target_kolab_id, held_by from edge where id = $1`, [edge])).rows)
    .toStrictEqual([{ kolab_id: 'orders', target_kolab_id: 'billing', held_by: 'alice' }]);
  expect(await kolab.lineage(o1, 'upstream')).toMatchObject([{ source: 'kj:orders-spec@1#O1', target: 'kj:billing/checkout@1#R1' }]);

  // Only committed work can be linked: bob's draft is no version at all to alice.
  await kolab.draft(bob, checkout, { elements: els({ R1: 'Invoices are sent daily.', R2: 'Invoices are in euros.' }) });
  expect(await rejection(kolab.versionIn(alice, 'kj:billing/checkout@2#R1', { what: 'linking', across: true }))).toBe('Error: billing/checkout has no version 2');

  // bob changes R1: alice's O1 is marked, and the mark spreads in her kolab, to F1.
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  expect(await marks(kolab, 'orders')).toStrictEqual([['changed', 'kj:orders-spec@1#O1'], ['upstream_dirty', 'kj:faq@1#F1']]);
  expect((await kolab.describeMarks({ kolab: 'orders' }))[0].because).toBe('kj:billing/checkout#R1 changed in version 3');

  // billing learns nothing of orders: no marks, no links downstream, no rows under row-level security.
  expect(await marks(kolab, 'billing')).toStrictEqual([]);
  expect(await kolab.lineage((await kolab.latestCommitted(checkout))!.id, 'downstream')).toStrictEqual([]);
  for (const t of ['edge', 'invalidation', 'invalidation_cause', 'node', 'version']) {
    expect([t, await asAgent(kolab, bob, `select 1 from ${t} where kolab_id = 'orders'`)]).toStrictEqual([t, []]);
  }

  // alice reads billing, so she can check it and clear it.
  const changed = (await kolab.openMarks()).find((m) => m.reason === 'changed')!;
  await kolab.clear(alice, changed.id);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  expect((await kolab.db.query(`select v.seq from edge e join version v on v.id = e.target_version_id where e.id = $1`, [edge])).rows).toStrictEqual([{ seq: 3 }]);
});

test('revoking Read marks the link access_lost in the same change; its target\'s commits stop reaching it until Read comes back', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders are priced in euros.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.createNode(alice, 'functional_spec', 'FAQ', 'faq');
  const f1 = await kolab.commit(alice, 'faq', { elements: els({ F1: 'Invoices come monthly.' }) });
  await kolab.link(alice, { kind: 'dependency', source: f1, sourceElement: 'F1', target: o1, targetElement: 'O1' });

  await kolab.revoke('billing', 'alice');
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1'], ['upstream_dirty', 'kj:faq@1#F1']]);
  expect((await kolab.describeMarks({ kolab: 'orders' }))[0].because)
    .toBe('kj:billing/checkout#R1 is in another kolab: alice, whose access it rests on, can no longer read kolab billing');
  // Revoking again, or any other change of access, marks it once.
  await kolab.revoke('billing', 'alice');
  expect(await marks(kolab, 'orders')).toHaveLength(2);

  // bob's commits no longer reach the link: no mark, no re-pin.
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in pounds.' }) });
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1'], ['upstream_dirty', 'kj:faq@1#F1']]);
  const pinned = async () => (await kolab.db.query<{ seq: number }>(
    `select v.seq from edge e join version v on v.id = e.target_version_id where e.id = $1`, [edge])).rows[0]?.seq;
  expect(await pinned()).toBe(1);
  // alice can't make a new link into billing now, nor clear what she can't check.
  expect(await rejection(linkAcross(kolab, alice, o1, 'O2', 'kj:billing/checkout#R2'))).toBe('Error: no node checkout in kolab billing');
  const lost = (await kolab.openMarks()).find((m) => m.reason === 'access_lost')!;
  expect(await rejection(kolab.clear(alice, lost.id))).toMatch(/AccessError: alice can't read kolab billing either/);

  // Read comes back: the mark settles, with what it caused, and the link is checked against
  // billing's latest version, where R1 has changed since.
  await kolab.grant('billing', 'alice', 'read');
  expect(await marks(kolab, 'orders')).toStrictEqual([['changed', 'kj:orders-spec@1#O1'], ['upstream_dirty', 'kj:faq@1#F1']]);
  expect((await kolab.db.query(`select state, cleared_by from invalidation where id = $1`, [lost.id])).rows)
    .toStrictEqual([{ state: 'cleared', cleared_by: 'access restored: alice holds it again' }]);
});

test('someone who reads the other kolab takes a link over by clearing its mark; a link that goes settles its mark', async () => {
  const { kolab, alice, checkout, bob } = await twoKolabs();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write', { layers: ['functional'] });
  const carol = await kolab.openSession('carol', 'product', { kolab: 'orders' });
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders ship fast.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.revoke('billing', 'alice');
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent monthly, on the 1st.', R2: 'Invoices are in euros.' }) });
  const lost = (await kolab.openMarks()).find((m) => m.reason === 'access_lost')!;

  // carol can't read billing either; once she can, she holds the link, and it is checked.
  expect(await rejection(kolab.clear(carol, lost.id))).toMatch(/AccessError: carol can't read kolab billing either/);
  await kolab.grant('billing', 'carol', 'read');
  await kolab.clear(carol, lost.id);
  expect((await kolab.db.query(`select held_by from edge where id = $1`, [edge])).rows).toStrictEqual([{ held_by: 'carol' }]);
  expect(await marks(kolab, 'orders')).toStrictEqual([['changed', 'kj:orders-spec@1#O1']]);
  // alice can't clear the change (she can't check it); carol can.
  const changed = (await kolab.openMarks()).find((m) => m.reason === 'changed')!;
  expect(await rejection(kolab.clear(alice, changed.id))).toMatch(/AccessError: alice can't read kolab billing, so can't check this link into it/);
  await kolab.clear(carol, changed.id);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);

  // carol loses Read too; then alice drops O1, and the link with it: its mark settles.
  await kolab.revoke('billing', 'carol');
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1']]);
  await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O2: 'Orders ship fast.' }) });
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
});

test('a fork of another kolab\'s spec rebases onto its commits while its holder reads that kolab, and catches up when Read comes back (KON9)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.createNode(alice, 'functional_spec', 'EU checkout', 'checkout-eu');
  const parent = await kolab.versionIn(alice, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  const v1 = await kolab.commit(alice, 'checkout-eu', { parent: parent.id, deltas: [{ kind: 'override', element: 'R2', text: 'Invoices are in euros and pounds.' }] });
  expect(await kolab.version(v1)).toMatchObject({ kolab_id: 'orders', parent_version_id: parent.id, parent_held_by: 'alice' });

  // bob's commit rebases the fork in alice's kolab, carrying her override.
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  expect(await textOf(kolab, 'checkout-eu')).toStrictEqual({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros and pounds.' });
  expect(await marks(kolab, 'billing')).toStrictEqual([]);

  // Read goes: the fork is marked, and bob's next commit doesn't reach it.
  await kolab.revoke('billing', 'alice');
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:checkout-eu@2']]);
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent daily.', R2: 'Invoices are in euros.' }) });
  expect(await textOf(kolab, 'checkout-eu')).toStrictEqual({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros and pounds.' });

  // Someone in orders who can't read billing may still draft the fork on the parent it has: the
  // holder carries. A new parent they can't read is refused, as a version that isn't there.
  await kolab.addActor('dave');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  const v3 = await commitReviewed(kolab, dave, alice, 'checkout-eu', { deltas: [{ kind: 'add', element: 'E1', text: 'VAT is shown.' }] });
  expect(await kolab.version(v3)).toMatchObject({ actor_id: 'dave', parent_held_by: 'alice' });
  const latest = (await kolab.latestCommitted(checkout))!.id;
  expect(await rejection(kolab.draft(dave, 'checkout-eu', { parent: latest, deltas: [] }))).toBe(`Error: no version ${latest}`);
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:checkout-eu@3']]);

  // Read comes back: the mark settles, and a rebase job rebases the fork onto billing's latest.
  await kolab.grant('billing', 'alice', 'read');
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  expect(await textOf(kolab, 'checkout-eu')).toStrictEqual({ R1: 'Invoices are sent daily.', R2: 'Invoices are in euros and pounds.', E1: 'VAT is shown.' });
  expect((await kolab.latestCommitted('checkout-eu'))!.parent_version_id).toBe(latest);
  expect(await kolab.outboxJobs()).toStrictEqual([]);
});

test('clearing a link\'s change as someone who reads the other kolab also settles the access_lost mark its old holder left (found by the property test)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write', { layers: ['functional'] });
  const carol = await kolab.openSession('carol', 'product', { kolab: 'orders' });
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  await kolab.revoke('billing', 'alice');
  expect((await marks(kolab, 'orders')).map(([r]) => r).sort()).toStrictEqual(['access_lost', 'changed']);
  await kolab.grant('billing', 'carol', 'read');
  await kolab.clear(carol, (await kolab.openMarks()).find((m) => m.reason === 'changed')!.id);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
});

test('a holder who leaves the dependent\'s kolab is no channel into it: the fork and the link are marked access_lost at once, and the other kolab\'s commits stop (review repro)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.addActor('dave');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'dave', 'read');
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  // dave forks billing/checkout@1 into orders, and links an orders spec to it.
  await kolab.createNode(dave, 'functional_spec', 'EU', 'eu');
  const parent = await kolab.versionIn(dave, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  await commitReviewed(kolab, dave, alice, 'eu', { parent: parent.id, deltas: [{ kind: 'override', element: 'R2', text: 'Invoices are in euros and pounds.' }] });
  await kolab.createNode(dave, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, dave, alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, dave, o1, 'O1', 'kj:billing/checkout#R1');

  // dave leaves orders, keeping his Read on billing.
  await kolab.revoke('orders', 'dave');
  const lost = (await kolab.describeMarks({ kolab: 'orders' })).map((m) => [m.reason, m.dirty, m.because]);
  expect(lost).toStrictEqual([
    ['access_lost', 'kj:orders-spec@1#O1', 'kj:billing/checkout#R1 is in another kolab: dave, whose access it rests on, can no longer write the functional layer of kolab orders'],
    ['access_lost', 'kj:eu@1', 'parent billing/checkout is in another kolab: dave, whose access it rests on, can no longer write the functional layer of kolab orders'],
  ]);
  // bob's secret doesn't reach orders, by the fork or by the link.
  await kolab.commit(bob, checkout, { elements: els({ R1: 'SECRET weekly.', R2: 'Invoices are in euros.' }) });
  expect(await textOf(kolab, 'eu')).toStrictEqual({ R1: 'Invoices are sent monthly.', R2: 'Invoices are in euros and pounds.' });
  expect((await kolab.db.query(`select v.seq from edge e join version v on v.id = e.target_version_id where e.source_version_id = $1`, [o1])).rows).toStrictEqual([{ seq: 1 }]);
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1'], ['access_lost', 'kj:eu@1']]);
});

test('an access_lost mark names what triggered it only to a session that reads it, in the same words on list_stale, the inbox and the web page', async () => {
  const { kolab, alice } = await twoKolabs();
  await kolab.addActor('dave');
  await kolab.addActor('erin');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  await kolab.grant('orders', 'erin', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'dave', 'read');
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  const erin = await kolab.openSession('erin', 'product', { kolab: 'orders' });
  // dave forks billing/checkout into orders, and links an orders spec to it; then leaves orders.
  await kolab.createNode(dave, 'functional_spec', 'EU', 'eu');
  const parent = await kolab.versionIn(dave, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  await commitReviewed(kolab, dave, alice, 'eu', { parent: parent.id, deltas: [{ kind: 'override', element: 'R2', text: 'Invoices are in euros and pounds.' }] });
  await kolab.createNode(dave, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, dave, alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, dave, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.revoke('orders', 'dave');
  const why = 'dave, whose access it rests on, can no longer write the functional layer of kolab orders';

  // alice reads billing: both surfaces name the link's target and the fork's parent.
  // erin doesn't: both say only that it is a version in another kolab.
  const cases: [string, string[]][] = [
    [alice, [`kj:billing/checkout#R1 is in another kolab: ${why}`, `parent billing/checkout is in another kolab: ${why}`]],
    [erin, [`it links to a version in another kolab: ${why}`, `its parent is a version in another kolab: ${why}`]],
  ];
  for (const [s, words] of cases) {
    expect((await kolab.marksFor(s)).map((m) => m.because)).toStrictEqual(words);
    expect((await markDetails(kolab, s)).map((m) => m.because)).toStrictEqual(words);
  }
  expect(JSON.stringify([await kolab.marksFor(erin), await markDetails(kolab, erin)])).not.toMatch(/billing|checkout/);
});

test('removing a link into another kolab is recorded in the draft, and settles its access_lost mark when it commits', async () => {
  const { kolab, alice, checkout } = await twoKolabs();
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.revoke('billing', 'alice');
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1']]);
  // alice can't read billing any more, yet drops the link she can no longer keep.
  const d = await kolab.draft(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }), unlink: [{ sourceElement: 'O1', target: 'kj:billing/checkout#R1' }] });
  expect((await kolab.db.query(`select kolab_id, target_kolab_id, target_node_id from link_removal where version_id = $1`, [d])).rows)
    .toStrictEqual([{ kolab_id: 'orders', target_kolab_id: 'billing', target_node_id: checkout }]);
  expect((await kolab.review(d)).ok).toBe(true);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  expect(await kolab.lineage(d, 'upstream')).toStrictEqual([]);
});

test('another kolab\'s failing dependent work never stops this kolab\'s own cascade, and the committer hears nothing of it', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  // A link inside billing, and one from orders into it.
  const faq = await kolab.createNode(bob, 'functional_spec', 'FAQ', 'faq');
  const f1 = await kolab.commit(bob, faq, { elements: els({ F1: 'See the invoice schedule.' }) });
  await kolab.link(bob, { kind: 'dependency', source: f1, sourceElement: 'F1', target: (await kolab.latestCommitted(checkout))!.id, targetElement: 'R1' });
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  // orders' work fails, every time.
  const k = kolab as unknown as { checkLinksAcross: (node: string) => Promise<void> };
  const real = k.checkLinksAcross.bind(kolab);
  k.checkLinksAcross = async () => { throw new Error('orders is broken'); };
  const v = await kolab.draft(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  const r = await kolab.review(v);
  expect(r).toMatchObject({ ok: true });
  expect(Object.keys(r).sort()).toStrictEqual(['note', 'ok', 'unreviewed', 'version']);
  expect(r.note).not.toMatch(/orders|another|retr|cascade/i);
  // billing's own cascade finished: its link is marked, and its job is gone.
  expect(await marks(kolab, 'billing')).toStrictEqual([['changed', 'kj:faq@1#F1']]);
  expect((await kolab.outboxJobs()).map((j) => [j.kind, j.subject, j.attempts])).toStrictEqual([['rebase', 'kj:orders/orders-spec@1', 1]]);
  // orders' job retries on its own, and once it works, its link is marked.
  k.checkLinksAcross = real;
  await kolab.db.query(`update outbox set run_after = now()`);
  expect(await kolab.drainOutbox()).toBe(1);
  expect(await marks(kolab, 'orders')).toStrictEqual([['changed', 'kj:orders-spec@1#O1']]);
});

test('a change of access looks only at the links and forks its actors hold', async () => {
  const { kolab, alice } = await twoKolabs();
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  // A held_by changed behind Kolab's back (a holder with no access), then a grant to someone else:
  // the link isn't theirs, so it isn't looked at.
  await kolab.addActor('erin');
  await kolab.db.query(`update edge set held_by = 'erin' where source_version_id = $1`, [o1]);
  await kolab.addActor('fred');
  await kolab.grant('orders', 'fred', 'read');
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  // A change to erin's own access is.
  await kolab.grant('orders', 'erin', 'read');
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1']]);
});

test('row-level security holds an agent\'s override base to what it reads, as its links and parents', async () => {
  const { kolab, bob } = await twoKolabs();
  await kolab.createNode(bob, 'functional_spec', 'Other', 'other');
  await kolab.addActor('carl');
  await kolab.createKolab('shop', { owner: 'carl' });
  const carl = await kolab.openSession('carl', 'product', { kolab: 'shop' });
  await kolab.createNode(carl, 'functional_spec', 'Shop', 'shop-spec');
  const secret = await kolab.commit(carl, 'shop-spec', { elements: els({ S1: 'Shop secret.' }) });
  const draft = await kolab.draft(bob, 'other', { elements: els({ X1: 'Other.' }) });
  const insert = (base: string) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(bob)]);
    await tx.query(`insert into delta(id, version_id, element_id, kind, text, base_version_id, base_fingerprint) values ($1, $2, 'S1', 'override', 'x', $3, 'f')`, [`d-${base}`, draft, base]);
  });
  expect(await rejection(insert(secret))).toMatch(/row-level security/);
  await insert((await kolab.latestCommitted('checkout'))!.id);   // his own kolab's
});

test('a fork\'s pending rebase never names the upstream version or its error (D53)', async () => {
  const kolab = await openKolab({ queued: true });
  await kolab.addActor('alice');
  await kolab.addActor('bob');
  await kolab.addActor('dave');
  await kolab.createKolab('orders', { owner: 'alice' });
  await kolab.createKolab('billing', { owner: 'bob' });
  await kolab.grant('billing', 'alice', 'read');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  const alice = await kolab.openSession('alice', 'product', { kolab: 'orders' });
  const bob = await kolab.openSession('bob', 'product', { kolab: 'billing' });
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  await kolab.createNode(bob, 'functional_spec', 'Checkout', 'checkout');
  await kolab.commit(bob, 'checkout', { elements: els({ R1: 'Invoices are sent monthly.' }) });
  await kolab.createNode(alice, 'functional_spec', 'EU', 'eu');
  const parent = await kolab.versionIn(alice, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  const v1 = await kolab.draft(alice, 'eu', { parent: parent.id, deltas: [{ kind: 'add', element: 'E1', text: 'VAT is shown.' }] });
  await kolab.review(v1);
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  await kolab.commit(bob, 'checkout', { elements: els({ R1: 'Invoices are sent weekly.' }) });
  for (const reader of [alice, dave]) {
    const seen = (await kolab.readNode(reader, 'eu')).rebase;
    expect(seen).toMatchObject({ state: 'pending' });
    expect(seen).not.toHaveProperty('after');
    expect(JSON.stringify(seen)).not.toContain('billing');
  }
});

test('a change of access leaves a dependent in an archived kolab as it is, and the change still goes through (D52)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.archive({ kolab: 'orders' });
  // Revoking alice's Read would mark the link in orders; orders is archived, so it is left alone.
  await kolab.revoke('billing', 'alice');
  expect(await kolab.openMarks()).toStrictEqual([]);
  // billing's own commits go on, and the job for orders waits for it.
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  expect(await kolab.openMarks()).toStrictEqual([]);
});

test('a fork\'s rebase queued when its holder holds it again keeps its error to its parent\'s kolab, and so does its rebase_failed mark (verification review)', async () => {
  const kolab = await openKolab({ queued: true });
  for (const a of ['alice', 'bob', 'dave']) await kolab.addActor(a);
  await kolab.createKolab('orders', { owner: 'alice' });
  await kolab.createKolab('billing', { owner: 'bob' });
  await kolab.grant('billing', 'alice', 'read');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  const alice = await kolab.openSession('alice', 'product', { kolab: 'orders' });
  const bob = await kolab.openSession('bob', 'product', { kolab: 'billing' });
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  await kolab.createNode(bob, 'functional_spec', 'Checkout', 'checkout');
  await kolab.commit(bob, 'checkout', { elements: els({ R1: 'Invoices are sent monthly.' }) });
  await kolab.createNode(alice, 'functional_spec', 'EU', 'eu');
  const parent = await kolab.versionIn(alice, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  const v1 = await kolab.draft(alice, 'eu', { parent: parent.id, deltas: [{ kind: 'add', element: 'E1', text: 'VAT is shown.' }] });
  await kolab.review(v1);
  await kolab.recordReview(dave, v1, { verdict: 'approve' });
  await kolab.revoke('billing', 'alice');
  await kolab.commit(bob, 'checkout', { elements: els({ R1: 'Invoices are sent weekly.' }) });
  await kolab.db.query(`delete from outbox`);
  await kolab.grant('billing', 'alice', 'read');   // queues the fork's rebase, payload { node }
  const k = kolab as unknown as { rebaseOrMark: (...a: unknown[]) => Promise<void> };
  k.rebaseOrMark = async () => { throw new Error('upstream-private-detail-XYZ'); };
  await kolab.drainOutbox();
  const seen = (await kolab.readNode(dave, 'eu')).rebase;
  expect(seen).toMatchObject({ state: 'pending', attempts: 1 });
  expect(JSON.stringify(seen)).not.toMatch(/XYZ|billing/);
  // Dead after its attempts: its rebase_failed mark and question say nothing of it either.
  for (let i = 0; i < 12; i++) {
    await kolab.db.query(`update outbox set run_after = now()`);
    await kolab.drainOutbox();
  }
  expect((await kolab.outboxJobs()).map((j) => j.state)).toStrictEqual(['dead']);
  const said = JSON.stringify({ marks: await kolab.describeMarks({ kolab: 'orders' }), queries: await kolab.listQueries({ kolab: 'orders' }) });
  expect(said).toMatch(/rebase_failed/);
  expect(said).not.toMatch(/XYZ/);
});

test('archiving a holder, or bringing back a dependent kolab, marks links and forks in the same transaction (verification review)', async () => {
  const { kolab, alice, checkout } = await twoKolabs();
  await kolab.addActor('dave');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'dave', 'read');
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  await kolab.createNode(dave, 'functional_spec', 'O', 'o');
  const o1 = await commitReviewed(kolab, dave, alice, 'o', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, dave, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.archive({ actor: 'dave' });
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:o@1#O1']]);
  await kolab.unarchive({ actor: 'dave' });
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  const dave2 = await kolab.openSession('dave', 'product', { kolab: 'orders' });

  // alice's link from orders, revoked while orders was archived: marked as orders comes back.
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const a1 = await commitReviewed(kolab, alice, dave2, 'orders-spec', { elements: els({ A1: 'Orders ship fast.' }) });
  await linkAcross(kolab, alice, a1, 'A1', 'kj:billing/checkout#R2');
  await kolab.archive({ kolab: 'orders' });
  await kolab.revoke('billing', 'alice');
  await kolab.unarchive({ kolab: 'orders' });
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#A1']]);
  expect(checkout).toBeTruthy();
});

test('a reader taking over a link must qualify, and a link whose holder lost access is marked then (verification review)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  // Behind Kolab's back, alice's Read goes, with no mark; carol, who can't read billing, tries to hold it.
  await kolab.db.query(`delete from kolab_grant where kolab_id = 'billing' and user_id = 'alice'`);
  await kolab.addActor('carol');
  const k = kolab as unknown as { holdLink: (edge: string, actor: string) => Promise<boolean> };
  expect(await k.holdLink(edge, 'carol')).toBe(false);
  expect((await kolab.db.query(`select held_by from edge where id = $1`, [edge])).rows).toStrictEqual([{ held_by: 'alice' }]);
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1']]);
  expect([bob, checkout]).toHaveLength(2);
});
