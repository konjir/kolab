// Property tests for links and forks across kolabs (W2.16, extending W2.5's TST2; LNK8, KON9,
// D49). fast-check generates sequences of grants and revocations of Read, commits upstream, clears
// and take-overs, over a link and a fork from one kolab into another. After every step: a link or
// fork whose holder reads the other kolab carries no access_lost mark, and one whose holder
// doesn't carries exactly one; a link with no open mark is pinned to its target's latest version
// with a matching fingerprint; a fork with no open mark sits on its parent's latest version; and
// the upstream kolab's sessions see none of the downstream kolab's rows.
//
// Deterministic: the seed is fixed (KONJIR_PROPERTY_SEED, KONJIR_PROPERTY_RUNS as in properties.test.ts).
import { expect, test } from '@jest/globals';
import fc from 'fast-check';
import { fingerprint } from '@konjir/address';
import { sessionKey, type Kolab } from '@konjir/engine';
import { els, openKolab, TestKolab } from '@konjir/engine/testing';

const SEED = Number(process.env.KONJIR_PROPERTY_SEED ?? 0x5eed);
const RUNS = Number(process.env.KONJIR_PROPERTY_RUNS ?? (process.env.KONJIR_TEST_DATABASE_URL ? 20 : 12));

const reader = fc.constantFrom('alice', 'carol');
const op = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('grant' as const), who: reader }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('revoke' as const), who: reader }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('commit' as const), text: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('clear' as const), who: reader, k: fc.nat() }) },
);
type Op = typeof op extends fc.Arbitrary<infer T> ? T : never;

let runs = 0;

async function build(kolab: TestKolab) {
  const r = `r${++runs}`;
  const [alice, bob, carol, down, up] = ['alice', 'bob', 'carol', 'down', 'up'].map((x) => `${x}-${r}`);
  for (const a of [alice, bob, carol]) await kolab.addActor(a);
  await kolab.createKolab(down, { owner: alice });
  await kolab.createKolab(up, { owner: bob });
  await kolab.grant(down, carol, 'write', { layers: ['functional'] });
  await kolab.grant(up, alice, 'read');
  const sa = await kolab.openSession(alice, 'product', { kolab: down });
  const sb = await kolab.openSession(bob, 'product', { kolab: up });
  const sc = await kolab.openSession(carol, 'product', { kolab: down });
  const spec = await kolab.createNode(sb, 'spec', 'Spec', `spec-${r}`);
  const u1 = await kolab.commit(sb, spec, { elements: els({ R1: `${r} text 0`, R2: `${r} fixed` }) });
  // alice's link and fork; carol (a second writer in down) reviews them.
  const dep = await kolab.createNode(sa, 'prototype', 'Dep', `dep-${r}`);
  const d1v = await kolab.draft(sa, dep, { elements: els({ D1: `${r} relies on R1` }) });
  await kolab.review(d1v);
  await kolab.recordReview(sc, d1v, { verdict: 'approve' });
  const edge = await kolab.link(sa, { kind: 'dependency', source: d1v, sourceElement: 'D1', target: u1, targetElement: 'R1' });
  const fork = await kolab.createNode(sa, 'spec', 'Fork', `fork-${r}`);
  const f1 = await kolab.draft(sa, fork, { parent: u1, deltas: [{ kind: 'override', element: 'R2', text: `${r} forked` }] });
  await kolab.review(f1);
  await kolab.recordReview(sc, f1, { verdict: 'approve' });
  return { r, ids: { alice, bob, carol }, sessions: { alice: sa, carol: sc } as Record<string, string>, sb, down, up, spec, dep, fork, edge };
}

type World = Awaited<ReturnType<typeof build>>;

async function step(kolab: TestKolab, w: World, o: Op) {
  const who = o.t === 'commit' ? '' : w.ids[o.who as 'alice' | 'carol'];
  if (o.t === 'grant') await kolab.grant(w.up, who, 'read');
  else if (o.t === 'revoke') await kolab.revoke(w.up, who);
  else if (o.t === 'commit') {
    const now = (await kolab.elements((await kolab.latestCommitted(w.spec))!.id)).find((e) => e.element_id === 'R1')!.text;
    const text = `${w.r} text ${o.text}`;
    await kolab.commit(w.sb, w.spec, { elements: els({ R1: text === now ? `${text}.` : text, R2: `${w.r} fixed` }) });
  } else {
    const open = (await kolab.openMarks()).filter((m) => m.version_id.length && ['changed', 'access_lost'].includes(m.reason));
    const mine = [];
    for (const m of open) if ((await kolab.version(m.version_id)).kolab_id === w.down) mine.push(m);
    if (!mine.length) return;
    // Refused when `who` can't read up; that's part of the property too: nothing changes then.
    await kolab.clear(w.sessions[o.who], mine[o.k % mine.length].id).catch((e) => {
      if (!/can't read kolab/.test(String(e))) throw e;
    });
  }
}

async function check(kolab: TestKolab, w: World, where: string) {
  const fail = (what: string) => { throw new Error(`${where}: ${what}`); };
  const reads = async (actor: string | null) => !!actor && !!(await kolab.access(actor, w.up)).level;
  const latestUp = (await kolab.latestCommitted(w.spec))!;
  const open = await kolab.openMarks();

  // The link, on dep's live version.
  const depLive = (await kolab.latestCommitted(w.dep))!;
  const e = (await kolab.db.query<{ id: string; held_by: string; target_version_id: string; target_fingerprint: string }>(
    `select id, held_by, target_version_id, target_fingerprint from edge where source_version_id = $1 and target_kolab_id <> kolab_id`, [depLive.id])).rows;
  if (e.length !== 1) fail(`dep's live version has ${e.length} links into ${w.up}`);
  const onEdge = open.filter((m) => m.edge_id === e[0].id);
  const lost = onEdge.filter((m) => m.reason === 'access_lost').length;
  if ((await reads(e[0].held_by)) ? lost !== 0 : lost !== 1) fail(`link held by ${e[0].held_by} has ${lost} access_lost marks`);
  if (!onEdge.length) {
    const r1 = (await kolab.elements(latestUp.id)).find((x) => x.element_id === 'R1')!;
    if (e[0].target_version_id !== latestUp.id || e[0].target_fingerprint !== fingerprint(r1.text)) fail('an unmarked link is not pinned to its target\'s latest version');
  }

  // The fork.
  const forkLive = (await kolab.latestCommitted(w.fork))!;
  const forkLost = open.filter((m) => m.version_id === forkLive.id && m.reason === 'access_lost' && !m.edge_id).length;
  const forkMarks = open.filter((m) => m.version_id === forkLive.id && !m.edge_id && ['access_lost', 'rebase_failed'].includes(m.reason)).length;
  if ((await reads(forkLive.parent_held_by ?? null)) ? forkLost !== 0 : forkLost !== 1) fail(`fork held by ${forkLive.parent_held_by} has ${forkLost} access_lost marks`);
  if (!forkMarks && forkLive.parent_version_id !== latestUp.id) fail('an unmarked fork is not on its parent\'s latest version');
  const forked = (await kolab.elements(forkLive.id)).find((x) => x.element_id === 'R2')!.text;
  if (forked !== `${w.r} forked`) fail(`the fork lost its override: ${forked}`);

  // Every open mark of down's stays in down, and up's session sees none of down's rows.
  for (const t of ['edge', 'invalidation', 'version', 'node']) {
    const seen = await kolab.db.transaction(async (tx) => {
      await tx.exec('set local role kj_agent');
      await tx.query(`select set_config('kj.session', $1, true)`, [sessionKey(w.sb)]);
      return (await tx.query(`select 1 from ${t} where kolab_id = $1`, [w.down])).rows.length;
    });
    if (seen) fail(`${w.up}'s session reads ${seen} ${t} rows of ${w.down}`);
  }
  const causes = (await kolab.db.query<{ n: number }>(
    `select count(*)::int as n from invalidation_cause c join invalidation a on a.id = c.mark_id join invalidation b on b.id = c.cause_id where a.kolab_id <> b.kolab_id`)).rows[0].n;
  if (causes) fail(`${causes} mark causes cross a kolab`);
}

test('across kolabs, every link and fork is marked access_lost exactly while its holder can\'t read, and is otherwise current or marked', async () => {
  const kolab = await openKolab();
  await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 10 }), async (ops) => {
    const w = await build(kolab);
    await check(kolab, w, 'after building');
    for (const [i, o] of ops.entries()) {
      await step(kolab, w, o);
      await check(kolab, w, `after step ${i + 1} ${JSON.stringify(o)} of ${JSON.stringify(ops)}`);
    }
  }), { seed: SEED, numRuns: RUNS, endOnFailure: process.env.KONJIR_PROPERTY_SHRINK === '0' });
  expect(await kolab.outboxJobs({ state: 'dead' })).toStrictEqual([]);
}, 600_000);
