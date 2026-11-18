// Leases in a kolab (migration 0054): a named thing one member, a person or an agent, holds at a
// time, for a while, so agents working side by side keep off each other's shared resources. Free
// or expired, a claim takes it; the holder's own claim renews it; someone else's is no error but
// says who holds it. Its holder releases it; only a person who is a member breaks it. Leases are
// per kolab, for members only, and go with a member who is removed or leaves, or an agent removed.
import { expect, test } from '@jest/globals';
import { DEFAULT_LEASE_SECONDS, MAX_LEASES, MAX_LEASES_PER_MEMBER } from '@konjir/types';
import { openKolab, rejection, TestKolab } from '@konjir/engine/testing';

/** Ann owns `hub`; Bo writes there; each has an agent there (ann-claude, bo-claude). Sam has nothing. */
async function hub(kolab?: TestKolab) {
  const k = kolab ?? await openKolab();
  for (const id of ['ann', 'bo', 'sam']) await k.addActor(id);
  await k.addActor('ann-claude', { owner: 'ann' });
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('hub', { owner: 'ann' });
  await k.grant('hub', 'bo', 'write');
  await k.grant('hub', 'ann-claude', 'write');
  await k.grant('hub', 'bo-claude', 'write');
  const ann = await k.openSession('ann', 'product', { kolab: 'hub' });
  const bo = await k.openSession('bo', 'engineer', { kolab: 'hub' });
  const annAgent = await k.openSession('ann-claude', 'product', { kolab: 'hub' });
  const boAgent = await k.openSession('bo-claude', 'engineer', { kolab: 'hub' });
  return { kolab: k, ann, bo, annAgent, boAgent };
}

/** Moves a lease's expiry into the past, as time passing would: no sleeping. */
const expire = (kolab: TestKolab, name: string) =>
  kolab.db.query(`update kolab_lease set expires_at = clock_timestamp() - interval '1 second', claimed_at = clock_timestamp() - interval '1 hour' where name = $1`, [name]);

const seconds = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

test('a claim of a free name holds it; the holder\'s claim renews it; someone else\'s says who holds it, until it expires and is free', async () => {
  const { kolab, ann, boAgent } = await hub();
  const first = await kolab.claimLease(boAgent, 'testdb', { note: 'running the e2e suite' });
  expect(first).toStrictEqual({
    claimed: true, renewed: false,
    lease: { name: 'testdb', holder: 'bo-claude', claimed_at: expect.any(String), expires_at: expect.any(String), note: 'running the e2e suite' },
  });
  if (!first.claimed) throw new Error('unreachable');
  expect(seconds(first.lease.claimed_at, first.lease.expires_at)).toBe(DEFAULT_LEASE_SECONDS);
  expect(new Date(first.lease.claimed_at).toISOString()).toBe(first.lease.claimed_at);

  // Someone else: no error, the holder's lease.
  expect(await kolab.claimLease(ann, 'testdb')).toStrictEqual({ claimed: false, lease: first.lease });

  // The holder again: renewed from now for its seconds, claimed_at kept; a note given replaces it, none keeps it.
  const renewed = await kolab.claimLease(boAgent, 'testdb', { seconds: 3600 });
  expect(renewed).toMatchObject({ claimed: true, renewed: true, lease: { name: 'testdb', holder: 'bo-claude', claimed_at: first.lease.claimed_at, note: 'running the e2e suite' } });
  expect(Date.parse(renewed.lease.expires_at)).toBeGreaterThan(Date.parse(first.lease.expires_at));
  expect(seconds(new Date().toISOString(), renewed.lease.expires_at)).toBeGreaterThan(3590);
  expect(await kolab.claimLease(boAgent, 'testdb', { note: 'now migrating' })).toMatchObject({ claimed: true, renewed: true, lease: { note: 'now migrating' } });

  // Expired: free, not listed, and the next claim takes it, as a new lease.
  await expire(kolab, 'testdb');
  expect(await kolab.listLeases(ann)).toStrictEqual({ leases: [] });
  expect(await kolab.releaseLease(boAgent, 'testdb')).toStrictEqual({ released: false, name: 'testdb' });
  const taken = await kolab.claimLease(ann, 'testdb', { seconds: 60 });
  expect(taken).toMatchObject({ claimed: true, renewed: false, lease: { name: 'testdb', holder: 'ann', note: null } });
  expect(seconds(taken.lease.claimed_at, taken.lease.expires_at)).toBe(60);
  // The holder's own expired lease, claimed again, is a new one, not a renewal.
  await expire(kolab, 'testdb');
  expect(await kolab.claimLease(ann, 'testdb')).toMatchObject({ claimed: true, renewed: false, lease: { holder: 'ann', note: null } });
  // Expired leases are cleared away as claims come: one row per held name.
  expect((await kolab.db.query(`select name, holder from kolab_lease`)).rows).toStrictEqual([{ name: 'testdb', holder: 'ann' }]);
});

test('list gives every live lease of the kolab, soonest to expire first', async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  await kolab.claimLease(ann, 'port-3000', { seconds: 3600 });
  await kolab.claimLease(boAgent, 'apps/server/src/x.ts', { seconds: 60, note: 'refactoring' });
  await kolab.claimLease(bo, 'testdb', { seconds: 600 });
  await kolab.claimLease(bo, 'gone', { seconds: 600 });
  await expire(kolab, 'gone');
  const { leases } = await kolab.listLeases(boAgent);
  expect(leases.map((l) => [l.name, l.holder, l.note])).toStrictEqual([
    ['apps/server/src/x.ts', 'bo-claude', 'refactoring'], ['testdb', 'bo', null], ['port-3000', 'ann', null],
  ]);
});

test('its holder releases a lease; anyone else is refused, naming the holder; releasing one not held says so', async () => {
  const { kolab, ann, annAgent, boAgent } = await hub();
  await kolab.claimLease(boAgent, 'testdb');
  expect(await rejection(kolab.releaseLease(annAgent, 'testdb'))).toMatch(/^AccessError: lease testdb in kolab hub is held by bo-claude until \S+, not by you/);
  expect(await rejection(kolab.releaseLease(ann, 'testdb'))).toMatch(/held by bo-claude/);
  expect(await kolab.releaseLease(boAgent, 'testdb')).toStrictEqual({ released: true, name: 'testdb' });
  expect(await kolab.listLeases(ann)).toStrictEqual({ leases: [] });
  // Released: free, so a release again finds nothing, and anyone may claim it.
  expect(await kolab.releaseLease(boAgent, 'testdb')).toStrictEqual({ released: false, name: 'testdb' });
  expect(await kolab.releaseLease(boAgent, 'never-held')).toStrictEqual({ released: false, name: 'never-held' });
  expect(await kolab.claimLease(annAgent, 'testdb')).toMatchObject({ claimed: true, renewed: false, lease: { holder: 'ann-claude' } });
  // Who released it was recorded until the next claim cleared the row away.
  expect((await kolab.db.query(`select count(*)::int as n from kolab_lease where ended_by is not null`)).rows[0]).toStrictEqual({ n: 0 });
});

test('a person who is a member breaks anyone\'s lease; an agent\'s session is refused', async () => {
  const { kolab, bo, annAgent, boAgent } = await hub();
  const held = await kolab.claimLease(annAgent, 'testdb', { note: 'stuck' });
  expect(await rejection(kolab.breakLease(boAgent, 'testdb'))).toMatch(/^AccessError: bo-claude is an agent: only a person breaks a lease/);
  expect(await rejection(kolab.breakLease(annAgent, 'testdb'))).toMatch(/^AccessError: ann-claude is an agent/);
  expect(await kolab.breakLease(bo, 'testdb')).toStrictEqual({ broken: true, lease: held.lease });
  expect((await kolab.db.query(`select ended_by from kolab_lease where name = 'testdb'`)).rows).toStrictEqual([{ ended_by: 'bo' }]);
  expect(await kolab.listLeases(bo)).toStrictEqual({ leases: [] });
  expect(await kolab.breakLease(bo, 'testdb')).toStrictEqual({ broken: false, name: 'testdb' });
  expect(await kolab.claimLease(boAgent, 'testdb')).toMatchObject({ claimed: true, lease: { holder: 'bo-claude' } });
});

test('names: 1 to 200 letters, digits and . _ / @ : -, compared exactly; seconds 60 to 14400; a note at most 200 characters', async () => {
  const { kolab, ann, bo } = await hub();
  for (const good of ['testdb', 'port-3000', 'apps/server/src/x.ts', 'db@host:5432', 'A_b.c', 'x'.repeat(200)]) {
    expect(await kolab.claimLease(ann, good)).toMatchObject({ claimed: true, lease: { name: good } });
  }
  for (const bad of ['', ' testdb', 'test db', 'x'.repeat(201), 'café', 'a\nb', 'a*b']) {
    expect(await rejection(kolab.claimLease(ann, bad))).toMatch(/^LimitError: .* is no lease name: a lease is named with 1 to 200 letters/);
    expect(await rejection(kolab.releaseLease(ann, bad))).toMatch(/is no lease name/);
    expect(await rejection(kolab.breakLease(ann, bad))).toMatch(/is no lease name/);
  }
  // Exactly as given: case matters.
  expect(await kolab.claimLease(bo, 'TestDB')).toMatchObject({ claimed: true, lease: { holder: 'bo' } });
  expect(await kolab.claimLease(bo, 'testdb')).toMatchObject({ claimed: false, lease: { holder: 'ann' } });

  for (const s of [59, 14401, 0, -60, 90.5]) {
    expect(await rejection(kolab.claimLease(bo, 'fresh', { seconds: s }))).toMatch(/^LimitError: seconds is how long the lease is held: a whole number from 60 to 14400/);
  }
  expect(await kolab.claimLease(bo, 'fresh', { seconds: 14400 })).toMatchObject({ claimed: true });
  expect(await kolab.claimLease(bo, 'fresh2', { seconds: 60, note: 'n'.repeat(200) })).toMatchObject({ claimed: true });
  expect(await rejection(kolab.claimLease(bo, 'fresh3', { note: 'n'.repeat(201) }))).toMatch(/^LimitError: a lease's note is at most 200 characters/);
  expect(await rejection(kolab.claimLease(bo, 'fresh3', { note: '   ' }))).toMatch(/note is at most 200/);
});

test(`a member holds at most ${MAX_LEASES_PER_MEMBER} leases in a kolab, and a kolab at most ${MAX_LEASES}: past either, refused, saying which`, async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  for (let i = 0; i < MAX_LEASES_PER_MEMBER; i++) await kolab.claimLease(bo, `bo-${i}`);
  expect(await rejection(kolab.claimLease(bo, 'one-more'))).toMatch(new RegExp(`^LimitError: you hold ${MAX_LEASES_PER_MEMBER} leases in kolab hub, the most a member holds at once`));
  // Renewing one held is no new lease; another member is counted apart, an agent of bo's too.
  expect(await kolab.claimLease(bo, 'bo-0')).toMatchObject({ claimed: true, renewed: true });
  expect(await kolab.claimLease(boAgent, 'one-more')).toMatchObject({ claimed: true });
  // One expired is free, and no longer counted.
  await expire(kolab, 'bo-1');
  expect(await kolab.claimLease(bo, 'one-more-2')).toMatchObject({ claimed: true });

  // The kolab's limit: fill it with rows as members would, then a claim is refused.
  await kolab.db.query(`delete from kolab_lease`);
  await kolab.db.query(
    `insert into kolab_lease(kolab_id, name, holder, expires_at) select 'hub', 'n-' || i, case when i % 2 = 0 then 'ann' else 'ann-claude' end, now() + interval '1 hour'
       from generate_series(1, $1) i`, [MAX_LEASES]);
  expect(await rejection(kolab.claimLease(bo, 'past-the-kolab'))).toMatch(new RegExp(`^LimitError: kolab hub holds ${MAX_LEASES} leases, the most a kolab holds at once`));
  expect((await kolab.listLeases(ann)).leases).toHaveLength(MAX_LEASES);
});

test('two members claiming one free name at once: exactly one holds it, and the other sees their lease', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  const sessions = [ann, bo, annAgent, boAgent];
  for (let round = 0; round < 5; round++) {
    const name = `race-${round}`;
    const results = await Promise.all(sessions.map((s) => kolab.claimLease(s, name)));
    const winners = results.filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    for (const r of results) expect(r.lease).toStrictEqual(winners[0].lease);
  }
});

test('a member removed or leaving loses their leases and their agents\' there; an agent removed by its owner loses its own; elsewhere they keep theirs', async () => {
  const { kolab, ann, bo, annAgent, boAgent } = await hub();
  await kolab.createKolab('side', { owner: 'bo' });
  // bo-claude holds one in another kolab too (written as a claim there would write it: one session per machine here).
  await kolab.db.query(`insert into kolab_lease(kolab_id, name, holder, expires_at) values ('side', 'testdb', 'bo-claude', now() + interval '1 hour')`);

  await kolab.claimLease(bo, 'bo-thing');
  await kolab.claimLease(boAgent, 'agent-thing');
  await kolab.claimLease(annAgent, 'ann-thing');
  await kolab.removeKolabMember(ann, 'bo');
  expect((await kolab.listLeases(ann)).leases.map((l) => l.name)).toStrictEqual(['ann-thing']);
  expect((await kolab.db.query(`select kolab_id, name from kolab_lease order by kolab_id, name`)).rows)
    .toStrictEqual([{ kolab_id: 'hub', name: 'ann-thing' }, { kolab_id: 'side', name: 'testdb' }]);

  // Leaving takes them too.
  await kolab.grant('hub', 'bo', 'write');
  await kolab.grant('hub', 'bo-claude', 'write');
  const bo2 = await kolab.openSession('bo', 'engineer', { kolab: 'hub' });
  const boAgent2 = await kolab.openSession('bo-claude', 'engineer', { kolab: 'hub' });
  await kolab.claimLease(bo2, 'bo-thing');
  await kolab.claimLease(boAgent2, 'agent-thing');
  await kolab.leaveKolab(bo2);
  expect((await kolab.listLeases(ann)).leases.map((l) => l.name)).toStrictEqual(['ann-thing']);

  // An agent removed by its owner: its leases there go, its owner's stay.
  await kolab.claimLease(ann, 'ann-own');
  await kolab.removeOwnAgent(ann, 'claude');
  expect((await kolab.listLeases(ann)).leases.map((l) => [l.name, l.holder])).toStrictEqual([['ann-own', 'ann']]);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_lease where holder = 'ann-claude'`)).rows[0]).toStrictEqual({ n: 0 });
});

test('a lease whose holder lost their access some other way is free, though its row is still there', async () => {
  const { kolab, ann, boAgent } = await hub();
  await kolab.claimLease(boAgent, 'testdb');
  await kolab.revoke('hub', 'bo-claude');
  expect(await kolab.listLeases(ann)).toStrictEqual({ leases: [] });
  expect(await kolab.claimLease(ann, 'testdb')).toMatchObject({ claimed: true, renewed: false, lease: { holder: 'ann' } });
});

test('only a member lists or claims: not a reader of a public kolab; and a lease in another kolab is never seen', async () => {
  const kolab = await openKolab();
  for (const id of ['cy', 'dee']) await kolab.addActor(id);
  await kolab.createKolab('open', { owner: 'cy', visibility: 'public' });
  const dee = await kolab.openSession('dee', 'product', { kolab: 'open' });
  const cyOpen = await kolab.openSession('cy', 'product', { kolab: 'open' });
  const refusal = /^AccessError: dee is not a member of kolab open: its leases are for those who hold access there/;
  await kolab.claimLease(cyOpen, 'testdb');
  expect(await rejection(kolab.listLeases(dee))).toMatch(refusal);
  expect(await rejection(kolab.claimLease(dee, 'testdb'))).toMatch(refusal);
  expect(await rejection(kolab.claimLease(dee, 'other'))).toMatch(refusal);
  expect(await rejection(kolab.releaseLease(dee, 'testdb'))).toMatch(refusal);
  expect(await rejection(kolab.breakLease(dee, 'testdb'))).toMatch(refusal);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_lease`)).rows[0]).toStrictEqual({ n: 1 });

  // Per kolab: the same name in another is another lease, and neither is seen from the other.
  const { kolab: k, ann, bo } = await hub(kolab);
  expect(await k.claimLease(bo, 'testdb')).toMatchObject({ claimed: true, renewed: false, lease: { holder: 'bo' } });
  expect((await k.listLeases(ann)).leases.map((l) => [l.name, l.holder])).toStrictEqual([['testdb', 'bo']]);
  expect((await k.listLeases(cyOpen)).leases.map((l) => [l.name, l.holder])).toStrictEqual([['testdb', 'cy']]);
  expect(await rejection(k.releaseLease(ann, 'testdb'))).toMatch(/held by bo until/);
});

test('an archived kolab\'s leases change no more', async () => {
  const { kolab, bo } = await hub();
  await kolab.claimLease(bo, 'testdb');
  await kolab.archive({ kolab: 'hub' });
  expect(await rejection(kolab.db.query(`update kolab_lease set note = 'x'`))).toMatch(/archived/);
  expect(await rejection(kolab.db.query(`delete from kolab_lease`))).toMatch(/archived/);
});
