// A session that holds only Read on its own kolab doesn't belong to its work (D49), so that kolab's
// marks (whose notes can quote a ruling or the review gate's finding) and the questions they raised
// (a ruling that changes the intent, D51; a role boundary) stay private to those who do: on every
// path, as row-level security holds kj_agent to it (0022).
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer } from '@konjir/server';
import type { WebActivityView, WebMark, WebNodeView, WebOverview, WebQuery } from '@konjir/types';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, testStore } from '@konjir/engine/testing';

const ADMIN = 'read-only-test-admin';

type Q = { question: string; mark: string | null; state: string };
const json = async <T>(c: Client, uri: string) => JSON.parse(((await c.readResource({ uri })).contents[0] as { text: string }).text) as T;

async function world() {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  const session = async (actor: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product', kolab: 'shop' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return { client, token };
  };
  for (const id of ['erin', 'rita']) await call(admin, 'admin_add_actor', { id });
  await call(admin, 'admin_add_kolab', { name: 'shop', owner: 'erin' });
  await call(admin, 'admin_grant', { kolab: 'shop', to: 'rita', level: 'read' });
  const erin = await session('erin');
  const c = erin.client;
  await call(c, 'create_node', { kind: 'functional_spec', title: 'Spec', id: 'spec' });
  await call(c, 'draft', { node: 'spec', elements: [{ id: 'R1', text: 'Carts last a day.' }, { id: 'R2', text: 'Carts are shared.' }] });
  await call(c, 'submit_for_review', { node: 'spec', version: 1 });
  // A question a person asked, answered; and two a ruling's mark raised: one settled by amending
  // its element (answered), one still open.
  const { query } = await call(c, 'ask', { address: 'kj:spec#R1', question: 'A calendar day?' }) as { query: string };
  await call(c, 'answer_query', { query, answer: 'Twenty-four hours.' });
  await call(c, 'rule', { address: 'kj:spec#R1', text: 'Carts last a week.', effect: 'change_intent' });
  await call(c, 'draft', { node: 'spec', elements: [{ id: 'R1', text: 'Carts last a week.' }, { id: 'R2', text: 'Carts are shared.' }] });
  await call(c, 'submit_for_review', { node: 'spec', version: 2 });
  await call(c, 'rule', { address: 'kj:spec#R2', text: 'Carts are private.', effect: 'change_intent' });
  const rita = await session('rita');
  return { server, erin, rita };
}

const marked = (qs: { mark: string | null }[]) => qs.filter((q) => q.mark !== null).length;
const askedOnly = (qs: Q[]) => expect(qs.map((q) => [q.question, q.mark ?? null])).toStrictEqual([['A calendar day?', null]]);

test('MCP: list_stale, list_queries, read_node, the inbox and answers resources, list_cases and the instructions give a Read-only session no mark and no mark-raised question; one who belongs gets them all', async () => {
  const { server, erin, rita } = await world();

  // Erin belongs: she sees both mark-raised questions, answered and open.
  const all = (await call(erin.client, 'list_queries', { all_layers: true, state: 'answered' }) as { queries: Q[] }).queries;
  expect(all.map((q) => q.question)).toEqual(expect.arrayContaining(['A calendar day?', expect.stringMatching(/Carts last a week/)]));
  expect(marked((await call(erin.client, 'list_queries', {}) as { queries: Q[] }).queries)).toBe(1);
  expect(marked((await json<{ queries: Q[] }>(erin.client, 'konjir://inbox/shop/functional')).queries)).toBe(1);

  // …and both ruled marks, whose notes quote the rulings: by list_stale, the inbox and the commit's stale_after_commit.
  const erinStale = (await call(erin.client, 'list_stale', { all_layers: true }) as { marks: { reason: string; because: string }[] }).marks;
  expect(erinStale.map((m) => [m.reason, m.because])).toStrictEqual([['ruled', expect.stringMatching(/"Carts are private\."/)]]);
  expect((await json<{ marks: unknown[] }>(erin.client, 'konjir://inbox/shop/functional')).marks.length).toBe(1);

  // Rita holds only Read: none of them, by any verb or resource. Everything she is given is
  // collected, and none of it quotes a ruling.
  const seen: unknown[] = [];
  const keep = <T>(x: T) => { seen.push(x); return x; };
  expect(keep(await call(rita.client, 'list_stale', { all_layers: true }))).toStrictEqual({ marks: [], next: null });
  expect(keep(await call(rita.client, 'list_stale', {}))).toStrictEqual({ marks: [], next: null });
  const inboxes = [keep(await json<{ queries: Q[]; marks: unknown[] }>(rita.client, 'konjir://inbox/shop/functional')),
    keep(await json<{ queries: Q[]; marks: unknown[] }>(rita.client, 'konjir://inbox/shop/technical'))];
  expect(inboxes.map((i) => [i.queries, i.marks])).toStrictEqual([[[], []], [[], []]]);
  keep(await json(rita.client, 'konjir://answers/shop/rita'));
  keep(await call(rita.client, 'list_rulings', {}));
  keep(await call(rita.client, 'list_nodes', {}));
  keep(await call(rita.client, 'lineage', { node: 'spec', direction: 'downstream' }));
  // Answering is refused for want of Write before anything about the question is told.
  const q = (await call(erin.client, 'list_queries', {}) as { queries: { id: string }[] }).queries[0].id;
  const refused = await call(rita.client, 'answer_query', { query: q, answer: 'no' }).then(() => 'answered', (e: unknown) => String(e));
  expect(refused).toMatch(/AccessError: rita may not write the functional layer/);
  expect(refused).not.toMatch(/ruling|already answered|dirty mark/);
  expect(await call(rita.client, 'answer_query', { query: 'nope', answer: 'no' }).then(() => 'answered', (e: unknown) => String(e))).toMatch(/no query nope/);

  askedOnly(keep(await call(rita.client, 'list_queries', { all_layers: true, state: 'answered' }) as { queries: Q[] }).queries);
  expect(keep(await call(rita.client, 'list_queries', {}))).toStrictEqual({ queries: [], next: null });
  expect(keep(await call(rita.client, 'list_queries', { all_layers: true }))).toStrictEqual({ queries: [], next: null });
  expect(keep(await call(rita.client, 'list_queries', { mine: true }))).toStrictEqual({ queries: [], next: null });
  const read = keep(await call(rita.client, 'read_node', { node: 'spec' }) as { elements: { id: string; questions?: Q[] }[] });
  askedOnly(read.elements.flatMap((e) => e.questions ?? []));
  const v1 = keep(await call(rita.client, 'read_node', { node: 'spec', version: 1 }) as { elements: { questions?: Q[] }[] });
  askedOnly(v1.elements.flatMap((e) => e.questions ?? []));
  expect((await json<{ queries: Q[] }>(rita.client, 'konjir://answers/shop/rita')).queries).toStrictEqual([]);
  expect(keep(await call(rita.client, 'list_cases', { all_layers: true }))).toStrictEqual({ cases: [], next: null });
  const text = ((await rita.client.callTool({ name: 'konjir_instructions', arguments: {} })).content as { text: string }[])[0].text;
  expect(text).not.toMatch(/Carts last a week|Carts are private/);
  expect(text).toMatch(/Answered questions and notes \(1\): kj:spec@1#R1: asked "A calendar day\?"/);
  // (R1's committed text is now "Carts last a week.", which a reader reads; R2's ruling is unsettled.)
  expect(JSON.stringify(seen)).not.toMatch(/Carts are private|ruling [0-9A-Z]{26}/);

  // Row-level security holds kj_agent to the same, whatever the query (0022): no mark-raised
  // question, no mark and no mark's cause for Rita; all of them for Erin.
  const count = (token: string, sql: string) => server.kolab.readAs(token, async (q) => (await q.query<{ n: number }>(sql)).rows[0].n);
  const rows = await server.kolab.readAs(rita.token, async (q) => (await q.query<{ question: string; invalidation_id: string | null }>(
    `select question, invalidation_id from query where kolab_id = 'shop' order by question`)).rows);
  expect(rows).toStrictEqual([{ question: 'A calendar day?', invalidation_id: null }]);
  for (const sql of ['select count(*)::int as n from invalidation', 'select count(*)::int as n from invalidation_cause']) {
    expect(await count(rita.token, sql)).toBe(0);
  }
  expect(await count(erin.token, `select count(*)::int as n from query where kolab_id = 'shop' and invalidation_id is not null`)).toBe(2);
  expect(await count(erin.token, 'select count(*)::int as n from invalidation')).toBe(2);
});

test('the web API gives a Read-only person no mark and no mark-raised question: the queue, a node\'s threads, the marks, the overview and the activity', async () => {
  const { server, erin, rita } = await world();
  const base = new URL(server.url).origin;
  const signIn = async (token: string) => {
    const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
    expect(res.status).toBe(200);
    const jar = res.headers.getSetCookie()[0].split(';')[0];
    return async <T>(path: string) => {
      const r = await fetch(`${base}/api/${path}`, { headers: { cookie: jar, origin: base } });
      expect(r.status).toBe(200);
      return await r.json() as T;
    };
  };
  const asErin = await signIn(erin.token);
  const asRita = await signIn(rita.token);

  expect(marked((await asErin<{ queries: WebQuery[] }>('queries')).queries)).toBe(2);
  const ritas = (await asRita<{ queries: WebQuery[] }>('queries')).queries;
  expect(ritas.map((q) => [q.question, q.mark])).toStrictEqual([['A calendar day?', null]]);

  const threads = (n: WebNodeView) => n.elements.flatMap((e) => e.queries);
  expect(marked(threads(await asErin<WebNodeView>('nodes/spec')))).toBe(2);
  expect(threads(await asRita<WebNodeView>('nodes/spec')).map((q) => [q.question, q.mark])).toStrictEqual([['A calendar day?', null]]);

  // A question a mark raised shows in the activity as Kolab asking.
  const markAsked = (a: WebActivityView) => a.items.filter((i) => i.actor === 'kolab' && i.text.startsWith('asked about')).length;
  expect(markAsked(await asErin<WebActivityView>('activity'))).toBe(2);
  expect(markAsked(await asRita<WebActivityView>('activity'))).toBe(0);
  expect((await asRita<WebActivityView>('activity')).items.map((i) => `${i.actor} ${i.text}`)).toContain('erin asked about kj:spec@1#R1');

  // Marks: the open ruled mark, in the words list_stale uses, and the count of the layer's marks;
  // the activity's mark rows. Erin has them all; Rita none.
  const erinMarks = (await asErin<{ marks: WebMark[] }>('marks')).marks;
  expect(erinMarks.map((m) => [m.reason, m.because])).toStrictEqual([['ruled', expect.stringMatching(/^ruling \S+ changes the intent of kj:spec#R2: "Carts are private\."$/)]]);
  expect((await asErin<WebOverview>('overview')).counts.stale).toBe(1);
  const markRows = (a: WebActivityView) => a.items.filter((i) => i.actor === 'kolab' && i.text.startsWith('marked ')).map((i) => i.text);
  expect(markRows(await asErin<WebActivityView>('activity'))).toStrictEqual(['marked kj:spec@2#R2 ruled', 'marked kj:spec@2#R1 ruled']);
  expect((await asRita<{ marks: WebMark[] }>('marks')).marks).toStrictEqual([]);
  expect((await asRita<WebOverview>('overview')).counts.stale).toBe(0);
  expect(markRows(await asRita<WebActivityView>('activity'))).toStrictEqual([]);
  const ritaSees = JSON.stringify(await Promise.all(['marks', 'overview', 'activity', 'queries', 'nodes/spec', 'cases', 'rulings', 'reviews', 'lineage'].map((p) => asRita(p))));
  expect(ritaSees).not.toMatch(/Carts are private|ruling [0-9A-Z]{26}/);
});
