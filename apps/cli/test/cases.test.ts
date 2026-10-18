// Over MCP (W2.14; CASE1–CASE7): an engineer agent raises a case file against the spec, a
// product agent takes the other side, only the person rules, and the ruling comes back to the
// parties' answers and to every agent of the kolab as precedent.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import type { CaseFileView, RulingView } from '@konjir/types';
import { call, connect, watch } from '../src/cli.js';
import { closeAtEnd, rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

test('over MCP, a case file is opened, argued and ruled; the ruling reaches the parties and is served as precedent', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const session = async (actor: string, role: 'product' | 'engineer', owner?: string) => {
    await call(admin, 'admin_add_actor', { id: actor, owner });
    await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write', layers: [role === 'product' ? 'functional' : 'technical'] });
    const { token } = await call(admin, 'admin_open_session', { actor, role }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  // Lee, a person, owns the spec; an engineer the binding. Each is alone on a layer, so commits need no review.
  const lee = await session('lee', 'product');
  const eng = await session('lee-eng', 'engineer');
  await call(lee, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  await call(lee, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes within 2 seconds of payment confirming.' }] });
  await call(lee, 'submit_for_review', { node: 'checkout', version: 1 });
  await call(eng, 'create_node', { kind: 'technical_binding', title: 'Checkout on Postgres', id: 'checkout-pg' });
  await call(eng, 'draft', { node: 'checkout-pg', elements: [{ id: 'b1', text: 'The provider confirms in 3 to 5 seconds.' }] });
  await call(eng, 'submit_for_review', { node: 'checkout-pg', version: 1 });
  const pm = await session('lee-pm', 'product', 'lee');
  const dana = await session('dana', 'product');   // no party: Lee's own agent argues, so Lee can't rule on it (D51)

  const pushed: { uri: string; body: { cases?: CaseFileView[] } }[] = [];
  const w = await watch(eng, (uri, body) => { pushed.push({ uri, body: body as never }); });
  closeAtEnd(w.subscription);

  // CASE5: the engineer agent raises it against the spec, with evidence; it waits in the functional inbox.
  const opened = await call(eng, 'open_case', {
    address: 'kj:checkout#R1', question: 'Can checkout finish in 2 seconds when the provider takes 3 to 5?',
    claim: 'R1 cannot be met as written.', seeks: 'change_intent', evidence: ['kj:checkout-pg#b1', 'provider SLA 4.2'],
  }) as CaseFileView;
  expect(opened).toMatchObject({ on: 'kj:checkout@1#R1', layer: 'functional', state: 'open', opened_by: 'lee-eng', positions: [{ actor: 'lee-eng' }] });
  const inbox = JSON.parse(((await pm.readResource({ uri: 'konjir://inbox/test/functional' })).contents[0] as { text: string }).text) as { cases: CaseFileView[] };
  expect(inbox.cases.map((c) => c.case)).toStrictEqual([opened.case]);
  expect((await call(pm, 'list_cases', {}) as { cases: CaseFileView[] }).cases.map((c) => c.case)).toStrictEqual([opened.case]);
  expect((await call(eng, 'list_cases', {}) as { cases: CaseFileView[] }).cases).toStrictEqual([]);   // not on its layer
  expect((await call(eng, 'list_cases', { mine: true }) as { cases: CaseFileView[] }).cases.map((c) => c.case)).toStrictEqual([opened.case]);

  // The product agent takes the other side.
  const argued = await call(pm, 'add_position', { case: opened.case, claim: 'R1 stands: confirm at once and reconcile.', evidence: ['kj:checkout#R1'] }) as CaseFileView & { position: string };
  expect(argued.positions.map((p) => p.actor)).toStrictEqual(['lee-eng', 'lee-pm']);
  const verdicts = Object.fromEntries(argued.positions.map((p) => [p.position, p.actor === 'lee-pm' ? 'sustained' : 'overruled']));

  // Only a person rules: the agent is refused, with why.
  expect(await rejection(call(pm, 'rule', { case: opened.case, text: 'R1 stands.', effect: 'keep_intent', verdicts }))).toMatch(/only a person rules \(CASE2\): lee-pm is an agent of lee/);
  expect(await rejection(call(lee, 'rule', { case: opened.case, text: 'R1 stands.', verdicts }))).toMatch(/lee is a party to case file .*: its agent lee-pm holds a position on it/);
  pushed.length = 0;
  const ruling = await call(dana, 'rule', {
    case: opened.case, text: 'R1 stands: show the order as confirmed at once, and reconcile when the provider answers.', verdicts,
  }) as RulingView & { next: string };
  expect(ruling).toMatchObject({ on: 'kj:checkout@1#R1', case: opened.case, effect: 'keep_intent', ruled_by: 'dana', next: expect.stringMatching(/finds another way/) });
  expect(ruling.ruled_at).toMatch(/^\d{4}-\d\d-\d\dT/);

  // The engineer's answers carry the ruling, pushed (an earlier push, of the second position, may still arrive first).
  const ruledPush = () => pushed.find((p) => p.uri === 'konjir://answers/test/lee-eng' && p.body.cases?.[0]?.state === 'ruled');
  for (let i = 0; i < 500 && !ruledPush(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ruledPush()!.body.cases!.map((c) => [c.case, c.state, c.ruling?.ruling])).toStrictEqual([[opened.case, 'ruled', ruling.ruling]]);
  expect((await call(eng, 'read_case', { case: opened.case }) as CaseFileView).positions.map((p) => [p.actor, p.verdict])).toStrictEqual([['lee-eng', 'overruled'], ['lee-pm', 'sustained']]);

  // CASE4: precedent, served back to every agent of the kolab: in the operating instructions, beside the element, and listed.
  const prompt = await eng.getPrompt({ name: 'konjir_operating_instructions' });
  const text = (prompt.messages[0].content as { text: string }).text;
  expect(text).toMatch(/Rulings, newest first \(1\): kj:checkout@1#R1: "R1 stands: show the order as confirmed at once, and reconcile when the provider answers." \(keeps the intent; ruled by dana on \d{4}-\d\d-\d\d\)/);
  const read = await call(eng, 'read_node', { node: 'checkout' }) as { elements: { id: string; rulings?: RulingView[] }[] };
  expect(read.elements[0].rulings!.map((r) => r.ruling)).toStrictEqual([ruling.ruling]);
  // A direct ruling, with no case file behind it (CASE3).
  await call(lee, 'rule', { address: 'kj:checkout-pg#b1', text: 'Not mine to rule.', effect: 'keep_intent' }).then(
    () => { throw new Error('a product session ruled on the technical layer'); }, (e) => expect(String(e)).toMatch(/RoleError/));
  const direct = await call(lee, 'rule', { address: 'kj:checkout', text: 'The spec states intent only.', effect: 'keep_intent', replaces: 'nothing' }) as RulingView;
  expect(direct).toMatchObject({ on: 'kj:checkout@1', case: null });
  expect((await call(pm, 'list_rulings', { node: 'checkout' }) as { rulings: RulingView[] }).rulings.map((r) => r.ruling)).toStrictEqual([direct.ruling, ruling.ruling]);
}, 120_000);
