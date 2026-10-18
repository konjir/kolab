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
import type { WebEvent, WebMark, WebNodeView, WebOutcome, WebOverview, WebQuery } from '@konjir/types';
import { startServer } from '../src/server.js';

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
  expect(overview.counts).toStrictEqual({ stale: 0, waiting: 1, reviews: 0, open: 1 });
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
  expect(activity.map((a) => `${a.actor} ${a.text}`)).toEqual(expect.arrayContaining([expect.stringMatching(/^alice committed kj:orders@2/), 'bob left a note on kj:orders@2#R2']));
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
  expect((await theirs.call(`queries/${q}/answer`, { answer: 'mine now' })).status).toBe(403);
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
  const { kolab } = await setup();
  const base = await serve(kolab, { webRoot: root });

  const page = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  expect([page.status, await page.text()]).toStrictEqual([200, '<!doctype html><title>Kolab</title>']);
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  const deep = await fetch(`${base}/questions`, { headers: { accept: 'text/html' } });
  expect(await deep.text()).toContain('<title>Kolab</title>');
  const asset = await fetch(`${base}/assets/app-abc123.js`);
  expect([asset.status, asset.headers.get('cache-control')]).toStrictEqual([200, 'public, max-age=31536000, immutable']);
  expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  const api = await fetch(`${base}/api/nowhere`, { headers: { accept: 'text/html' } });
  expect([api.status, await api.text()]).toStrictEqual([404, expect.not.stringContaining('<title>')]);
  expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');

  const { kolab: other } = await setup();
  const unbuilt = await serve(other, { webRoot: null });
  const none = await fetch(`${unbuilt}/`, { headers: { accept: 'text/html' } });
  expect([none.status, await none.text()]).toStrictEqual([503, expect.stringContaining('npx nx run @konjir/web:build')]);
});
