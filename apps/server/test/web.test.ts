// The web interface's API and event stream (W3.1, API8): a person signs in with a session token,
// reads a spec with its questions and marks beside each element, answers, asks, settles marks,
// submits and reviews, all through the same engine calls as the agents' verbs, inside their kolab.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, els, people, setup } from '@konjir/engine/testing';
import type {
  WebActivityView, WebCase, WebCasesView, WebEvent, WebForeignKolab, WebMark, WebNodeView, WebOutcome, WebOverview, WebQuery, WebRuling,
} from '@konjir/types';
import { startServer } from '../src/server.js';
import { nobodyCanReview } from '@konjir/types';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

async function serve(kolab: Kolab, opts: { webRoot?: string | null } = {}) {
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: opts.webRoot ?? null, webVersionsPollMs: 100 });
  closeAtEnd(server);
  return new URL(server.url).origin;
}

/** A page of Kolab's signed in as `token`: calls the API as the browser would, with its cookie and origin. */
async function signIn(base: string, token: string) {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie()[0];
  expect(cookie).toMatch(/^konjir_session=.+; Path=\/api; HttpOnly; SameSite=Strict$/);   // a session cookie: no Max-Age
  const jar = cookie.split(';')[0];
  const call = async <T = unknown>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(`${base}/api/${path}`, {
      method, headers: { cookie: jar, origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  return { me: await res.json(), call, jar };
}

/** Alice's spec and Bob's binding, linked element by element, with a question on R1. */
async function specAndBinding() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Office staff can cancel an order.', R2: 'A cancelled order is refunded in full.' }) });
  await kolab.createNode(engineer, 'technical_binding', 'Orders on Postgres', 'orders-pg');
  await kolab.commit(engineer, 'orders-pg', { elements: els({ b1: 'orders.status allows cancel from Open.', b2: 'Refunds go through the payments queue.' }) });
  for (const [b, r] of [['b1', 'R1'], ['b2', 'R2']]) {
    const v = await kolab.latestCommitted('orders-pg');
    await kolab.link(engineer, { kind: 'dependency', source: v!.id, sourceElement: b, target: (await kolab.latestCommitted('orders'))!.id, targetElement: r });
  }
  const q = await kolab.raiseQuery(engineer, 'kj:orders#R1', 'From which statuses?');
  return { ...ctx, q };
}

test('a person signs in with a session token; the admin token, a stranger, another host or origin are refused', async () => {
  const { kolab, product } = await setup();
  const base = await serve(kolab);
  const post = (body: unknown, headers: Record<string, string> = { origin: base }) => fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  expect((await post({ token: 'admin-token' })).status).toBe(401);
  expect((await post({ token: 'kjs_nope' })).status).toBe(401);
  expect((await post({ token: product }, { origin: 'http://evil.example' })).status).toBe(403);
  expect((await post({ token: product }, {})).status).toBe(403);   // no origin at all
  expect((await post({ token: product }, { origin: 'null' })).status).toBe(403);   // an opaque origin
  expect((await fetch(`${base}/api/me`)).status).toBe(401);

  const { me, call, jar } = await signIn(base, product);
  expect(me).toMatchObject({ actor: 'alice', kind: 'person', role: 'product', layer: 'functional', kolab: 'test' });
  expect((await call('me')).body).toStrictEqual(me);
  // The token is never in a response body, and a refusal masks any that an error carries.
  expect(JSON.stringify((await call('overview')).body)).not.toContain(product);

  // A request naming a host Kolab doesn't serve is refused, as /mcp refuses it (DNS rebinding).
  const port = new URL(base).port;
  const status = await new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/me', headers: { host: `evil.example:${port}`, cookie: jar } }, (r) => { r.resume(); resolve(r.statusCode!); })
      .on('error', reject).end();
  });
  expect(status).toBe(403);

  // An agent's session is refused: the web interface is for people.
  await people(kolab, 'alice-pm', { owner: 'alice', layers: ['functional'] });
  const agent = await kolab.openSession('alice-pm', 'product');
  expect((await post({ token: agent })).status).toBe(403);
  // …and signing out with one in the cookie clears the cookie but ends nothing.
  const agentOut = await fetch(`${base}/api/session`, { method: 'DELETE', headers: { origin: base, cookie: `konjir_session=${agent}` } });
  expect([agentOut.status, await kolab.sessionOpen(agent)]).toStrictEqual([204, true]);

  // Signing out ends the session itself, so the token is revoked everywhere, and clears the cookie.
  const out = await fetch(`${base}/api/session`, { method: 'DELETE', headers: { origin: base, cookie: jar } });
  expect(out.status).toBe(204);
  expect(out.headers.getSetCookie()[0]).toMatch(/^konjir_session=; .*Max-Age=0/);
  expect(await kolab.sessionOpen(product)).toBe(false);
  expect((await call('me')).status).toBe(401);
});

test('behind the TLS proxy the cookie is __Host- prefixed: Secure, Path=/, no Domain', async () => {
  const { kolab, product } = await setup();
  // The server names its public host in its URL, so give it a port of our own to reach it on.
  const port = await new Promise<number>((resolve) => { const t = createServer().listen(0, '127.0.0.1', () => { const p = (t.address() as AddressInfo).port; t.close(() => resolve(p)); }); });
  closeAtEnd(await startServer({ adminToken: 'admin-token', kolab, port, webRoot: null, publicHost: 'kolab.example.com' }));
  const res = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
    const body = JSON.stringify({ token: product });
    const r = request({ host: '127.0.0.1', port, path: '/api/session', method: 'POST',
      headers: { host: 'kolab.example.com', origin: 'https://kolab.example.com', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (x) => { x.resume(); resolve({ status: x.statusCode!, cookie: String(x.headers['set-cookie']?.[0]) }); });
    r.on('error', reject);
    r.end(body);
  });
  expect(res.status).toBe(200);
  expect(res.cookie).toMatch(/^__Host-konjir_session=.+; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
});

test('switching kolab or role ends the session and opens another, and a person makes a kolab of their own', async () => {
  const { kolab, product } = await setup();
  await kolab.createKolab('second', { owner: 'test-org' });
  await kolab.grant('second', 'alice', 'read');
  const base = await serve(kolab);
  const alice = await signIn(base, product);
  const kolabs = (await alice.call<WebOverview>('overview')).body.kolabs;
  expect(kolabs.map((k) => [k.id, k.current, k.access.level])).toStrictEqual([['second', false, 'read'], ['test', true, 'write']]);

  const moved = await alice.call<{ kolab: string; role: string }>('session/switch', { kolab: 'second', role: 'engineer' });
  expect([moved.status, moved.body.kolab, moved.body.role]).toStrictEqual([200, 'second', 'engineer']);
  expect(await kolab.sessionOpen(product)).toBe(false);   // ENF4: one open session per actor
  expect((await alice.call('me')).status).toBe(401);       // the old cookie is dead…
  expect((await alice.call('session/switch', { kolab: 'nowhere', role: 'product' })).status).toBe(401);
  const sessions = (await kolab.db.query<{ n: number }>(`select count(*)::int as n from session where actor_id = 'alice' and ended_at is null`)).rows[0].n;
  expect(sessions).toBe(1);                                 // …and exactly one is open, in second

  // A kolab the person can't reach is refused, and the session stays as it was (one transaction).
  const carol = await kolab.openSession('carol', 'product');
  const again = await signIn(base, carol);
  expect((await again.call('session/switch', { kolab: 'second', role: 'product' })).status).toBe(403);
  expect([await kolab.sessionOpen(carol), (await again.call<{ kolab: string }>('me')).body.kolab]).toStrictEqual([true, 'test']);
  // Carol only reads, so she can't make a kolab (D54 lets people with Write).
  expect((await again.call('session/kolab', { name: 'carols', title: 'Carol\'s' })).status).toBe(403);

  // Erin, who writes, makes one: private, hers, and her session moves into it.
  await people(kolab, 'erin');
  const erin = await signIn(base, await kolab.openSession('erin', 'product'));
  const made = await erin.call<{ kolab: string }>('session/kolab', { name: 'erins', title: 'Erin\'s' });
  expect([made.status, made.body.kolab]).toStrictEqual([201, 'erins']);
  expect((await kolab.listKolabs()).find((k) => k.id === 'erins')).toMatchObject({ owner: 'erin', visibility: 'private' });
  expect((await erin.call('session/kolab', { name: 'more', title: 'More' })).status).toBe(401);   // that session moved on
});

test('a spec reads with its questions and notes beside each element, and a changed spec shows what went stale and how', async () => {
  const { kolab, product, engineer, q } = await specAndBinding();
  const base = await serve(kolab);
  const alice = await signIn(base, product);

  const spec = (await alice.call<WebNodeView>('nodes/orders')).body;
  expect(spec.reading).toMatchObject({ seq: 1, state: 'committed', author: 'alice' });
  expect(spec.can_write).toBe(true);
  const r1 = spec.elements.find((e) => e.id === 'R1')!;
  expect(r1.queries.map((x) => [x.id, x.state, x.question, x.raised_by, x.layer])).toStrictEqual([[q, 'open', 'From which statuses?', 'bob', 'functional']]);
  expect(r1.relied_on_by.map((l) => [l.source.node, l.source.element])).toStrictEqual([['orders-pg', 'b1']]);

  const overview = (await alice.call<WebOverview>('overview')).body;
  expect(overview.counts).toStrictEqual({ stale: 0, waiting: 1, reviews: 0, open: 1, cases: 0 });
  expect(overview.nodes.map((n) => [n.name, n.layer, n.latest])).toStrictEqual([['orders', 'functional', 1], ['orders-pg', 'technical', 1]]);

  // Alice answers, and edits R1 through the page: alone on the functional layer, it commits unreviewed.
  expect((await alice.call(`queries/${q}/answer`, { answer: 'Open or Assigned.' })).status).toBe(200);
  const out = (await alice.call<WebOutcome>('nodes/orders/submit', { base: 1, changes: [{ kind: 'override', element: 'R1', text: 'Office staff can cancel an Open or Assigned order.' }] })).body;
  expect(out).toMatchObject({ ok: true, committed: true, seq: 2, unreviewed: true, abandoned: false });

  // b1 relied on R1, so it is stale, with the text it was written against and the text now.
  const bob = await signIn(base, engineer);
  const binding = (await bob.call<WebNodeView>('nodes/orders-pg')).body;
  const [mark] = binding.elements.find((e) => e.id === 'b1')!.marks;
  expect(mark).toMatchObject({
    reason: 'changed', node: 'orders-pg', element: 'b1',
    target: { node: 'orders', element: 'R1', pinned: 1, now: 2, before: 'Office staff can cancel an order.', after: 'Office staff can cancel an Open or Assigned order.' },
  });
  expect(binding.elements.find((e) => e.id === 'b1')!.relies_on[0].mark?.id).toBe(mark.id);
  expect(binding.elements.find((e) => e.id === 'b2')!.marks).toStrictEqual([]);
  // Reading the spec's older version compares it with nothing before it; the latest with v1.
  expect((await alice.call<WebNodeView>('nodes/orders')).body.compared_with?.seq).toBe(1);
  expect((await alice.call<WebNodeView>('nodes/orders?version=1')).body.compared_with).toBeNull();

  // Only the layer that owns it settles a mark (LNK6): Alice can't, Bob can.
  expect((await alice.call(`marks/${mark.id}/clear`, {})).status).toBe(403);
  expect((await bob.call(`marks/${mark.id}/clear`, {})).status).toBe(200);
  expect((await bob.call<{ marks: WebMark[] }>('marks')).body.marks).toStrictEqual([]);

  // Bob drops b2's link to R2 in a draft (konjir_draft's unlink); it commits without it.
  const b2 = binding.elements.find((e) => e.id === 'b2')!.relies_on[0];
  expect((await bob.call<WebOutcome>('nodes/orders-pg/submit', { base: 1, changes: [], unlink: [b2.edge] })).body).toMatchObject({ committed: true, seq: 2 });
  expect((await bob.call<WebNodeView>('nodes/orders-pg')).body.elements.find((e) => e.id === 'b2')!.relies_on).toStrictEqual([]);

  // Asking from the page routes to the layer that owns the answer; a note too.
  expect((await bob.call('queries', { node: 'orders', element: 'R2', kind: 'note', text: 'Assuming refunds include shipping.' })).status).toBe(201);
  const queries = (await alice.call<{ queries: WebQuery[] }>('queries')).body.queries;
  expect(queries.map((x) => [x.kind, x.state, x.address, x.layer])).toStrictEqual([
    ['note', 'open', 'kj:orders@2#R2', 'functional'], ['question', 'answered', 'kj:orders@1#R1', 'functional'],
  ]);
  const activity = (await alice.call<{ items: { actor: string; text: string }[] }>('activity')).body.items;
  expect(activity.map((a) => `${a.actor} ${a.text}`)).toEqual(expect.arrayContaining([
    expect.stringMatching(/^alice committed kj:orders@2/), 'bob left a note on kj:orders@2#R2',
    // Who made each node (W2.20).
    'alice made kj:orders · Orders', expect.stringMatching(/^bob made kj:orders-pg · /),
  ]));
});

test('a version goes through review in the page: in review, changes requested, resubmitted, approved', async () => {
  const { kolab, product } = await specAndBinding();
  await people(kolab, 'dave', { layers: ['functional'] });
  const reviewer = await kolab.openSession('dave', 'product');
  const base = await serve(kolab);
  const alice = await signIn(base, product);
  const dave = await signIn(base, reviewer);

  const submitted = (await alice.call<WebOutcome>('nodes/orders/submit', { base: 1, changes: [{ kind: 'add', element: 'R3', text: 'A cancellation is confirmed by email.' }] })).body;
  expect(submitted).toMatchObject({ ok: false, in_review: true, seq: 2, reviewers: ['dave'] });
  const seen = (await dave.call<WebNodeView>('nodes/orders')).body;
  expect(seen.in_review).toStrictEqual([expect.objectContaining({ seq: 2, author: 'alice', reviewers: ['dave'], for_me: true })]);
  expect((await alice.call<WebNodeView>('nodes/orders')).body.in_review[0].for_me).toBe(false);
  // The reviewer reads the version in review against the version it was built on.
  const reading = (await dave.call<WebNodeView>('nodes/orders?version=2')).body;
  expect([reading.reading?.state, reading.compared_with?.seq, reading.elements.map((e) => e.id)]).toStrictEqual(['in_review', 1, ['R1', 'R2', 'R3']]);
  expect((await alice.call('nodes/orders/versions/2/review', { verdict: 'approve' })).status).toBe(409);   // not your own
  expect((await dave.call('nodes/orders/versions/2/review', { verdict: 'request_changes' })).status).toBe(400);   // needs a note

  expect((await dave.call<WebOutcome>('nodes/orders/versions/2/review', { verdict: 'request_changes', note: 'Say which email.' })).body).toMatchObject({ ok: false, in_review: false });
  expect((await alice.call<WebNodeView>('nodes/orders')).body.drafts.map((d) => [d.seq, d.state])).toStrictEqual([[2, 'drafted']]);
  expect((await alice.call<WebOutcome>('nodes/orders/versions/2/resubmit', {})).body).toMatchObject({ in_review: true, seq: 2 });
  expect((await dave.call<WebOutcome>('nodes/orders/versions/2/review', { verdict: 'approve', note: 'Fine.' })).body).toMatchObject({ ok: true, committed: true, seq: 2 });
  expect((await alice.call<WebNodeView>('nodes/orders')).body.reading).toMatchObject({ seq: 2, state: 'committed' });

  // A draft that fails Kolab's checks is abandoned, and the page keeps the edits.
  const empty = (await alice.call<WebOutcome>('nodes/orders/submit', { base: 2, changes: [{ kind: 'override', element: 'R2', text: '   ' }] })).body;
  expect(empty).toMatchObject({ ok: false, in_review: false, abandoned: true });
  expect((await alice.call<WebNodeView>('nodes/orders')).body.drafts).toStrictEqual([]);
  expect((await alice.call('nodes/orders/submit', { base: 2, changes: [] })).status).toBe(400);

  // Edits made on an older version are refused as stale, never laid over the newer one (CAS7).
  const late = await alice.call<{ error: string; message: string }>('nodes/orders/submit', { base: 1, changes: [{ kind: 'override', element: 'R1', text: 'Written against v1.' }] });
  expect([late.status, late.body.error]).toStrictEqual([409, 'stale']);
  expect(late.body.message).toMatch(/your edits were made on version 1, and it is at version 2 now/);
  expect((await alice.call<WebNodeView>('nodes/orders')).body.drafts).toStrictEqual([]);
});

test('a draft that came back is edited in place: the page resubmits it edited, and the new version carries the links it dropped and declared', async () => {
  const { kolab, engineer, product } = await specAndBinding();
  await people(kolab, 'erin', { layers: ['technical'] });
  const base = await serve(kolab);
  const bob = await signIn(base, engineer);
  const erinSession = await kolab.openSession('erin', 'engineer');
  const erin = await signIn(base, erinSession);

  // Bob drafts v2 as an agent would: b2's link dropped, a new b3 linked to R1.
  const b2 = (await bob.call<WebNodeView>('nodes/orders-pg')).body.elements.find((e) => e.id === 'b2')!.relies_on[0];
  const v2 = await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'orders.status allows cancel from Open.', b2: 'Refunds go through the payments queue.', b3: 'Cancelling sends an email.' }), unlink: [{ link: b2.edge }] });
  await kolab.link(engineer, { kind: 'dependency', source: v2, sourceElement: 'b3', target: (await kolab.latestCommitted('orders'))!.id, targetElement: 'R1' });
  expect((await kolab.submit(engineer, v2)).in_review).toBe(true);
  expect((await erin.call<WebOutcome>('nodes/orders-pg/versions/2/review', { verdict: 'request_changes', note: 'Say which email.' })).status).toBe(200);
  expect((await bob.call<WebNodeView>('nodes/orders-pg')).body.drafts).toStrictEqual([expect.objectContaining({ seq: 2, state: 'drafted', base: 1 })]);
  // Meanwhile the spec b3 links to commits again, R1 still there: the carried link is pinned to orders@2, as a fresh link would be.
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Office staff can cancel an order.', R2: 'A cancelled order is refunded in full, shipping included.' }) });

  // The page sends its changes against v1, edited, in place of v2.
  const out = (await bob.call<WebOutcome>('nodes/orders-pg/submit', { base: 1, replaces: 2, changes: [{ kind: 'add', element: 'b3', text: 'Cancelling sends the customer a cancellation email.' }] })).body;
  expect(out).toMatchObject({ in_review: true, seq: 3, reviewers: ['erin'] });
  const now = (await bob.call<WebNodeView>('nodes/orders-pg')).body;
  expect([now.drafts, now.versions.map((v) => [v.seq, v.state])]).toStrictEqual([[], [[1, 'committed'], [3, 'in_review']]]);
  const v3 = await kolab.readNode(engineer, 'orders-pg', 3);
  expect(v3.elements.map((e) => [e.element_id, e.text])).toStrictEqual([
    ['b1', 'orders.status allows cancel from Open.'], ['b2', 'Refunds go through the payments queue.'], ['b3', 'Cancelling sends the customer a cancellation email.'],
  ]);
  expect(v3.removes).toStrictEqual([{ kind: 'dependency', source: 'kj:orders-pg@3#b2', target: 'kj:orders#R2' }]);
  const own = await kolab.db.query(`select e.source_element_id, e.target_element_id, t.seq as target_seq from edge e join version v on v.id = e.source_version_id
    join version t on t.id = e.target_version_id where v.node_id = 'orders-pg' and v.seq = 3`);
  expect(own.rows).toStrictEqual([{ source_element_id: 'b3', target_element_id: 'R1', target_seq: 2 }]);

  // Approved, it commits as v3 did: b3 linked, b2's link gone.
  expect((await erin.call<WebOutcome>('nodes/orders-pg/versions/3/review', { verdict: 'approve' })).body).toMatchObject({ committed: true, seq: 3 });
  const committed = (await bob.call<WebNodeView>('nodes/orders-pg')).body;
  expect(committed.elements.map((e) => [e.id, e.relies_on.map((l) => l.target.element)])).toStrictEqual([['b1', ['R1']], ['b2', []], ['b3', ['R1']]]);

  // Only a draft built on the live version is edited: one built on an older one would undo what committed since.
  const v4 = await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'x' }) });
  const v5 = await kolab.draft(erinSession, 'orders-pg', { elements: els({ b1: 'orders.status allows cancel from Open or Assigned.' }) });
  expect((await kolab.submit(erinSession, v5)).in_review).toBe(true);
  expect((await bob.call<WebOutcome>(`nodes/orders-pg/versions/${(await kolab.version(v5)).seq}/review`, { verdict: 'approve' })).body).toMatchObject({ committed: true });
  const old = await bob.call<{ error: string }>('nodes/orders-pg/submit', { base: (await kolab.latestCommitted('orders-pg'))!.seq, replaces: (await kolab.version(v4)).seq, changes: [{ kind: 'override', element: 'b1', text: 'y' }] });
  expect([old.status, old.body.error]).toStrictEqual([409, 'stale']);
});

test('editing a draft that came back: a carried link whose target element is gone is refused by name; two resubmits at once leave one version in review', async () => {
  const { kolab, engineer, product } = await specAndBinding();
  await people(kolab, 'erin', { layers: ['technical'] });
  const base = await serve(kolab);
  const bob = await signIn(base, engineer);
  const erin = await signIn(base, await kolab.openSession('erin', 'engineer'));
  const returned = async (text: string) => {
    const v = await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'orders.status allows cancel from Open.', b2: 'Refunds go through the payments queue.', b3: text }) });
    await kolab.link(engineer, { kind: 'dependency', source: v, sourceElement: 'b3', target: (await kolab.latestCommitted('orders'))!.id, targetElement: 'R2' });
    expect((await kolab.submit(engineer, v)).in_review).toBe(true);
    const seq = (await kolab.version(v)).seq;
    expect((await erin.call(`nodes/orders-pg/versions/${seq}/review`, { verdict: 'request_changes', note: 'Not yet.' })).status).toBe(200);
    return seq;
  };

  // Two resubmits of one returned draft at once (a double click, two tabs): one goes into review, the other is refused, and the draft is abandoned once.
  const v2 = await returned('Refunds are emailed.');
  const edit = { base: 1, replaces: v2, changes: [{ kind: 'add', element: 'b3', text: 'Refunds are emailed to the customer.' }] };
  const both = await Promise.all([bob.call<WebOutcome>('nodes/orders-pg/submit', edit), bob.call<WebOutcome>('nodes/orders-pg/submit', edit)]);
  expect(both.map((r) => r.status).sort()).toStrictEqual([200, 409]);
  const after = (await bob.call<WebNodeView>('nodes/orders-pg')).body;
  expect([after.drafts, after.in_review.map((r) => r.author)]).toStrictEqual([[], ['bob']]);
  // While it waits, replacing another returned draft is refused: one version of Bob's in review per node.
  const waiting = after.in_review[0].seq;
  const v5 = await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'orders.status allows cancel from Open.', b2: 'Refunds go through the payments queue.' }) });
  await kolab.db.query(`update version set state = 'drafted' where id = $1`, [v5]);   // as if returned
  const second = await bob.call<{ error: string; message: string }>('nodes/orders-pg/submit', { base: 1, replaces: (await kolab.version(v5)).seq, changes: [{ kind: 'override', element: 'b2', text: 'Refunds go through the queue.' }] });
  expect([second.status, second.body.error]).toStrictEqual([409, 'conflict']);
  expect(second.body.message).toMatch(new RegExp(`orders-pg@${waiting} of yours is in review already`));
  expect((await bob.call(`nodes/orders-pg/versions/${waiting}/abandon`, {})).status).toBe(200);
  expect((await bob.call(`nodes/orders-pg/versions/${(await kolab.version(v5)).seq}/abandon`, {})).status).toBe(200);

  // A returned draft links b3 to R2; the spec then commits without R2: the link can't be carried, and the refusal names it.
  const v = await returned('Refunds are emailed again.');
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Office staff can cancel an order.' }) });
  const gone = await bob.call<{ error: string; message: string }>('nodes/orders-pg/submit', { base: 1, replaces: v, changes: [{ kind: 'add', element: 'b3', text: 'Refunds are emailed, always.' }] });
  expect(gone.status).toBe(400);
  expect(gone.body.message).toMatch(new RegExp(`orders-pg@${v} links to kj:orders@1#R2, which version 2 no longer has`));
  expect((await bob.call<WebNodeView>('nodes/orders-pg')).body.drafts.map((d) => d.seq)).toStrictEqual([v]);   // nothing written, the draft kept
});

test('replacing a draft claims it only while it is a draft: a "resubmit as it is" racing it stays in review, and a link into work no longer read is refused saying nothing of it', async () => {
  const { kolab, engineer, product } = await specAndBinding();
  await people(kolab, 'erin', { layers: ['technical'] });
  const base = await serve(kolab);
  const bob = await signIn(base, engineer);
  const erin = await signIn(base, await kolab.openSession('erin', 'engineer'));
  const returned = async (link?: { target: string; element: string; selector?: { exact: string; prefix?: string; suffix?: string } }) => {
    const v = await kolab.draft(engineer, 'orders-pg', { elements: els({ b1: 'orders.status allows cancel from Open.', b2: 'Refunds go through the payments queue.', b3: 'Refunds are emailed.' }) });
    if (link) await kolab.link(engineer, { kind: 'dependency', source: v, sourceElement: 'b3', target: link.target, targetElement: link.element, selector: link.selector });
    expect((await kolab.submit(engineer, v)).in_review).toBe(true);
    const seq = (await kolab.version(v)).seq;
    expect((await erin.call(`nodes/orders-pg/versions/${seq}/review`, { verdict: 'request_changes', note: 'Not yet.' })).status).toBe(200);
    return seq;
  };
  const inReview = async () => (await bob.call<WebNodeView>('nodes/orders-pg')).body.in_review.map((r) => r.seq);

  // A resubmit as it is and a replacement, at once: whichever wins, only it succeeds, and exactly one version waits in review.
  // A resubmit told "in review" is never abandoned behind its back.
  for (let round = 0; round < 3; round++) {
    const v = await returned();
    const [as, replaced] = await Promise.all([
      bob.call<WebOutcome>(`nodes/orders-pg/versions/${v}/resubmit`, {}),
      bob.call<WebOutcome>('nodes/orders-pg/submit', { base: 1, replaces: v, changes: [{ kind: 'add', element: 'b3', text: 'Refunds are emailed to the customer.' }] }),
    ]);
    expect([as.status, replaced.status].filter((x) => x === 200)).toHaveLength(1);
    const waiting = await inReview();
    expect(waiting).toHaveLength(1);
    if (as.status === 200) expect(waiting).toStrictEqual([v]);
    else expect(waiting).toStrictEqual([replaced.body.seq]);
    expect((await bob.call(`nodes/orders-pg/versions/${waiting[0]}/abandon`, {})).status).toBe(200);
  }
  // Resubmitted first, then replaced: the replacement is refused, and the resubmitted version stays in review.
  const v = await returned();
  expect((await bob.call(`nodes/orders-pg/versions/${v}/resubmit`, {})).status).toBe(200);
  const late = await bob.call<{ error: string }>('nodes/orders-pg/submit', { base: 1, replaces: v, changes: [{ kind: 'add', element: 'b3', text: 'x' }] });
  expect([late.status, await inReview()]).toStrictEqual([409, [v]]);
  expect((await bob.call(`nodes/orders-pg/versions/${v}/abandon`, {})).status).toBe(200);

  // A quote that no longer stands where it pointed is refused before anything is written.
  const orders = (await kolab.latestCommitted('orders'))!;
  const quoted = await returned({ target: orders.id, element: 'R2', selector: { exact: 'refunded in full' } });
  await kolab.commit(product, 'orders', { elements: els({ R1: 'Office staff can cancel an order.', R2: 'A cancelled order is refunded, less shipping.' }) });
  const seqs = async () => (await bob.call<WebNodeView>('nodes/orders-pg')).body.versions.length;
  const before = await seqs();
  const quote = await bob.call<{ message: string }>('nodes/orders-pg/submit', { base: 1, replaces: quoted, changes: [{ kind: 'add', element: 'b3', text: 'y' }] });
  expect(quote.status).toBe(400);
  expect(quote.body.message).toMatch(new RegExp(`orders-pg@${quoted} quotes "refunded in full" in kj:orders@1#R2, which version 2 no longer says as quoted`));
  expect(await seqs()).toBe(before);
  expect((await bob.call(`nodes/orders-pg/versions/${quoted}/abandon`, {})).status).toBe(200);

  // A link into another kolab Bob read when he drafted, and reads no longer: refused, naming nothing of that kolab's work.
  await kolab.addActor('olga');
  await kolab.createKolab('other', { owner: 'olga' });
  const olga = await kolab.openSession('olga', 'product', { kolab: 'other' });
  await kolab.createNode(olga, 'functional_spec', 'Secret', 'secret');
  await kolab.commit(olga, 'secret', { elements: els({ S1: 'Only olga knows.' }) });
  await kolab.grant('other', 'bob', 'read');
  const foreign = await returned({ target: (await kolab.latestCommitted('secret'))!.id, element: 'S1' });
  await kolab.revoke('other', 'bob');
  await kolab.commit(olga, 'secret', { elements: els({ S2: 'Olga moved it.' }) });
  const hidden = await bob.call<{ message: string }>('nodes/orders-pg/submit', { base: 1, replaces: foreign, changes: [{ kind: 'add', element: 'b3', text: 'z' }] });
  expect(hidden.status).toBe(400);
  expect(hidden.body.message).toMatch(new RegExp(`orders-pg@${foreign}'s link from b3 points into work you no longer read`));
  expect(hidden.body.message).not.toMatch(/secret|S1|S2|other|version 2/);
});

test('a page reads and writes only its session\'s kolab', async () => {
  const { kolab, product, q } = await specAndBinding();
  await kolab.addActor('erin');
  await kolab.createKolab('other', { owner: 'erin' });
  const erin = await kolab.openSession('erin', 'product', { kolab: 'other' });
  await kolab.createNode(erin, 'functional_spec', 'Secret', 'secret');
  await kolab.commit(erin, 'secret', { elements: els({ S1: 'Only erin knows.' }) });
  const base = await serve(kolab);
  const alice = await signIn(base, product);
  const theirs = await signIn(base, erin);

  expect((await alice.call('nodes/secret')).status).toBe(404);
  expect((await alice.call('nodes/other%2Fsecret')).status).toBe(403);
  expect((await theirs.call('nodes/orders')).status).toBe(404);
  expect((await theirs.call<{ queries: WebQuery[] }>('queries')).body.queries).toStrictEqual([]);
  expect((await theirs.call(`queries/${q}/answer`, { answer: 'mine now' })).status).toBe(404);   // another kolab's question reads as one that isn't there
  expect((await alice.call<WebOverview>('overview')).body.kolabs.map((k) => k.id)).toStrictEqual(['test']);
  expect((await theirs.call<WebOverview>('overview')).body.nodes.map((n) => n.name)).toStrictEqual(['secret']);
});

test('the event stream signals changes, commits and the end of the session', async () => {
  const { kolab, product, engineer } = await specAndBinding();
  const base = await serve(kolab);
  const { jar } = await signIn(base, product);
  const res = await fetch(`${base}/api/events`, { headers: { cookie: jar } });
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<WebEvent | 'closed'> => {
    for (;;) {
      const at = buffer.indexOf('\n\n');
      if (at >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return 'closed';
      buffer += decoder.decode(value, { stream: true });
    }
  };
  /** The next event that isn't a `changed` of another kind: a write may signal more than one thing, and a poll may see a commit in two steps. */
  const nextBut = async (skip: (e: WebEvent) => boolean) => { for (;;) { const e = await next(); if (e === 'closed' || !skip(e)) return e; } };
  expect(await next()).toStrictEqual({ type: 'ready' });
  // A session holds a few streams at once, not a flood.
  const more = await Promise.all(Array.from({ length: 6 }, () => fetch(`${base}/api/events`, { headers: { cookie: jar } })));
  expect(more.map((r) => r.status).sort()).toStrictEqual([200, 200, 200, 200, 200, 429]);
  for (const r of more) await r.body?.cancel();
  await kolab.raiseQuery(engineer, 'kj:orders#R2', 'Partial refunds?');
  expect(await next()).toStrictEqual({ type: 'changed', what: 'layer', layer: 'functional' });
  // A case file opened on a spec element signals its layer, so every page of the kolab re-reads it.
  await kolab.openCase(engineer, 'kj:orders#R2', { question: 'Partial refunds?', claim: 'Partial refunds are needed.', evidence: ['kj:orders#R2'], seeks: 'change_intent' });
  expect(await next()).toStrictEqual({ type: 'changed', what: 'layer', layer: 'functional' });
  await kolab.commit(engineer, 'orders-pg', { deltas: [{ kind: 'override', element: 'b2', text: 'Refunds go through the payments queue, retried.' }] });
  expect(await nextBut((e) => e.type === 'changed' && e.what === 'layer')).toStrictEqual({ type: 'changed', what: 'versions' });
  await kolab.endSession(product);
  expect(await nextBut((e) => e.type === 'changed')).toStrictEqual({ type: 'ended' });
  expect(await next()).toBe('closed');
});

test('the server serves the built pages at the root, with their security headers, and never over its own routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'konjir-web-'));
  roots.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Kolab</title>');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(root, 'assets', 'face-abc123.woff2'), 'wOF2');
  const { kolab } = await setup();
  const base = await serve(kolab, { webRoot: root });

  const page = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  expect([page.status, await page.text()]).toStrictEqual([200, '<!doctype html><title>Kolab</title>']);
  // Everything is Kolab's own: fonts are files it serves (font-src 'self', no data:), which the
  // web build keeps so (apps/web/vite.config.ts fails a build that inlines one).
  expect(page.headers.get('content-security-policy')).toBe([
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
    "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join('; '));
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  // A referrer for Kolab alone: never no-referrer, under which a browser may send the page's own
  // changes with Origin: null, which /api refuses (apps/web/e2e/sign-in.spec.ts, in Chromium).
  expect(page.headers.get('referrer-policy')).toBe('same-origin');
  const deep = await fetch(`${base}/questions`, { headers: { accept: 'text/html' } });
  expect(await deep.text()).toContain('<title>Kolab</title>');
  const asset = await fetch(`${base}/assets/app-abc123.js`);
  expect([asset.status, asset.headers.get('cache-control')]).toStrictEqual([200, 'public, max-age=31536000, immutable']);
  const font = await fetch(`${base}/assets/face-abc123.woff2`);
  expect([font.status, font.headers.get('content-type'), font.headers.get('content-security-policy')]).toStrictEqual([200, 'font/woff2', page.headers.get('content-security-policy')]);
  expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  const api = await fetch(`${base}/api/nowhere`, { headers: { accept: 'text/html' } });
  expect([api.status, await api.text()]).toStrictEqual([404, expect.not.stringContaining('<title>')]);
  expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');

  const { kolab: other } = await setup();
  const unbuilt = await serve(other, { webRoot: null });
  const none = await fetch(`${unbuilt}/`, { headers: { accept: 'text/html' } });
  expect([none.status, await none.text()]).toStrictEqual([503, expect.stringContaining('npx nx run @konjir/web:build')]);
});

test('case files and rulings in the page: open, take the other side, rule, precedent beside the element, and who may not', async () => {
  const { kolab, product, engineer } = await specAndBinding();
  await people(kolab, 'dana', { layers: ['functional'] });
  await people(kolab, 'alice-pm', { owner: 'alice', layers: ['functional'] });
  const base = await serve(kolab);
  const alice = await signIn(base, product);
  const bob = await signIn(base, engineer);
  const carol = await signIn(base, await kolab.openSession('carol', 'product'));
  const dana = await signIn(base, await kolab.openSession('dana', 'product'));

  // Bob, an engineer, finds R1 can't be met as written: he opens a case file on it (CASE5).
  const opened = await bob.call<WebCase>('cases', {
    node: 'orders', seq: 1, element: 'R1', question: 'May office staff cancel a shipped order?',
    claim: 'Shipped orders can\'t be recalled from the carrier.', evidence: ['kj:orders-pg#b1', 'carrier API: no recall endpoint'], seeks: 'change_intent',
  });
  expect(opened.status).toBe(201);
  const c = opened.body;
  expect(c).toMatchObject({ on: 'kj:orders@1#R1', node: 'orders', seq: 1, element: 'R1', layer: 'functional', state: 'open', opened_by: 'bob' });
  expect(c.positions.map((p) => [p.actor, p.seeks])).toStrictEqual([['bob', 'change_intent']]);
  expect(Object.keys(c.positions[0]).sort()).toStrictEqual(['actor', 'claim', 'evidence', 'position', 'seeks', 'taken_at', 'verdict']);   // no kind or owner: the page needs only `you`
  expect(c.you).toStrictEqual({ party: true, can_argue: false, can_rule: false });
  // Evidence that doesn't resolve, a quote, or no evidence at all are refused.
  expect((await bob.call('cases', { node: 'orders', element: 'R1', question: 'q', claim: 'c', evidence: ['kj:orders#R99'], seeks: 'keep_intent' })).status).toBe(400);
  expect((await bob.call('cases', { node: 'orders', element: 'R1', question: 'q', claim: 'c', evidence: 'kj:orders#R1', seeks: 'keep_intent' })).status).toBe(400);
  expect((await bob.call('cases', { node: 'orders', element: 'R1', question: 'q', claim: 'c', evidence: ['x'], seeks: 'maybe' })).status).toBe(400);

  // Alice sees it beside R1, and may take the other side; Bob, who holds a side, may not take both.
  const r1 = (await alice.call<WebNodeView>('nodes/orders')).body.elements.find((e) => e.id === 'R1')!;
  expect(r1.cases.map((x) => [x.case, x.you])).toStrictEqual([[c.case, { party: false, can_argue: true, can_rule: false }]]);
  expect((await bob.call(`cases/${c.case}/positions`, { claim: 'and also', evidence: ['kj:orders#R1'] })).status).toBe(409);

  // D49: a reader who holds only Read in the kolab sees no case files and can't open or argue one.
  expect((await carol.call<WebCasesView>('cases')).body).toStrictEqual({ cases: [], belongs: false });
  expect((await carol.call(`cases/${c.case}`)).status).toBe(404);
  expect((await carol.call('cases', { node: 'orders', element: 'R1', question: 'q', claim: 'c', evidence: ['kj:orders#R1'], seeks: 'keep_intent' })).status).toBe(403);
  expect((await carol.call(`cases/${c.case}/positions`, { claim: 'c', evidence: ['kj:orders#R1'] })).status).toBe(403);
  expect((await carol.call<WebNodeView>('nodes/orders')).body.elements[0]).toMatchObject({ id: 'R1', cases: [], rulings: [] });
  // An agent's session is refused at the door, whatever the route.
  const agent = await kolab.openSession('alice-pm', 'product');
  const asAgent = await fetch(`${base}/api/cases/${c.case}/rule`, {
    method: 'POST', headers: { origin: base, cookie: `konjir_session=${agent}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', verdicts: {} }),
  });
  expect(asAgent.status).toBe(403);
  // A case file holding one side isn't ruled on yet.
  expect((await dana.call(`cases/${c.case}/rule`, { text: 'x', verdicts: { [c.positions[0].position]: 'sustained' } })).status).toBe(409);

  // Alice takes the other side: it seeks the opposite, keeping the intent.
  const argued = await alice.call<WebCase>(`cases/${c.case}/positions`, { claim: 'Staff cancel before shipping; after, it is a return.', evidence: ['kj:orders#R2'] });
  expect(argued.status).toBe(201);
  expect(argued.body.positions.map((p) => [p.actor, p.seeks])).toStrictEqual([['bob', 'change_intent'], ['alice', 'keep_intent']]);
  const [bobs, alices] = argued.body.positions.map((p) => p.position);

  // Who rules (D51): a person with Write on the functional layer who isn't a party. Alice is one.
  expect((await alice.call(`cases/${c.case}/rule`, { text: 'x', verdicts: { [bobs]: 'overruled', [alices]: 'sustained' } })).status).toBe(403);
  expect((await bob.call(`cases/${c.case}/rule`, { text: 'x', verdicts: { [bobs]: 'sustained', [alices]: 'overruled' } })).status).toBe(403);
  expect((await carol.call(`cases/${c.case}/rule`, { text: 'x', verdicts: { [bobs]: 'sustained', [alices]: 'overruled' } })).status).toBe(404);
  const forDana = (await dana.call<WebCase>(`cases/${c.case}`)).body;
  expect(forDana.you).toStrictEqual({ party: false, can_argue: false, can_rule: true });
  // Exactly one position is sustained.
  expect((await dana.call(`cases/${c.case}/rule`, { text: 'x', verdicts: { [bobs]: 'sustained', [alices]: 'sustained' } })).status).toBe(409);
  expect((await dana.call(`cases/${c.case}/rule`, { text: 'x', verdicts: { [bobs]: 'maybe' } })).status).toBe(400);
  const ruled = await dana.call<WebRuling>(`cases/${c.case}/rule`, {
    text: 'Office staff cancel an order until it ships; a shipped order is returned instead.', verdicts: { [bobs]: 'sustained', [alices]: 'overruled' },
  });
  expect(ruled.status).toBe(201);
  expect(ruled.body).toMatchObject({ case: c.case, on: 'kj:orders@1#R1', element: 'R1', effect: 'change_intent', ruled_by: 'dana' });
  expect((await dana.call(`cases/${c.case}/rule`, { text: 'again', verdicts: { [bobs]: 'sustained', [alices]: 'overruled' } })).status).toBe(409);

  // The ruling is precedent beside R1, and, changing the intent, marks R1 with a question that no one clears by hand.
  const after = (await alice.call<WebNodeView>('nodes/orders')).body.elements.find((e) => e.id === 'R1')!;
  expect(after.rulings.map((r) => [r.ruling, r.text])).toStrictEqual([[ruled.body.ruling, ruled.body.text]]);
  expect(after.cases).toStrictEqual([]);
  const mark = after.marks.find((m) => m.reason === 'ruled')!;
  expect(mark).toBeDefined();
  expect(after.queries.some((q) => q.mark === mark.id && q.mark_reason === 'ruled')).toBe(true);
  expect((await alice.call(`marks/${mark.id}/clear`, {})).status).toBe(409);
  const listed = (await bob.call<WebCasesView>('cases?state=all')).body;
  expect(listed.cases.map((x) => [x.state, x.positions.map((p) => p.verdict)])).toStrictEqual([['ruled', ['sustained', 'overruled']]]);
  expect((await bob.call<WebCasesView>('cases?state=open')).body.cases).toStrictEqual([]);
  expect((await bob.call<WebCasesView>('cases?mine=true')).body.cases.map((x) => x.case)).toStrictEqual([c.case]);
  expect((await bob.call('cases?state=whatever')).status).toBe(400);
  expect((await carol.call<{ rulings: WebRuling[] }>('rulings')).body.rulings).toStrictEqual([]);
  expect((await alice.call<WebActivityView>('activity')).body.items.map((i) => i.text)).toEqual(expect.arrayContaining([
    'opened a case file on kj:orders@1#R1', 'took the other side of the case file on kj:orders@1#R1', 'ruled on kj:orders@1#R1: the intent changes',
  ]));

  // A later version amending R1 settles the mark and its question (D51).
  const sent = await alice.call<WebOutcome>('nodes/orders/submit', { base: 1, changes: [{ kind: 'override', element: 'R1', text: ruled.body.text }] });
  expect(sent.body.in_review).toBe(true);
  expect((await dana.call<WebOutcome>(`nodes/orders/versions/${sent.body.seq}/review`, { verdict: 'approve' })).body.committed).toBe(true);
  const settled = (await alice.call<WebNodeView>('nodes/orders')).body.elements.find((e) => e.id === 'R1')!;
  expect(settled.marks.filter((m) => m.reason === 'ruled')).toStrictEqual([]);
  expect(settled.rulings).toHaveLength(1);   // precedent stays, from any version

  // A direct ruling (CASE3): on an element of the person's own layer, from its role; it supersedes an open case file there.
  const second = (await alice.call<WebCase>('cases', { node: 'orders-pg', element: 'b2', question: 'Queue or inline?', claim: 'Inline is simpler.', evidence: ['kj:orders-pg#b2'], seeks: 'change_intent' })).body;
  expect((await alice.call('rulings', { node: 'orders-pg', element: 'b2', text: 'x', effect: 'keep_intent' })).status).toBe(403);   // product doesn't rule the technical layer
  expect((await carol.call('rulings', { node: 'orders', element: 'R2', text: 'x', effect: 'keep_intent' })).status).toBe(403);
  expect((await bob.call('rulings', { node: 'orders-pg', element: 'b2', text: 'x' })).status).toBe(400);   // say what it does
  const direct = await bob.call<WebRuling>('rulings', { node: 'orders-pg', element: 'b2', text: 'Refunds stay on the queue.', effect: 'keep_intent', replaces: 'nothing' });
  expect(direct.status).toBe(201);
  expect(direct.body).toMatchObject({ case: null, on: 'kj:orders-pg@1#b2', effect: 'keep_intent', replaces: 'nothing', ruled_by: 'bob' });
  expect((await bob.call<WebCase>(`cases/${second.case}`)).body).toMatchObject({ state: 'superseded', superseded_by: direct.body.ruling, ruling: { ruling: direct.body.ruling } });
  const b2 = (await bob.call<WebNodeView>('nodes/orders-pg')).body.elements.find((e) => e.id === 'b2')!;
  expect([b2.rulings.map((r) => r.ruling), b2.marks]).toStrictEqual([[direct.body.ruling], []]);   // keeping the intent marks nothing
  // On the node as a whole, too.
  const whole = await bob.call<WebRuling>('rulings', { node: 'orders-pg', text: 'Every binding element names its table.', effect: 'keep_intent' });
  expect((await bob.call<WebNodeView>('nodes/orders-pg')).body.rulings.map((r) => r.ruling)).toStrictEqual([whole.body.ruling]);
  expect((await bob.call<{ rulings: WebRuling[] }>('rulings')).body.rulings.map((r) => r.ruling)).toStrictEqual([whole.body.ruling, direct.body.ruling, ruled.body.ruling]);
  expect((await bob.call<WebOverview>('overview')).body.counts.cases).toBe(0);
});

test('another kolab\'s committed work reads in place, read only, and nothing else of it; a kolab one can\'t read is refused as if it weren\'t there', async () => {
  const { kolab, product, engineer } = await specAndBinding();
  await kolab.addActor('erin');
  await kolab.createKolab('other', { owner: 'erin', title: 'Other' });
  await kolab.grant('other', 'alice', 'read');
  const erin = await kolab.openSession('erin', 'product', { kolab: 'other' });
  await kolab.createNode(erin, 'functional_spec', 'Secret', 'secret');
  await kolab.commit(erin, 'secret', { elements: els({ S1: 'Only those who read other know.' }) });
  await kolab.commit(erin, 'secret', { elements: els({ S1: 'Readers of other know this.' }) });
  await kolab.raiseQuery(erin, 'kj:secret#S1', 'Who reads it?');
  await kolab.draft(erin, 'secret', { elements: els({ S1: 'A draft only erin sees.' }) });
  await kolab.rule(erin, { address: 'kj:secret#S1', text: 'A ruling private to other.', effect: 'change_intent' });
  // A node with only a draft reads exactly as one that isn't there.
  await kolab.createNode(erin, 'functional_spec', 'Acquire Foo Inc', 'acquisition-plan');
  await kolab.draft(erin, 'acquisition-plan', { elements: els({ A1: 'Buy Foo.' }) });
  const base = await serve(kolab);
  const alice = await signIn(base, product);
  const bob = await signIn(base, engineer);

  const list = await alice.call<WebForeignKolab>('kolabs/other/nodes');
  expect(list.body).toStrictEqual({
    kolab: { id: 'other', title: 'Other', owner: 'erin', visibility: 'private', access: { level: 'read', layers: [] } },
    nodes: [{ name: 'secret', kind: 'functional_spec', layer: 'functional', title: 'Secret', latest: 2, drafts: 0, in_review: 0 }],
  });
  const read = (await alice.call<WebNodeView>('kolabs/other/nodes/secret')).body;
  expect(read).toMatchObject({ kolab: 'other', foreign: true, can_write: false, in_review: [], drafts: [], rulings: [] });
  expect(read.versions.map((v) => [v.seq, v.state])).toStrictEqual([[1, 'committed'], [2, 'committed']]);
  expect(read.elements.map((e) => [e.id, e.text, e.address, e.marks, e.rulings, e.cases, e.relies_on])).toStrictEqual([
    ['S1', 'Readers of other know this.', 'kj:other/secret@2#S1', [], [], [], []],
  ]);
  // Its questions, in the full form, but none a mark raised, such as the ruling's (D49: marks and rulings stay private).
  expect(read.elements[0].queries.map((q) => [q.question, q.address, q.mark])).toStrictEqual([['Who reads it?', 'kj:other/secret@2#S1', null]]);
  expect(read.compared_with).toStrictEqual({ seq: 1, elements: [{ id: 'S1', text: 'Only those who read other know.' }] });
  expect((await alice.call<WebNodeView>('kolabs/other/nodes/secret?version=1')).body.elements[0].text).toBe('Only those who read other know.');
  // The draft reads exactly as a version that doesn't exist.
  const draft = await alice.call<{ message: string }>('kolabs/other/nodes/secret?version=3');
  const none = await alice.call<{ message: string }>('kolabs/other/nodes/secret?version=9');
  expect([draft.status, none.status]).toStrictEqual([404, 404]);
  expect(draft.body.message.replace('3', 'N')).toBe(none.body.message.replace('9', 'N'));
  expect(JSON.stringify([list.body, read])).not.toMatch(/draft only erin|private to other/);

  // Bob holds nothing in other: the kolab and its node are refused exactly as ones that aren't there.
  const refusals = await Promise.all([
    bob.call('kolabs/other/nodes/secret'), bob.call('kolabs/nowhere/nodes/secret'), alice.call('kolabs/other/nodes/missing'),
    bob.call('kolabs/other/nodes'), bob.call('kolabs/nowhere/nodes'), alice.call('kolabs/other/nodes/acquisition-plan'),
  ]);
  expect(refusals.map((r) => [r.status, r.body])).toStrictEqual([
    [404, { error: 'not_found', message: 'no node secret in kolab other' }],
    [404, { error: 'not_found', message: 'no node secret in kolab nowhere' }],
    [404, { error: 'not_found', message: 'no node missing in kolab other' }],
    [404, { error: 'not_found', message: 'no kolab other you can read' }],
    [404, { error: 'not_found', message: 'no kolab nowhere you can read' }],
    [404, { error: 'not_found', message: 'no node acquisition-plan in kolab other' }],
  ]);
  expect(JSON.stringify(list.body)).not.toMatch(/Acquire Foo|acquisition-plan/);
  // Version numbers are the node's own, committed or not: a reader outside sees v1 and v2 here, and would see a gap where drafts were.
  // Malformed requests are refused as such, never a 500.
  for (const [path, body] of [
    ['cases?node=a&node=b', undefined], ['rulings?node=a&node=b', undefined], ['kolabs/test/nodes/orders?version=1&version=2', undefined],
    ['cases', { node: 'orders', element: 'R1~q(})', question: 'q', claim: 'c', evidence: ['x'], seeks: 'keep_intent' }],
    ['cases', { node: 'orders', element: 'R1', question: 1, claim: 'c', evidence: ['x'], seeks: 'keep_intent' }],
    ['rulings', { node: 'orders', element: 'R1', text: 'x', effect: 'keep_intent', replaces: 1 }],
    ['rulings', { node: 'orders', element: 'R1#x', text: 'x', effect: 'keep_intent' }],
    ['rulings', { node: 'orders', text: 7, effect: 'keep_intent' }],
    ['cases/whatever/rule', { text: 'x', verdicts: { p: 'sustained' }, replaces: ['a'] }],
    ['cases/whatever/positions', { claim: 5, evidence: ['x'] }],
  ] as const) {
    expect([path, (await alice.call(path, body)).status]).toStrictEqual([path, 400]);
  }
  // In the session's own kolab, the full form is the node's own page.
  expect((await alice.call<WebNodeView>('kolabs/test/nodes/orders')).body).toMatchObject({ kolab: 'test', foreign: false });
  // Nothing is written there from here.
  expect((await alice.call('queries', { node: 'other/secret', element: 'S1', kind: 'question', text: 'Why?' })).status).toBe(400);
  expect((await alice.call('cases', { node: 'other/secret', element: 'S1', question: 'q', claim: 'c', evidence: ['kj:orders#R1'], seeks: 'keep_intent' })).status).toBe(400);
  expect((await alice.call('nodes/other%2Fsecret/submit', { base: 2, changes: [{ kind: 'override', element: 'S1', text: 'mine' }] })).status).toBe(403);
});

test('in the page: with nobody else able to review yet it says so; an engineer asks about the version in review; abandoned, the question is withdrawn (D65)', async () => {
  const { kolab, product, engineer } = await specAndBinding();
  // Alice's only other writer on the functional layer is her own agent, signed in as engineer.
  await people(kolab, 'alice-agent', { owner: 'alice', layers: ['functional'] });
  await kolab.openSession('alice-agent', 'engineer');
  const base = await serve(kolab);
  const alice = await signIn(base, product);
  const bob = await signIn(base, engineer);

  const submitted = (await alice.call<WebOutcome>('nodes/orders/submit', { base: 1, changes: [{ kind: 'add', element: 'R3', text: 'A cancellation is confirmed by email.' }] })).body;
  expect(submitted).toMatchObject({ ok: false, in_review: true, seq: 2, reviewers: [], note: expect.stringContaining(nobodyCanReview('functional')) });
  expect((await alice.call<WebNodeView>('nodes/orders')).body.in_review).toStrictEqual([expect.objectContaining({ seq: 2, reviewers: [], for_me: false })]);

  // The engineer reads the version in review and asks about its new element, from the page.
  expect((await bob.call<WebNodeView>('nodes/orders?version=2')).body.reading).toMatchObject({ seq: 2, state: 'in_review' });
  const asked = await bob.call<{ query: string }>('queries', { node: 'orders', seq: 2, element: 'R3', kind: 'question', text: 'Which email?' });
  expect(asked.body.query).toEqual(expect.any(String));
  const onR3 = (await alice.call<WebNodeView>('nodes/orders?version=2')).body.elements.find((e) => e.id === 'R3')!;
  expect(onR3.queries.map((q) => [q.id, q.state, q.address])).toStrictEqual([[asked.body.query, 'open', 'kj:orders@2#R3']]);

  // Abandoned, the version takes R3 with it: the question is withdrawn, saying why.
  expect((await alice.call('nodes/orders/versions/2/abandon', {})).body).toStrictEqual({ state: 'rejected' });
  const q = (await alice.call<{ queries: WebQuery[] }>('queries')).body.queries.find((x) => x.id === asked.body.query)!;
  expect(q).toMatchObject({ state: 'withdrawn', answer: "withdrawn: orders@2, which it was asked of, was abandoned, and R3 isn't in orders's latest committed version" });
});
