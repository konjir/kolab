// A session that holds only Read on its own kolab doesn't belong to its work (D49), so the questions
// that kolab's marks raised (a ruling that changes the intent, D51; a role boundary) stay private to
// those who do: on every path, as row-level security holds kj_agent to it (0022).
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer } from '@konjir/server';
import type { WebActivityView, WebNodeView, WebQuery } from '@konjir/types';
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

test('MCP: list_queries, read_node, the inbox and answers resources, list_cases and the instructions give a Read-only session no mark-raised question; one who belongs gets them all', async () => {
  const { server, erin, rita } = await world();

  // Erin belongs: she sees both mark-raised questions, answered and open.
  const all = (await call(erin.client, 'list_queries', { all_layers: true, state: 'answered' }) as { queries: Q[] }).queries;
  expect(all.map((q) => q.question)).toEqual(expect.arrayContaining(['A calendar day?', expect.stringMatching(/Carts last a week/)]));
  expect(marked((await call(erin.client, 'list_queries', {}) as { queries: Q[] }).queries)).toBe(1);
  expect(marked((await json<{ queries: Q[] }>(erin.client, 'konjir://inbox/shop/functional')).queries)).toBe(1);

  // Rita holds only Read: none of them, by any verb or resource.
  askedOnly((await call(rita.client, 'list_queries', { all_layers: true, state: 'answered' }) as { queries: Q[] }).queries);
  expect((await call(rita.client, 'list_queries', {}) as { queries: Q[] }).queries).toStrictEqual([]);
  expect((await call(rita.client, 'list_queries', { all_layers: true }) as { queries: Q[] }).queries).toStrictEqual([]);
  expect((await call(rita.client, 'list_queries', { mine: true }) as { queries: Q[] }).queries).toStrictEqual([]);
  const read = await call(rita.client, 'read_node', { node: 'spec' }) as { elements: { id: string; questions?: Q[] }[] };
  askedOnly(read.elements.flatMap((e) => e.questions ?? []));
  const v1 = await call(rita.client, 'read_node', { node: 'spec', version: 1 }) as { elements: { questions?: Q[] }[] };
  askedOnly(v1.elements.flatMap((e) => e.questions ?? []));
  const inbox = await json<{ queries: Q[]; marks: unknown[] }>(rita.client, 'konjir://inbox/shop/functional');
  expect(inbox.queries).toStrictEqual([]);
  expect((await json<{ queries: Q[] }>(rita.client, 'konjir://answers/shop/rita')).queries).toStrictEqual([]);
  expect((await call(rita.client, 'list_cases', { all_layers: true }) as { cases: unknown[] }).cases).toStrictEqual([]);
  const text = ((await rita.client.callTool({ name: 'konjir_instructions', arguments: {} })).content as { text: string }[])[0].text;
  expect(text).toMatch(/Answered questions and notes \(1\): kj:spec@1#R1: asked "A calendar day\?"/);
  expect(text).not.toMatch(/Carts last a week|Carts are private/);

  // Row-level security holds kj_agent to the same, whatever the query (0022).
  const rows = await server.kolab.readAs(rita.token, async (q) => (await q.query<{ question: string; invalidation_id: string | null }>(
    `select question, invalidation_id from query where kolab_id = 'shop' order by question`)).rows);
  expect(rows).toStrictEqual([{ question: 'A calendar day?', invalidation_id: null }]);
  const own = await server.kolab.readAs(erin.token, async (q) => (await q.query<{ n: number }>(
    `select count(*)::int as n from query where kolab_id = 'shop' and invalidation_id is not null`)).rows[0].n);
  expect(own).toBe(2);
});

test('the web API gives a Read-only person no mark-raised question: the queue, a node\'s threads, the activity', async () => {
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
});
