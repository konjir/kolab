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
  const checkout = await kolab.createNode(bob, 'spec', 'Checkout', 'checkout');
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
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced with the monthly invoice.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.createNode(alice, 'prototype', 'FAQ', 'faq');
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

test('a session\'s lineage shows a link into a kolab it can\'t read as no more than a link; its own kolab\'s links and a reader of the other kolab see names (W7.1, LNK8)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write', { layers: ['functional'] });
  const carol = await kolab.openSession('carol', 'product', { kolab: 'orders' });
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders ship fast.' }) });
  await kolab.createNode(alice, 'prototype', 'FAQ', 'faq');
  const f1 = await commitReviewed(kolab, alice, carol, 'faq', { elements: els({ F1: 'Invoices come monthly.', F2: 'Orders ship fast.' }) });
  const across = await linkAcross(kolab, alice, f1, 'F1', 'kj:billing/checkout#R1');
  const own = await kolab.link(alice, { kind: 'dependency', source: f1, sourceElement: 'F2', target: o1, targetElement: 'O2' });
  const up = async (session: string, version = f1) => (await kolab.lineagePage({ session }, version, 'upstream')).items;
  const hidden = { edge: across, kind: 'dependency', source: 'kj:faq@1#F1', target: null, target_hidden: 'in another kolab you can\'t read' };
  const ownLink = { edge: own, kind: 'dependency', source: 'kj:faq@1#F2', target: 'kj:orders-spec@1#O2' };
  const sorted = <T extends { edge: string }>(items: T[]) => [...items].sort((a, b) => a.edge.localeCompare(b.edge));

  expect(sorted(await up(alice))).toStrictEqual(sorted([{ edge: across, kind: 'dependency', source: 'kj:faq@1#F1', target: 'kj:billing/checkout@1#R1' }, ownLink]));
  expect(sorted(await up(carol))).toStrictEqual(sorted([hidden, ownLink]));

  // Paged, a link it can't read holds its place: the same links, a page at a time.
  const first = await kolab.lineagePage({ session: carol }, f1, 'upstream', { limit: 1 });
  const second = await kolab.lineagePage({ session: carol }, f1, 'upstream', { cursor: first.next!, limit: 1 });
  expect(sorted([...first.items, ...second.items])).toStrictEqual(sorted([hidden, ownLink]));
  expect(second.next).toBeNull();

  // The links of a version waiting for review, walked by its reviewer, hide the same way.
  const v2 = await kolab.draft(alice, 'faq', { elements: els({ F1: 'Invoices come every month.', F2: 'Orders ship fast.' }) });
  const inReview = await linkAcross(kolab, alice, v2, 'F1', 'kj:billing/checkout#R2');
  await kolab.submit(alice, v2);
  expect(await up(carol, v2)).toContainEqual({ edge: inReview, kind: 'dependency', source: 'kj:faq@2#F1', target: null, target_hidden: 'in another kolab you can\'t read' });
  expect(await up(alice, v2)).toContainEqual({ edge: inReview, kind: 'dependency', source: 'kj:faq@2#F1', target: 'kj:billing/checkout@1#R2' });

  // Downstream, from either side: bob learns nothing of orders, and alice's kolab sees its own link by name.
  const toCheckout = (await kolab.latestCommitted(checkout))!.id;
  expect((await kolab.lineagePage({ session: bob }, toCheckout, 'downstream')).items).toStrictEqual([]);
  expect((await kolab.lineagePage({ session: carol }, o1, 'downstream')).items).toStrictEqual([ownLink]);

  // Read gone, the holder sees what carol sees; Kolab itself still reads the whole link.
  await kolab.revoke('billing', 'alice');
  expect(sorted(await up(alice))).toStrictEqual(sorted([hidden, ownLink]));
  expect(await kolab.lineage(f1, 'upstream')).toContainEqual(expect.objectContaining({ target: 'kj:billing/checkout@1#R1' }));
});

test('unlinking, a version\'s removes and a mark name a link\'s target in another kolab only to a session that reads it, and unlinking by address there confirms nothing (W7.4, LNK8)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write', { layers: ['functional'] });
  const carol = await kolab.openSession('carol', 'product', { kolab: 'orders' });
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders ship fast.' }) });
  const r1 = await kolab.versionIn(alice, 'kj:billing/checkout#R1', { what: 'linking', across: true });
  const edge = await kolab.link(alice, { kind: 'dependency', source: o1, sourceElement: 'O1', target: r1.id, targetElement: 'R1', selector: { exact: 'sent monthly' } });
  // R1 only as an element, an address's #R1 or a field's "R1": a generated id can hold the letters R1.
  const secret = /checkout|billing|#R1\b|"R1"|sent monthly/;
  const named = { kind: 'dependency', source: 'kj:orders-spec@2#O1', target: 'kj:billing/checkout#R1~q({"exact":"sent monthly"})' };
  const hidden = { kind: 'dependency', source: 'kj:orders-spec@2#O1', target: null, target_hidden: 'in another kolab you can\'t read' };
  const same = els({ O1: 'Orders are invoiced monthly.', O2: 'Orders ship fast.' });

  // carol, who can't read billing, removes the link by its id: she is told it went, and nothing of what it linked.
  const v2 = await kolab.draft(carol, 'orders-spec', { elements: same });
  expect(await kolab.unlink(carol, v2, [{ link: edge }])).toStrictEqual([hidden]);
  // Her version's removes, read by her, the same; by alice, who reads billing, named with its kolab and quoted span.
  const removes = async (s: string) => (await kolab.readNode(s, 'orders-spec', 2)).removes;
  expect(await removes(carol)).toStrictEqual([hidden]);
  expect(await removes(alice)).toStrictEqual([named]);
  await kolab.abandon(carol, v2);

  // By address, a target in a kolab she can't read is refused alike whether the link, the node or the kolab is there or not.
  const byAddress = async (target: string) => {
    const d = await kolab.draft(carol, 'orders-spec', { elements: same });
    const refused = await rejection(kolab.unlink(carol, d, [{ sourceElement: 'O1', target }]));
    await kolab.abandon(carol, d);
    const inDraft = await rejection(kolab.draft(carol, 'orders-spec', { elements: same, unlink: [{ sourceElement: 'O1', target }] }));
    return [refused, inDraft].map((m) => m.replace(/kolab \w+,/, 'kolab K,'));
  };
  const refusal = await byAddress('kj:billing/checkout#R1');
  expect(refusal[0]).toMatch(/^AccessError: you can't read kolab K, so a link into it is removed by its id, not its target: konjir_lineage node=orders-spec/);
  expect(refusal[1]).toBe(refusal[0]);
  for (const guess of ['kj:billing/checkout#R2', 'kj:billing/nothing#R1', 'kj:nowhere/checkout#R1']) expect(await byAddress(guess)).toStrictEqual(refusal);
  // alice, who reads billing, still removes it by its address, and a wrong guess of hers is told so.
  const v3 = await kolab.draft(alice, 'orders-spec', { elements: same });
  expect(await kolab.unlink(alice, v3, [{ sourceElement: 'O1', target: 'kj:billing/checkout#R1~q({"exact":"sent monthly"})' }]))
    .toStrictEqual([{ ...named, source: `kj:orders-spec@${(await kolab.version(v3)).seq}#O1` }]);
  expect(await rejection(kolab.unlink(alice, v3, [{ sourceElement: 'O1', target: 'kj:billing/checkout#R2' }]))).toMatch(/has no link from O1 to kj:billing\/checkout#R2/);
  await kolab.abandon(alice, v3);

  // A change of R1 marks O1: carol is told only that a version in another kolab changed; alice, which and when.
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  await kolab.drainOutbox();
  const because = async (s: string) => (await kolab.marksPage(s, {}, {}, { revisit: true })).items.map((m) => m.because);
  expect(await because(carol)).toStrictEqual(['a version in another kolab changed']);
  expect(await because(alice)).toStrictEqual(['kj:billing/checkout#R1~q({"exact":"sent monthly"}) changed in version 2']);
  expect(JSON.stringify([await kolab.marksFor(carol), await markDetails(kolab, carol)])).not.toMatch(secret);

  // alice loses Read: the mark's note says she can't read billing, which carol, who can't either, isn't told by name.
  await kolab.revoke('billing', 'alice');
  const lost = 'alice, whose access it rests on, can no longer read';
  expect(await because(carol)).toEqual(expect.arrayContaining([`it links to a version in another kolab: ${lost} that kolab`]));
  expect(JSON.stringify([await kolab.marksFor(carol), await markDetails(kolab, carol)])).not.toMatch(secret);
  expect(JSON.stringify(await kolab.marksFor(alice))).not.toMatch(secret);
  // Once carol reads billing herself, she is told all of it.
  await kolab.grant('billing', 'carol', 'read');
  expect(await because(carol)).toEqual(expect.arrayContaining([`kj:billing/checkout#R1~q({"exact":"sent monthly"}) is in another kolab: ${lost} that kolab`]));
  expect((await markDetails(kolab, carol)).find((m) => m.reason === 'access_lost')).toMatchObject({ target_node: 'checkout', target_element: 'R1' });
});

test('a session\'s lineage names a link\'s target in a public kolab, though it holds no grant there, beside one it can\'t read (W7.1, LNK8)', async () => {
  const { kolab, alice } = await twoKolabs();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'read');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'orders' });
  await kolab.addActor('dan');
  await kolab.createKolab('pub', { owner: 'dan' });
  const inPub = await kolab.openSession('dan', 'product', { kolab: 'pub' });
  await kolab.commit(inPub, await kolab.createNode(inPub, 'spec', 'Public', 'p'), { elements: els({ P1: 'Anyone may read this.' }) });
  await kolab.db.query(`update kolab set visibility = 'public' where id = 'pub'`);
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders follow both.' }) });
  const open = await linkAcross(kolab, alice, o1, 'O1', 'kj:pub/p#P1');
  const closed = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.revoke('billing', 'alice');
  const seen = (await kolab.lineagePage({ session: carol }, o1, 'upstream')).items;
  expect(seen).toContainEqual({ edge: open, kind: 'dependency', source: 'kj:orders-spec@1#O1', target: 'kj:pub/p@1#P1' });
  expect(seen).toContainEqual({ edge: closed, kind: 'dependency', source: 'kj:orders-spec@1#O1', target: null, target_hidden: 'in another kolab you can\'t read' });
});

test('a commit\'s marks downstream are its own kolab\'s: none a link puts in another kolab, and another kolab\'s session is told none (P18, D49)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  // alice's spec in orders relies on checkout#R1; so does bob's FAQ, in billing.
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced with the monthly invoice.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.createNode(bob, 'prototype', 'Invoice FAQ', 'invoice-faq');
  const f1 = await kolab.commit(bob, 'invoice-faq', { elements: els({ F1: 'Invoices come once a month.' }) });
  await kolab.link(bob, { kind: 'dependency', source: f1, sourceElement: 'F1', target: (await kolab.latestCommitted(checkout))!.id, targetElement: 'R1' });
  const v = await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  await kolab.drainOutbox();
  expect(await marks(kolab, 'orders')).toStrictEqual([['changed', 'kj:orders-spec@1#O1']]);
  // bob's commit lists only billing's mark; alice, in orders, is told none of it, though her kolab's mark has the same trigger.
  expect((await kolab.downstreamMarks(bob, v)).items.map((m) => [m.reason, m.dirty])).toStrictEqual([['changed', 'kj:invoice-faq@1#F1']]);
  expect(await kolab.downstreamMarks(alice, v)).toStrictEqual({ items: [], more: false });
});

test('revoking Read marks the link access_lost in the same change; its target\'s commits stop reaching it until Read comes back', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders are priced in euros.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.createNode(alice, 'prototype', 'FAQ', 'faq');
  const f1 = await kolab.commit(alice, 'faq', { elements: els({ F1: 'Invoices come monthly.' }) });
  await kolab.link(alice, { kind: 'dependency', source: f1, sourceElement: 'F1', target: o1, targetElement: 'O1' });

  await kolab.revoke('billing', 'alice');
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1'], ['upstream_dirty', 'kj:faq@1#F1']]);
  expect((await kolab.describeMarks({ kolab: 'orders' }))[0].because)
    .toBe('kj:billing/checkout#R1 is in another kolab: alice, whose access it rests on, can no longer read that kolab');
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
  expect(await rejection(kolab.clear(alice, lost.id))).toBe('AccessError: alice can\'t read that kolab either: only someone who reads it can hold this link');

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
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders ship fast.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.revoke('billing', 'alice');
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent monthly, on the 1st.', R2: 'Invoices are in euros.' }) });
  const lost = (await kolab.openMarks()).find((m) => m.reason === 'access_lost')!;

  // carol can't read billing either; once she can, she holds the link, and it is checked.
  expect(await rejection(kolab.clear(carol, lost.id))).toBe('AccessError: carol can\'t read that kolab either: only someone who reads it can hold this link');
  await kolab.grant('billing', 'carol', 'read');
  await kolab.clear(carol, lost.id);
  expect((await kolab.db.query(`select held_by from edge where id = $1`, [edge])).rows).toStrictEqual([{ held_by: 'carol' }]);
  expect(await marks(kolab, 'orders')).toStrictEqual([['changed', 'kj:orders-spec@1#O1']]);
  // alice can't clear the change (she can't check it); carol can.
  const changed = (await kolab.openMarks()).find((m) => m.reason === 'changed')!;
  expect(await rejection(kolab.clear(alice, changed.id))).toBe('AccessError: alice can\'t read the kolab this link is into, so can\'t check it; someone who reads that kolab clears it');
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
  await kolab.createNode(alice, 'spec', 'EU checkout', 'checkout-eu');
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
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  await kolab.revoke('billing', 'alice');
  expect((await marks(kolab, 'orders')).map(([r]) => r).sort()).toStrictEqual(['access_lost', 'changed']);
  await kolab.grant('billing', 'carol', 'read');
  const both = (await kolab.openMarks()).map((m) => m.id);
  await kolab.clear(carol, (await kolab.openMarks()).find((m) => m.reason === 'changed')!.id);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  // Both are closed as carol's, naming nothing of billing: anyone in orders reads them (W7.10).
  expect((await kolab.db.query(`select id, cleared_by from invalidation where id = any($1) order by id`, [both])).rows)
    .toStrictEqual([...both].sort().map((id) => ({ id, cleared_by: 'carol' })));
});

test('a link held again by declaring it or revising its element closes its access_lost mark naming nothing of the other kolab (W7.10, LNK8)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'carol', 'read');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'orders' });
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders ship fast.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await linkAcross(kolab, alice, o1, 'O2', 'kj:billing/checkout#R2');
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent monthly.', R2: 'Invoices are in euros and pounds.' }) });
  await kolab.revoke('billing', 'alice');
  const lost = async () => (await kolab.openMarks()).filter((m) => m.reason === 'access_lost');
  expect((await kolab.openMarks()).map((m) => [m.reason, m.element_id]).sort())
    .toStrictEqual([['access_lost', 'O1'], ['access_lost', 'O2'], ['changed', 'O2']]);
  const closedAs = async (id: string) => (await kolab.db.query<{ state: string; cleared_by: string }>(
    `select state, cleared_by from invalidation where id = $1`, [id])).rows[0];

  // carol, who reads billing, declares O1's link again: she holds it, and its mark is closed as hers.
  const o1Lost = (await lost()).find((m) => m.element_id === 'O1')!.id;
  await linkAcross(kolab, carol, o1, 'O1', 'kj:billing/checkout#R1');
  expect(await closedAs(o1Lost)).toStrictEqual({ state: 'cleared', cleared_by: 'held by carol' });

  // R2 changed before alice lost Read. carol revises O2, which relies on it: she holds that link too, and its mark closes the same way.
  const o2Lost = (await lost()).find((m) => m.element_id === 'O2')!.id;
  await commitReviewed(kolab, carol, alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.', O2: 'Orders ship fast, in euros or pounds.' }) });
  await kolab.drainOutbox();
  expect(await closedAs(o2Lost)).toStrictEqual({ state: 'cleared', cleared_by: 'held by carol' });
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
});

test('clearing a mark names nothing of a kolab its session can\'t read, in its refusals or in the marks it closes, as row-level security has it, for an agent capped by its owner too (W7.10, LNK8)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  // carol writes orders and can't read billing; her agent was granted Read there while she held it, and is capped now she doesn't.
  await kolab.addActor('carol');
  await kolab.grant('orders', 'carol', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'carol', 'read');
  await kolab.addActor('carol-bot', { owner: 'carol' });
  await kolab.grant('orders', 'carol-bot', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'carol-bot', 'read');
  await kolab.revoke('billing', 'carol');
  const carol = await kolab.openSession('carol', 'product', { kolab: 'orders' });
  const bot = await kolab.openSession('carol-bot', 'product', { kolab: 'orders' });
  // orders' spec is a fork of billing's; a screen of it links into billing too.
  await kolab.createNode(alice, 'spec', 'EU', 'eu-spec');
  const parent = await kolab.versionIn(alice, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  await commitReviewed(kolab, alice, carol, 'eu-spec', { parent: parent.id, deltas: [{ kind: 'override', element: 'R2', text: 'Invoices are in euros and pounds.' }] });
  await kolab.createNode(alice, 'prototype', 'Orders', 'orders-proto');
  const o1 = await commitReviewed(kolab, alice, carol, 'orders-proto', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  // Refusals are short: no generated id in them, so R1 or a version may not appear at all.
  const secret = /checkout|billing|\bR1\b|sent monthly|version|@\d/;
  const refused = async (s: string, reason: 'changed' | 'access_lost') => {
    const m = (await kolab.openMarks()).find((x) => x.edge_id && (reason === 'access_lost') === (x.reason === 'access_lost'))!;
    return rejection(kolab.clear(s, m.id));
  };
  const cantCheck = (who: string) => `AccessError: ${who} can't read the kolab this link is into, so can't check it; someone who reads that kolab clears it`;

  // R1 changes. Neither carol nor her capped agent can check it, and neither is told where it is.
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  await kolab.drainOutbox();
  for (const [s, who] of [[carol, 'carol'], [bot, 'carol-bot']]) {
    const said = await refused(s, 'changed');
    expect(said).toBe(cantCheck(who));
    expect(said).not.toMatch(secret);
  }
  // Kolab's check agrees with row-level security: the agent's lineage hides the target as carol's does, and alice's names it.
  const target = async (s: string) => (await kolab.lineagePage({ session: s }, o1, 'upstream')).items[0].target;
  expect([await target(carol), await target(bot), await target(alice)]).toStrictEqual([null, null, 'kj:billing/checkout@1#R1']);

  // alice loses Read: the link and the fork are marked access_lost, and taking either over is refused alike, unnamed.
  await kolab.revoke('billing', 'alice');
  const forkLost = (await kolab.openMarks()).find((m) => m.reason === 'access_lost' && !m.edge_id)!;
  for (const [s, who] of [[carol, 'carol'], [bot, 'carol-bot']]) {
    const link = await refused(s, 'access_lost');
    const fork = await rejection(kolab.clear(s, forkLost.id));
    expect([link, fork]).toStrictEqual([
      `AccessError: ${who} can't read that kolab either: only someone who reads it can hold this link`,
      `AccessError: ${who} can't read that kolab either: only someone who reads it can hold this fork`,
    ]);
    expect(`${link} ${fork}`).not.toMatch(secret);
  }

  // Once carol reads billing she takes both over, and clears the change: each mark is closed as hers.
  await kolab.grant('billing', 'carol', 'read');
  const lost = (await kolab.openMarks()).filter((m) => m.reason === 'access_lost').map((m) => m.id);
  for (const m of lost) await kolab.clear(carol, m);
  const changed = (await kolab.openMarks()).find((m) => m.edge_id)!.id;
  await kolab.clear(carol, changed);
  await kolab.drainOutbox();
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  expect((await kolab.db.query(`select id, cleared_by from invalidation where id = any($1) order by id`, [[...lost, changed]])).rows)
    .toStrictEqual([...lost, changed].sort().map((id) => ({ id, cleared_by: 'carol' })));

  // Every mark of orders, open or closed, as a session there that can't read billing reads it (one
  // that belongs to orders' work: 0022): nothing of billing.
  await kolab.addActor('dave');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  const rows = await asAgent(kolab, dave, `select note, cleared_by from invalidation`);
  expect(rows.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(rows)).not.toMatch(/checkout|billing|sent monthly/);
});

test('a public kolab is read through clearing as row-level security reads it: a person with no grant checks a link into it, and an agent its owner can\'t lend that to can\'t (W7.10, LNK8, D56)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.addActor('dave');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'dave', 'read');
  await kolab.addActor('dave-bot', { owner: 'dave' });
  await kolab.grant('orders', 'dave-bot', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'dave-bot', 'read');
  await kolab.db.query(`update kolab set visibility = 'public' where id = 'billing'`);
  // dave now reads billing only because it is public, which lends his agent nothing.
  await kolab.revoke('billing', 'dave');
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  const bot = await kolab.openSession('dave-bot', 'product', { kolab: 'orders' });
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await commitReviewed(kolab, alice, dave, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.commit(bob, checkout, { elements: els({ R1: 'Invoices are sent weekly.', R2: 'Invoices are in euros.' }) });
  await kolab.drainOutbox();
  const changed = (await kolab.openMarks()).find((m) => m.reason === 'changed')!.id;
  const target = async (s: string) => (await kolab.lineagePage({ session: s }, o1, 'upstream')).items[0].target;

  expect(await target(bot)).toBeNull();
  expect(await rejection(kolab.clear(bot, changed))).toBe('AccessError: dave-bot can\'t read the kolab this link is into, so can\'t check it; someone who reads that kolab clears it');
  expect(await target(dave)).toBe('kj:billing/checkout@1#R1');
  await kolab.clear(dave, changed);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  expect((await kolab.db.query(`select held_by from edge where source_version_id = $1`, [o1])).rows).toStrictEqual([{ held_by: 'dave' }]);
});

test('a holder who leaves the dependent\'s kolab is no channel into it: the fork and the link are marked access_lost at once, and the other kolab\'s commits stop (review repro)', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  await kolab.addActor('dave');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'dave', 'read');
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  // dave forks billing/checkout@1 into orders, and links an orders spec to it.
  await kolab.createNode(dave, 'spec', 'EU', 'eu');
  const parent = await kolab.versionIn(dave, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  await commitReviewed(kolab, dave, alice, 'eu', { parent: parent.id, deltas: [{ kind: 'override', element: 'R2', text: 'Invoices are in euros and pounds.' }] });
  await kolab.createNode(dave, 'prototype', 'Orders', 'orders-spec');
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
  await kolab.createNode(dave, 'spec', 'EU', 'eu');
  const parent = await kolab.versionIn(dave, 'kj:billing/checkout@1', { what: 'a variant (a fork)', across: true });
  await commitReviewed(kolab, dave, alice, 'eu', { parent: parent.id, deltas: [{ kind: 'override', element: 'R2', text: 'Invoices are in euros and pounds.' }] });
  await kolab.createNode(dave, 'prototype', 'Orders', 'orders-spec');
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
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.revoke('billing', 'alice');
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1']]);
  // alice can't read billing any more, yet drops the link she can no longer keep: by its id, since
  // by its target would let a session that can't read billing test a guess at what is there (W7.4).
  const d = await kolab.draft(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }), unlink: [{ link: edge }] });
  expect((await kolab.db.query(`select kolab_id, target_kolab_id, target_node_id from link_removal where version_id = $1`, [d])).rows)
    .toStrictEqual([{ kolab_id: 'orders', target_kolab_id: 'billing', target_node_id: checkout }]);
  expect((await kolab.review(d)).ok).toBe(true);
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  expect(await kolab.lineage(d, 'upstream')).toStrictEqual([]);
});

test('another kolab\'s failing dependent work never stops this kolab\'s own cascade, and the committer hears nothing of it', async () => {
  const { kolab, alice, bob, checkout } = await twoKolabs();
  // A link inside billing, and one from orders into it.
  const faq = await kolab.createNode(bob, 'prototype', 'FAQ', 'faq');
  const f1 = await kolab.commit(bob, faq, { elements: els({ F1: 'See the invoice schedule.' }) });
  await kolab.link(bob, { kind: 'dependency', source: f1, sourceElement: 'F1', target: (await kolab.latestCommitted(checkout))!.id, targetElement: 'R1' });
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
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
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
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
  await kolab.createNode(bob, 'prototype', 'Other', 'other');
  await kolab.addActor('carl');
  await kolab.createKolab('shop', { owner: 'carl' });
  const carl = await kolab.openSession('carl', 'product', { kolab: 'shop' });
  await kolab.createNode(carl, 'spec', 'Shop', 'shop-spec');
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
  await kolab.createNode(bob, 'spec', 'Checkout', 'checkout');
  await kolab.commit(bob, 'checkout', { elements: els({ R1: 'Invoices are sent monthly.' }) });
  await kolab.createNode(alice, 'spec', 'EU', 'eu');
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
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
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
  await kolab.createNode(bob, 'spec', 'Checkout', 'checkout');
  await kolab.commit(bob, 'checkout', { elements: els({ R1: 'Invoices are sent monthly.' }) });
  await kolab.createNode(alice, 'spec', 'EU', 'eu');
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
  expect(JSON.stringify(seen)).not.toMatch(/upstream-private-detail|billing/);
  // Dead after its attempts: its rebase_failed mark and question say nothing of it either.
  for (let i = 0; i < 12; i++) {
    await kolab.db.query(`update outbox set run_after = now()`);
    await kolab.drainOutbox();
  }
  expect((await kolab.outboxJobs()).map((j) => j.state)).toStrictEqual(['dead']);
  const said = JSON.stringify({ marks: await kolab.describeMarks({ kolab: 'orders' }), queries: await kolab.listQueries({ kolab: 'orders' }) });
  expect(said).toMatch(/rebase_failed/);
  expect(said).not.toMatch(/upstream-private-detail/);
});

test('archiving a holder, or bringing back a dependent kolab, marks links and forks in the same transaction (verification review)', async () => {
  const { kolab, alice, checkout } = await twoKolabs();
  await kolab.addActor('dave');
  await kolab.grant('orders', 'dave', 'write', { layers: ['functional'] });
  await kolab.grant('billing', 'dave', 'read');
  const dave = await kolab.openSession('dave', 'product', { kolab: 'orders' });
  await kolab.createNode(dave, 'spec', 'O', 'o');
  const o1 = await commitReviewed(kolab, dave, alice, 'o', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  await linkAcross(kolab, dave, o1, 'O1', 'kj:billing/checkout#R1');
  await kolab.archive({ actor: 'dave' });
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:o@1#O1']]);
  await kolab.unarchive({ actor: 'dave' });
  expect(await marks(kolab, 'orders')).toStrictEqual([]);
  const dave2 = await kolab.openSession('dave', 'product', { kolab: 'orders' });

  // alice's link from orders, revoked while orders was archived: marked as orders comes back.
  await kolab.createNode(alice, 'prototype', 'Orders', 'orders-spec');
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
  await kolab.createNode(alice, 'spec', 'Orders', 'orders-spec');
  const o1 = await kolab.commit(alice, 'orders-spec', { elements: els({ O1: 'Orders are invoiced monthly.' }) });
  const edge = await linkAcross(kolab, alice, o1, 'O1', 'kj:billing/checkout#R1');
  // Behind Kolab's back, alice's Read goes, with no mark; carol, who can't read billing, tries to hold it.
  await kolab.db.transaction(async (tx) => {
    await tx.query(`delete from kolab_grant where kolab_id = 'billing' and user_id = 'alice'`);
    // The database requires a change of access to be recorded (W2.20), even one made by hand.
    await tx.query(`insert into audit_event(action, kolab_id, subject, done_by) values ('grant.removed', 'billing', 'alice', 'test')`);
  });
  await kolab.addActor('carol');
  const k = kolab as unknown as { holdLink: (edge: string, actor: string) => Promise<boolean> };
  expect(await k.holdLink(edge, 'carol')).toBe(false);
  expect((await kolab.db.query(`select held_by from edge where id = $1`, [edge])).rows).toStrictEqual([{ held_by: 'alice' }]);
  expect(await marks(kolab, 'orders')).toStrictEqual([['access_lost', 'kj:orders-spec@1#O1']]);
  expect([bob, checkout]).toHaveLength(2);
});
