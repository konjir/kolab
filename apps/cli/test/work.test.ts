// Work packages over MCP and in a shell (W5.1b; PLN12–PLN19, D98): the board, pulling with its
// context and trailer, reading a package with its events, releasing, reassigning and the lease;
// a tool call renews the lease and a resource read (what a listen stream prompts) doesn't; a lapse
// reaches the assignee's answers.
import { afterEach, expect, jest, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { call, connect, main } from '../src/cli.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';
const env = { ...process.env };
afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; });

/** A kolab with a spec, its binding and a plan of three work packages, W2 after W1; two engineer agents, a maintainer and a product agent. */
async function planned() {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const agent = async (id: string, role: 'product' | 'engineer', level = 'write') => {
    await call(admin, 'admin_add_actor', { id });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, level, ...(level === 'write' ? { layers: [role === 'product' ? 'functional' : 'technical'] } : {}) });
    const { token } = (await call(admin, 'admin_open_session', { actor: id, role })) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token };
  };
  const pm = await agent('pm', 'product');
  const eng = await agent('eng', 'engineer');
  await call(pm.c, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'Orders ship in a day.' }] });
  await call(pm.c, 'submit_for_review', { node: 'orders', version: 1 });
  await call(eng.c, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await call(eng.c, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }, { id: 'b2', text: 'A queue.' }],
    links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }, { source_element: 'b2', target: 'kj:orders@1#R2' }] });
  await call(eng.c, 'submit_for_review', { node: 'orders-pg', version: 1 });
  await call(eng.c, 'create_node', { kind: 'plan', title: 'Plan', id: 'orders-plan' });
  await call(eng.c, 'draft', { node: 'orders-plan', elements: [
    { id: 'W1', text: 'Build the endpoint.', work: { done_when: 'It cancels.', size: 'S' } },
    { id: 'W2', text: 'Build the queue.', work: { depends_on: ['W1'] } },
    { id: 'W10', text: 'Document it.' },
  ], links: [{ source_element: 'W1', target: 'kj:orders-pg@1#b1' }, { source_element: 'W2', target: 'kj:orders-pg@1#b2' }] });
  await call(eng.c, 'submit_for_review', { node: 'orders-plan', version: 1 });
  // Added after the binding committed, so it needed no review.
  const eng2 = await agent('eng2', 'engineer');
  const lead = await agent('lead', 'engineer', 'maintain');
  return { kolab, server, pm, eng, eng2, lead };
}

test('over MCP: the board in natural order, a pull with its context and trailer, one at a time, read with events, release, reassign and the lease (PLN12–PLN19, D98)', async () => {
  const { pm, eng, eng2, lead } = await planned();
  const board = await call(eng.c, 'list_work', {}) as { work: { id: string; state: string; ready: boolean; blocked: unknown[] }[]; next: string | null };
  expect(board.work.map((w) => [w.id, w.state, w.ready])).toStrictEqual([['W1', 'todo', true], ['W2', 'todo', false], ['W10', 'todo', true]]);
  expect(board.work[1].blocked).toStrictEqual([{ reason: 'depends_on', work: 'kj:orders-plan#W1', state: 'todo' }]);
  // A product session sees the board, nothing ready for it, and pulls nothing.
  expect((await call(pm.c, 'list_work', { ready: true }) as { work: unknown[] }).work).toStrictEqual([]);
  expect(await rejection(call(pm.c, 'pull_work', {}))).toMatch(/a product session pulls no work/);

  const pulled = await call(eng.c, 'pull_work', {}) as Record<string, unknown>;
  expect(pulled).toMatchObject({
    pulled: true, work: 'kj:orders-plan#W1', state: 'in_progress', assignee: 'eng', trailer: 'Konjir-Work: kj:test/orders-plan#W1',
    context: { done_when: 'It cancels.', size: 'S', delivers: [{ address: 'kj:orders-pg@1#b1', text: 'A cancel endpoint.', links: [{ address: 'kj:orders@1#R1', text: 'Orders can be cancelled.' }] }] },
  });
  expect(pulled.next).toMatch(/Put "Konjir-Work: kj:test\/orders-plan#W1" as a trailer in every commit/);
  expect(await rejection(call(eng.c, 'pull_work', {}))).toMatch(/eng already holds kj:orders-plan#W1 In progress/);
  expect(await call(eng2.c, 'pull_work', {})).toMatchObject({ pulled: true, work: 'kj:orders-plan#W10' });
  expect(await call(eng.c, 'list_work', { mine: true })).toMatchObject({ work: [{ id: 'W1', assignee: 'eng' }] });

  // Read one, with its events.
  const read = await call(eng2.c, 'read_work', { work: 'kj:orders-plan#W1' }) as { events: { kind: string; actor: string }[]; events_next: string | null };
  expect(read.events.map((e) => [e.kind, e.actor])).toStrictEqual([['added', 'eng'], ['pulled', 'eng']]);
  expect(read.events_next).toBeNull();
  const page = await call(eng2.c, 'read_work', { work: 'kj:orders-plan#W1', limit: 1 }) as { events: unknown[]; events_next: string };
  expect(page.events).toHaveLength(1);
  expect(await call(eng2.c, 'read_work', { work: 'kj:orders-plan#W1', limit: 1, events_cursor: page.events_next })).toMatchObject({ events: [{ kind: 'pulled' }] });
  expect(await rejection(call(eng2.c, 'read_work', { work: 'kj:orders-plan@1#W1' }))).toMatch(/with no @version/);
  expect(await rejection(call(eng2.c, 'read_work', { work: 'kj:elsewhere/orders-plan#W1' }))).toMatch(/no work package kj:orders-plan#W1 in kolab test/);

  // Release: the assignee only.
  expect(await rejection(call(eng2.c, 'release_work', { work: 'kj:orders-plan#W1' }))).toMatch(/held by eng: only its assignee releases/);
  expect(await call(eng.c, 'release_work', { work: 'kj:orders-plan#W1', note: 'Back later.' })).toMatchObject({ state: 'todo', assignee: null });

  // Reassign and the lease length: Maintain only.
  expect(await rejection(call(eng.c, 'reassign_work', { work: 'kj:orders-plan#W1', to: 'eng' }))).toMatch(/needs Maintain or Admin/);
  expect(await call(lead.c, 'reassign_work', { work: 'kj:orders-plan#W1', to: 'eng' })).toMatchObject({ state: 'in_progress', assignee: 'eng' });
  expect(await rejection(call(eng.c, 'set_work_lease', { minutes: 5 }))).toMatch(/needs Maintain or Admin/);
  expect(await call(lead.c, 'set_work_lease', { minutes: 5 })).toStrictEqual({ kolab: 'test', minutes: 5, was: 30 });
  expect(await rejection(call(lead.c, 'set_work_lease', { minutes: 0 }))).toMatch(/minutes is a whole number from 1 to 1440/);
});

test('a tool call renews the lease; a resource read, what a listen stream prompts, doesn\'t; a lapse reaches the assignee\'s answers (PLN15, D98)', async () => {
  const { kolab, eng } = await planned();
  await call(eng.c, 'pull_work', {});
  const left = async () => Number((await kolab.db.query<{ s: number }>(`select extract(epoch from lease_until - clock_timestamp()) as s from work_package where element_id = 'W1'`)).rows[0].s);
  const shorten = () => kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '5 minutes' where element_id = 'W1'`);
  await shorten();
  for (const uri of ['konjir://inbox/test/technical', 'konjir://answers/test/eng', 'konjir://instructions']) await eng.c.readResource({ uri });
  expect(await left()).toBeLessThan(301);
  // konjir_whoami is the listen clients' liveness check (the channel bridge's, every 30 s; konjir
  // watch's, on each reconnect): it renews nothing, so an idle agent with its channel open lapses.
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() + interval '20 seconds' where element_id = 'W1'`);
  for (let i = 0; i < 3; i++) await call(eng.c, 'whoami', {});
  expect(await left()).toBeLessThan(21);
  // Any other tool call renews it.
  await call(eng.c, 'list_nodes', {});
  expect(await left()).toBeGreaterThan(1790);
  // The answers show the package held, with its lease.
  const answers = async () => JSON.parse(((await eng.c.readResource({ uri: 'konjir://answers/test/eng' })).contents[0] as { text: string }).text) as {
    work: { holding: { work: string; lease_until: string } | null; events: { work: string; kind: string; actor: string; note: string }[] };
  };
  expect((await answers()).work).toMatchObject({ holding: { work: 'kj:orders-plan#W1', lease_until: expect.any(String) }, events: [] });
  // Lapsed: swept by Kolab; the answers say so.
  await kolab.db.query(`update work_package set lease_until = clock_timestamp() - interval '1 second' where element_id = 'W1'`);
  expect(await kolab.sweepLapsedLeases()).toBe(1);
  expect((await answers()).work).toMatchObject({ holding: null, events: [{ work: 'kj:orders-plan#W1', kind: 'lapsed', actor: 'kolab', note: expect.stringMatching(/eng's lease lapsed at/) }] });
});

test('in a shell: konjir pull_work, list_work and read_work print what MCP returns', async () => {
  const { server, eng } = await planned();
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = eng.token;
  await main(['pull_work']);
  await main(['list_work', 'mine=true']);
  await main(['read_work', 'work=kj:orders-plan#W1']);
  const [pulled, mine, read] = out.map((l) => JSON.parse(l));
  expect(pulled).toMatchObject({ pulled: true, work: 'kj:orders-plan#W1', trailer: 'Konjir-Work: kj:test/orders-plan#W1' });
  expect(mine).toMatchObject({ work: [{ id: 'W1', state: 'in_progress', assignee: 'eng' }], next: null });
  expect(read).toMatchObject({ work: 'kj:orders-plan#W1', events: [{ kind: 'added' }, { kind: 'pulled' }] });
});

test('over MCP: evidence, submitting, a work package\'s review beside a version\'s in the reviewer\'s list and inbox, the verdict in the assignee\'s answers, and reopening (W5.1c; PLN10, PLN16, VER17, D98)', async () => {
  const { eng, eng2 } = await planned();
  const W1 = 'kj:orders-plan#W1';
  await call(eng.c, 'pull_work', {});
  // The tool's schema refuses what evidence doesn't take, before Kolab sees it.
  expect(await rejection(call(eng.c, 'add_evidence', { work: W1, evidence: [{ kind: 'commit', sha: 'a'.repeat(40), branch: 'main' }] }))).toMatch(/branch/);
  expect(await call(eng.c, 'add_evidence', { work: W1, evidence: [{ kind: 'commit', sha: 'a'.repeat(40), title: 'Cancel orders', files: ['src/cancel.ts'] }] }))
    .toMatchObject({ work: W1, recorded: 1, already: 0, next: expect.stringMatching(/konjir_submit_work work=kj:orders-plan#W1/) });
  const submitted = await call(eng.c, 'submit_work', { work: W1, evidence: [{ kind: 'test_run', title: 'npm test: 3 passed' }], note: 'Done to its done-when.' }) as Record<string, unknown>;
  expect(submitted).toMatchObject({ work: W1, state: 'in_review', in_review: true, reviewers: ['eng2', 'lead'], unreviewed: false });
  expect(submitted.next).toMatch(/^In review: eng2, lead each have a review request/);
  // eng2's list and inbox hold it, naming its subject (VER17).
  const reviews = await call(eng2.c, 'list_reviews', {}) as { for_you: { subject: string; subject_kind: string; author: string; next: string }[] };
  expect(reviews.for_you.map((r) => [r.subject, r.subject_kind, r.author])).toStrictEqual([[W1, 'work', 'eng']]);
  expect(reviews.for_you[0].next).toMatch(/konjir_review work=kj:orders-plan#W1 verdict=approve/);
  const inbox = JSON.parse(((await eng2.c.readResource({ uri: 'konjir://inbox/test/technical' })).contents[0] as { text: string }).text) as { reviews: { subject: string }[] };
  expect(inbox.reviews.map((r) => r.subject)).toStrictEqual([W1]);
  // A version and a work package aren't reviewed in one call; findings are a version's.
  expect(await rejection(call(eng2.c, 'review', { work: W1, node: 'orders-pg', version: 1, verdict: 'approve' }))).toMatch(/not both/);
  expect(await rejection(call(eng2.c, 'review', { work: W1, verdict: 'approve', findings: [{ kind: 'layer_leak', elements: ['W1'], explanation: 'x' }] }))).toMatch(/findings are a version's/);
  expect(await rejection(call(eng2.c, 'review', { verdict: 'approve' }))).toMatch(/name what you review/);
  // The assignee can't review its own; eng2 asks for changes: back to eng, In progress.
  expect(await rejection(call(eng.c, 'review', { work: W1, verdict: 'approve' }))).toMatch(/eng is kj:orders-plan#W1's assignee/);
  expect(await call(eng2.c, 'review', { work: W1, verdict: 'request_changes', note: 'Refunds too.' }))
    .toMatchObject({ work: W1, verdict: 'request_changes', state: 'in_progress', assignee: 'eng', next: expect.stringMatching(/^Returned to eng, In progress/) });
  const answers = JSON.parse(((await eng.c.readResource({ uri: 'konjir://answers/test/eng' })).contents[0] as { text: string }).text) as {
    work: { holding: { work: string; returned?: boolean } | null; events: { work: string; kind: string; actor: string; note: string }[] };
  };
  expect(answers.work.holding).toMatchObject({ work: W1, returned: true });
  expect(answers.work.events[0]).toMatchObject({ work: W1, kind: 'changes_requested', actor: 'eng2', note: 'Refunds too.' });
  // Submitted again, approved: Done. Then reopened as new work: To do.
  await call(eng.c, 'submit_work', { work: W1 });
  expect(await call(eng2.c, 'review', { work: W1, verdict: 'approve' })).toMatchObject({ state: 'done', next: expect.stringMatching(/^Done/) });
  expect(await call(eng2.c, 'reopen_work', { work: W1, note: 'Refunds changed.' })).toMatchObject({ work: W1, state: 'todo', settled: [] });
  const read = await call(eng2.c, 'read_work', { work: W1 }) as { evidence: { kind: string }[]; reviews: { reviewer: string; state: string }[]; events: { kind: string }[] };
  expect(read.evidence.map((e) => e.kind)).toStrictEqual(['commit', 'test_run']);
  expect(read.events.map((e) => e.kind)).toStrictEqual(['added', 'pulled', 'evidence', 'submitted', 'changes_requested', 'submitted', 'approved', 'reopened']);
});

test('in a shell: konjir add_evidence and submit_work take evidence as JSON', async () => {
  const { server, eng } = await planned();
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = eng.token;
  await main(['pull_work']);
  await main(['add_evidence', 'work=kj:orders-plan#W1', `evidence=[{"kind":"commit","sha":"${'b'.repeat(40)}"}]`]);
  await main(['submit_work', 'work=kj:orders-plan#W1', 'evidence=[{"kind":"pull_request","url":"https://github.com/acme/orders/pull/1"}]']);
  const [, added, submitted] = out.map((l) => JSON.parse(l));
  expect(added).toMatchObject({ work: 'kj:orders-plan#W1', recorded: 1 });
  expect(submitted).toMatchObject({ work: 'kj:orders-plan#W1', state: 'in_review' });
});
