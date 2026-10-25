// Pagination and limits over MCP (W2.21, P13, D71): each list verb returns a page and next, and an
// agent pages through with cursor=next; read_node pages a large version's elements; the inbox
// names the lists it cut short; an oversized request or draft is refused with the limit named.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { MAX_ELEMENTS, MAX_REQUEST_BYTES, MAX_SMALL_REQUEST_BYTES, MAX_TEXT, PAGE_DEFAULT, READ_NODE_PAGE, THREADS_PER_ELEMENT } from '@konjir/types';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { cursorFor, scoped } from '@konjir/engine';
import type { Client } from '@modelcontextprotocol/client';

const ADMIN = 'test-admin-token';

async function kolab() {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const as = async (actor: string, role: 'product' | 'engineer', layers: string[]) => {
    await call(admin, 'admin_add_actor', { id: actor });
    await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write', layers });
    const { token } = (await call(admin, 'admin_open_session', { actor, role })) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return c;
  };
  return { server, admin, pm: await as('pm', 'product', ['functional']), dev: await as('dev', 'engineer', ['technical']), as };
}

/** Every item of a list verb's `key`, following next, and how many calls it took. */
async function pageAll(c: Client, verb: string, key: string, args: Record<string, unknown> = {}) {
  const items: unknown[] = [];
  let cursor: string | null = null;
  let calls = 0;
  do {
    const r = await call(c, verb, { ...args, ...(cursor ? { cursor } : {}) }) as Record<string, unknown> & { next: string | null };
    items.push(...(r[key] as unknown[]));
    cursor = r.next;
    calls++;
  } while (cursor);
  return { items, calls };
}

test('every list verb returns a page and next; following next reads the rest, and the last page says so', async () => {
  const { admin, pm, dev } = await kolab();
  await call(pm, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'Orders ship in a day.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  for (const name of ['a', 'b', 'c']) await call(pm, 'create_node', { kind: 'prototype', title: name, id: name });
  await call(dev, 'create_node', { kind: 'binding', title: 'Orders on Postgres', id: 'orders-pg' });
  await call(dev, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A flag.' }, { id: 'b2', text: 'A queue.' }, { id: 'b3', text: 'A job.' }],
    links: [{ source_element: 'b1', target: 'kj:orders@1#R1' }, { source_element: 'b2', target: 'kj:orders@1#R2' }, { source_element: 'b3', target: 'kj:orders@1#R1' }] });
  await call(dev, 'submit_for_review', { node: 'orders-pg', version: 1 });
  for (let i = 0; i < 5; i++) await call(dev, 'ask', { address: 'kj:orders#R1', question: `Question ${i}?` });

  // No cursor: the first page, and next.
  const first = await call(pm, 'list_queries', { limit: 2 }) as { queries: { question: string }[]; next: string | null };
  expect(first.queries.map((q) => q.question)).toStrictEqual(['Question 0?', 'Question 1?']);
  expect(first.next).toEqual(expect.any(String));
  const queries = await pageAll(pm, 'list_queries', 'queries', { limit: 2 });
  expect([queries.items.length, queries.calls]).toStrictEqual([5, 3]);
  // Without a limit, the whole list fits one page: next is null.
  expect(await call(pm, 'list_queries')).toMatchObject({ next: null });
  expect((await pageAll(dev, 'list_queries', 'queries', { mine: true, limit: 4 })).items).toHaveLength(5);

  expect((await pageAll(pm, 'list_nodes', 'nodes', { limit: 2 })).items).toHaveLength(5);
  expect((await pageAll(dev, 'lineage', 'edges', { node: 'orders-pg', direction: 'upstream', limit: 2 })).items).toHaveLength(3);
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled until they ship.' }, { id: 'R2', text: 'Orders ship in two days.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 2 });
  const marks = await pageAll(dev, 'list_stale', 'marks', { limit: 2 });
  expect([marks.items.length, marks.calls]).toStrictEqual([3, 2]);
  expect(await call(pm, 'list_rulings')).toStrictEqual({ rulings: [], next: null });
  expect(await call(pm, 'list_cases')).toStrictEqual({ cases: [], next: null });
  expect((await pageAll(admin, 'admin_list_actors', 'actors', { limit: 1 })).items).toHaveLength(2);
  expect(await call(admin, 'admin_list_kolabs', { limit: 5 })).toMatchObject({ kolabs: [{ id: 'test' }], next: null });
  expect(await call(admin, 'admin_outbox')).toMatchObject({ next: null });

  // A cursor from another list is refused, saying what to do.
  await expect(call(pm, 'list_nodes', { cursor: first.next })).rejects.toThrow(/LimitError: invalid cursor: that isn't one this list gave. Pass the next it returned, unchanged.*Nothing was written/);
});

test('list_reviews pages both its lists with one cursor', async () => {
  const { pm, as } = await kolab();
  const dana = await as('dana', 'product', ['functional']);
  for (const name of ['a', 'b', 'c']) {
    await call(pm, 'create_node', { kind: 'prototype', title: name, id: name });
    await call(pm, 'draft', { node: name, elements: [{ id: 'R1', text: `${name} holds.` }] });
    await call(pm, 'submit_for_review', { node: name, version: 1 });
  }
  const forYou = await pageAll(dana, 'list_reviews', 'for_you', { limit: 2 });
  expect([forYou.items.length, forYou.calls]).toStrictEqual([3, 2]);
  const yours = await pageAll(pm, 'list_reviews', 'yours', { limit: 2 });
  expect((yours.items as { subject: string }[]).map((s) => s.subject)).toStrictEqual(['kj:c@1', 'kj:b@1', 'kj:a@1']);
  // A list that has shown its last page returns nothing more while the other goes on.
  const page = await call(pm, 'list_reviews', { limit: 2 }) as { for_you: unknown[]; yours: unknown[]; next: string };
  expect(page.for_you).toStrictEqual([]);
  expect(await call(pm, 'list_reviews', { limit: 2, cursor: page.next })).toMatchObject({ for_you: [], yours: [{ subject: 'kj:a@1' }], next: null });
});

test('read_node pages a large version\'s elements; the inbox names a list it cut short', async () => {
  const { pm, dev } = await kolab();
  const n = READ_NODE_PAGE + 10;
  await call(pm, 'create_node', { kind: 'spec', title: 'Big', id: 'big' });
  await call(pm, 'draft', { node: 'big', elements: Array.from({ length: n }, (_, i) => ({ id: `R${i}`, text: `Requirement ${i} holds.` })) });
  await call(pm, 'submit_for_review', { node: 'big', version: 1 });
  const first = await call(pm, 'read_node', { node: 'big' }) as { elements: { id: string }[]; element_count: number; elements_from: number; elements_to: number; next: string };
  expect([first.elements.length, first.element_count, first.elements_from, first.elements_to]).toStrictEqual([READ_NODE_PAGE, n, 1, READ_NODE_PAGE]);
  const rest = await call(pm, 'read_node', { node: 'big', cursor: first.next }) as { elements: { id: string }[]; next: string | null };
  expect(rest.elements.map((e) => e.id)).toStrictEqual(Array.from({ length: 10 }, (_, i) => `R${READ_NODE_PAGE + i}`));
  expect(rest.next).toBeNull();
  // A small version is one page.
  await call(pm, 'create_node', { kind: 'prototype', title: 'Small', id: 'small' });
  await call(pm, 'draft', { node: 'small', elements: [{ id: 'R1', text: 'One.' }] });
  await call(pm, 'submit_for_review', { node: 'small', version: 1 });
  expect(await call(pm, 'read_node', { node: 'small' })).toMatchObject({ element_count: 1, next: null });

  for (let i = 0; i < PAGE_DEFAULT + 1; i++) await call(dev, 'ask', { address: `kj:big#R${i}`, question: `Question ${i}?` });
  const inbox = JSON.parse(((await pm.readResource({ uri: 'konjir://inbox/test/functional' })).contents[0] as { text: string }).text) as { queries: unknown[]; more?: Record<string, string> };
  expect(inbox.queries).toHaveLength(PAGE_DEFAULT);
  expect(inbox.more?.queries).toMatch(/^konjir_list_queries cursor=/);
});

test('a draft over the limits, an over-long question, and a body over the request limit are refused, naming the limit', async () => {
  const { server, pm, dev } = await kolab();
  await call(pm, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await expect(call(pm, 'draft', { node: 'orders', elements: Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => ({ id: `R${i}`, text: 'x' })) }))
    .rejects.toThrow(/LimitError: that draft sends 1,001 elements; a version holds at most 1,000 elements.*Nothing was written/);
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  await expect(call(dev, 'ask', { address: 'kj:orders#R1', question: 'x'.repeat(MAX_TEXT + 1) })).rejects.toThrow(/the question is 4,001 characters; the limit is 4,000/);

  // A version near the limit fits a request: about 500 KiB of text.
  const big = Array.from({ length: 60 }, (_, i) => ({ id: `R${i}`, text: `${i} ${'y'.repeat(7990)}` }));
  await expect(call(pm, 'draft', { node: 'orders', elements: big })).resolves.toMatchObject({ version: 2 });
  // A body over MAX_REQUEST_BYTES never reaches Kolab: a 413 that says why, on /mcp and on the web API.
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'konjir_ask', arguments: { question: 'z'.repeat(MAX_REQUEST_BYTES) } } });
  const res = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ADMIN}` }, body: huge });
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { message: expect.stringMatching(/the request is over 2 MiB, the most Kolab takes in one call/) } });

  // Read_node shows each element's newest questions and counts the rest.
  for (let i = 0; i < THREADS_PER_ELEMENT + 2; i++) await call(dev, 'ask', { address: 'kj:orders#R1', question: `Question ${i}?` });
  const read = await call(pm, 'read_node', { node: 'orders' }) as { elements: { id: string; questions?: { question: string }[]; more_questions?: number }[] };
  const r1 = read.elements.find((e) => e.id === 'R1')!;
  expect([r1.questions!.length, r1.questions!.at(-1)!.question, r1.more_questions]).toStrictEqual([THREADS_PER_ELEMENT, `Question ${THREADS_PER_ELEMENT + 1}?`, 2]);
  // An actor over its rate is refused, saying the limit and how long to wait; nothing is written.
  Object.assign(server.kolab.rates, { asks: THREADS_PER_ELEMENT + 2 });
  await expect(call(dev, 'ask', { address: 'kj:orders#R1', question: 'One more?' }))
    .rejects.toThrow(new RegExp(`LimitError: dev and dev.s agents raised ${THREADS_PER_ELEMENT + 2} questions and notes in the last hour; the limit is ${THREADS_PER_ELEMENT + 2} in an hour, shared by a person and their agents\\. Wait 60 minutes.*Nothing was written`));
  const web = await fetch(new URL('/api/queries', server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: huge });
  expect(web.status).toBe(413);
  expect(await web.json()).toMatchObject({ error: 'too_large' });
  // Anywhere else, the OAuth routes among them, a body keeps the small limit: a stranger can't make Kolab parse 2 MiB.
  const oauth = await fetch(new URL('/oauth/register', server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x'.repeat(MAX_SMALL_REQUEST_BYTES) }) });
  expect(oauth.status).toBe(413);
  expect(await oauth.json()).toMatchObject({ error: 'too_large', message: expect.stringMatching(/over 100 KiB/) });
  // Signing in and invites, before any session, keep the small limit too; and /mcp does unless the
  // token verifies, which is checked before the body is read.
  const medium = JSON.stringify({ token: 'x'.repeat(MAX_SMALL_REQUEST_BYTES + 1) });
  for (const path of ['/api/session', '/api/session/invite', '/API/Session']) {
    const r = await fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: medium });
    expect([path, r.status, await r.json()]).toMatchObject([path, 413, { error: 'too_large', message: expect.stringMatching(/over 100 KiB/) }]);
  }
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const authorization of [undefined, 'Bearer not-a-token']) {
    const r = await fetch(server.url, { method: 'POST', headers: { ...mcpHeaders, ...(authorization ? { authorization } : {}) }, body: huge });
    expect([r.status, await r.json()]).toMatchObject([413, { jsonrpc: '2.0', error: { message: expect.stringMatching(/over 100 KiB, the most Kolab takes here from a caller that hasn't signed in/) } }]);
  }
  // A small body without a token still gets the transport's 401, which leads a client to sign in.
  expect((await fetch(server.url, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status).toBe(401);
  // Express mounts paths whatever their case, and the message names the limit the parser applied.
  const upper = await fetch(new URL('/API/queries', server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: huge });
  expect([upper.status, await upper.json()]).toMatchObject([413, { error: 'too_large', message: expect.stringMatching(/over 2 MiB/) }]);
  const upperMcp = await fetch(new URL('/MCP', server.url), { method: 'POST', headers: { ...mcpHeaders, authorization: `Bearer ${ADMIN}` }, body: huge });
  expect([upperMcp.status, await upperMcp.json()]).toMatchObject([413, { jsonrpc: '2.0', error: { message: expect.stringMatching(/over 2 MiB/) } }]);
  // A cursor whose key isn't the shape its list's is: an MCP error that says so, not the database's words.
  await expect(call(dev, 'list_stale', { cursor: cursorFor(scoped('marks', { layer: 'technical', kolab: 'test' }), ['not a time', 'x']) }))
    .rejects.toThrow(/LimitError: invalid cursor: that isn't one this list gave/);
});
