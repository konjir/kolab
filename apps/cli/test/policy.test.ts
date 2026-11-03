// A kolab's autonomy policy over MCP and in a shell (W6.2; POL2, AUT2, AUT4): a kolab's Admin reads
// and changes it with konjir_read_policy and konjir_set_policy, from their own session, never an
// agent's; the change takes effect at once, recorded as theirs; konjir_answer_query takes cites.
import { afterEach, expect, jest, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { call, connect, main } from '../src/cli.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';
const env = { ...process.env };
afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; });

/** The test kolab: Ada, a person with Admin; her agent ada-pm, which writes the spec, and ada-pm-2; Bob, a person with Write on the technical layer. */
async function adasKolab() {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const actor = async (id: string, role: 'product' | 'engineer', grant: Record<string, unknown>, owner?: string) => {
    await call(admin, 'admin_add_actor', { id, ...(owner ? { owner } : {}) });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, ...grant });
    const { token } = (await call(admin, 'admin_open_session', { actor: id, role })) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token };
  };
  const ada = await actor('ada', 'product', { level: 'admin' });
  const pm = await actor('ada-pm', 'product', { level: 'write', layers: ['functional'] }, 'ada');
  const pm2 = await actor('ada-pm-2', 'product', { level: 'write', layers: ['functional'] }, 'ada');
  const bob = await actor('bob', 'engineer', { level: 'write', layers: ['technical'] });
  return { kolab, server, ada, pm, pm2, bob };
}

test('over MCP: an Admin reads and sets the policy, at once and audited as theirs; an agent and a non-Admin are refused; the review it governs follows (POL2, AUT2)', async () => {
  const { kolab, ada, pm, pm2, bob } = await adasKolab();
  expect(await call(ada.c, 'read_policy', {})).toMatchObject({ kolab: 'test', policy: { approve_functional: 'person', approve_technical: 'agent', jobs_per_person: 4, jobs_per_kolab: 8 }, changed_from_default: [] });
  expect(await rejection(call(pm.c, 'read_policy', {}))).toMatch(/ada-pm is an agent, and a kolab's policy is read and changed only from a person's own session/);
  expect(await rejection(call(pm.c, 'set_policy', { approve_functional: 'agent' }))).toMatch(/ada-pm is an agent/);
  expect(await rejection(call(bob.c, 'set_policy', { approve_functional: 'agent' }))).toMatch(/by those with Admin there \(POL2\); bob holds Write on the technical layer/);
  expect(await rejection(call(ada.c, 'set_policy', { approve_functional: 'nobody' }))).toMatch(/approve_functional/);

  // Ada's agent's spec waits for Ada: a person approves functional versions; the other agent is refused.
  await call(pm.c, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  expect(await call(pm.c, 'submit_for_review', { node: 'orders', version: 1 })).toMatchObject({ in_review: 'kj:orders@1', reviewers: ['ada'] });
  expect(await rejection(call(pm2.c, 'review', { node: 'orders', version: 1, verdict: 'approve' }))).toMatch(/policy keeps reviewing functional versions for a person/);
  // Ada lets agents approve them: at once, ada-pm-2 is asked, and its approval commits it.
  expect(await call(ada.c, 'set_policy', { approve_functional: 'agent' })).toMatchObject({
    policy: { approve_functional: 'agent' }, updated_by: 'ada', changes: [{ setting: 'approve_functional', was: 'person', now: 'agent' }], requests: { added: 1, withdrawn: 0 },
  });
  expect(await call(pm2.c, 'review', { node: 'orders', version: 1, verdict: 'approve' })).toMatchObject({ ok: true, committed: 'kj:orders@1' });
  expect((await kolab.auditLog({ kolab: 'test' })).filter((e) => e.action === 'policy.set')).toMatchObject([{ by: 'ada', subject: 'test' }]);
});

test('konjir_answer_query takes cites: an agent\'s uncited answer on the functional layer is refused; a cited one stands, with its cites (AUT4)', async () => {
  const { ada, pm, bob } = await adasKolab();
  await call(ada.c, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(ada.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'A shipped order is never cancelled.' }] });
  await call(ada.c, 'submit_for_review', { node: 'orders', version: 1 });
  const { query: question } = (await call(bob.c, 'ask', { address: 'kj:orders#R1', question: 'Once shipped too?' })) as { query: string };
  expect(await rejection(call(pm.c, 'answer_query', { query: question, answer: 'No.' }))).toMatch(/an agent answers a question on the functional layer only by citing committed elements or precedent \(AUT4\)/);
  // The element asked about is no source of its own answer.
  expect(await rejection(call(pm.c, 'answer_query', { query: question, answer: 'No.', cites: ['kj:orders#R1'] }))).toMatch(/the element the question asks about is not its own source/);
  expect(await call(pm.c, 'answer_query', { query: question, answer: 'No.', cites: ['kj:orders#R2'] })).toStrictEqual({ answered: question, cites: ['kj:orders#R2'] });
  expect(await call(bob.c, 'list_queries', { mine: true })).toMatchObject({ queries: [{ id: question, state: 'answered', cites: ['kj:orders@1#R2'] }] });
});

test('in a shell: konjir set_policy and read_policy, as the Admin signed in', async () => {
  const { server, ada } = await adasKolab();
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = ada.token;
  await main(['set_policy', 'approve_technical=person', 'jobs_per_person=2', 'product_review_of_bindings=true']);
  await main(['read_policy']);
  const [set, read] = out.map((l) => JSON.parse(l));
  expect(set).toMatchObject({ updated_by: 'ada', changes: [
    { setting: 'approve_technical', was: 'agent', now: 'person' }, { setting: 'product_review_of_bindings', was: false, now: true }, { setting: 'jobs_per_person', was: 4, now: 2 },
  ] });
  expect(read).toMatchObject({ policy: { approve_technical: 'person', product_review_of_bindings: true, jobs_per_person: 2 }, changed_from_default: ['approve_technical', 'product_review_of_bindings', 'jobs_per_person'] });
});
