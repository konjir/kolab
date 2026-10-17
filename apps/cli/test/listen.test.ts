// Ending a session closes its subscriptions/listen streams, and nothing more is signalled to them (API4, D41).
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer, type KonjirServer } from '@konjir/server';
import { connect, call, listenRefusal } from '../src/cli.js';
import { closeAtEnd, testStore } from '@konjir/engine/testing';

const ADMIN = 'listen-test-admin';
const INBOX = 'konjir://inbox/functional';

async function boot() {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_actor', { id: 'lee' });
  await call(admin, 'admin_add_organization', { id: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_grant', { kolab: 'test', to: 'lee', level: 'write' });
  // Lee holds Write on the functional layer, so she is a reviewer of every spec here (W1.6).
  const { token } = await call(admin, 'admin_open_session', { actor: 'lee', role: 'product' }) as { token: string };
  lee = await connect(server.url, token);
  closeAtEnd(lee);
  return { server, admin };
}

/** Lee's product session, which approves the specs the tests write. */
let lee: Client | undefined;

async function agent(server: KonjirServer, admin: Client, id: string, role: 'product' | 'engineer', owner?: string) {
  await call(admin, 'admin_add_actor', { id, ...(owner && { owner }) });
  await call(admin, 'admin_grant', { kolab: 'test', to: id, level: 'write', layers: [role === 'product' ? 'functional' : 'technical'] });
  const { token } = await call(admin, 'admin_open_session', { actor: id, role }) as { token: string };
  const client = await connect(server.url, token);
  closeAtEnd(client);
  const updates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', (n) => { updates.push(n.params.uri); });
  return { token, client, updates };
}

/**
 * A spec the engineer can ask about, so each question changes the functional inbox. It waits in
 * review, and `reviewer`, or Lee, approves it (W1.6).
 */
async function spec(pm: Client, reviewer?: Client) {
  await call(pm, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  const r = await call(reviewer ?? lee!, 'review', { node: 'orders', version: 1, verdict: 'approve' }) as { ok: boolean };
  if (!r.ok) throw new Error('the spec did not commit');
}

async function until(what: string, check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A listen stream opened by hand, with whatever Authorization header the test gives. */
async function rawListen(url: string, authorization: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'raw:1', method: 'subscriptions/listen',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} }, notifications: { resourceSubscriptions: [INBOX] } },
    }),
  });
  const frames: string[] = [];
  let ended = false;
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) { frames.push(buffer.slice(0, i)); buffer = buffer.slice(i + 2); }
    }
    ended = true;
  })().catch(() => { ended = true; });
  const data = () => frames.filter((f) => !f.startsWith(':')).map((f) => JSON.parse(f.replace(/^event: message\ndata: /, '')) as { method?: string; id?: string; result?: unknown });
  return { status: res.status, data, ended: () => ended, done };
}

/** How a subscription closed, or 'open' if it is still open after `ms`. */
const settled = (closed: Promise<unknown>, ms: number) =>
  Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), ms).unref())]);

test('ending a session closes its listen streams promptly; other sessions, of the same owner too, keep hearing', async () => {
  const { server, admin } = await boot();
  const ended = await agent(server, admin, 'lee-pm', 'product', 'lee');
  const sibling = await agent(server, admin, 'lee-pm-2', 'product', 'lee');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(ended.client, sibling.client);

  // The session to be ended listens twice; its sibling, an agent of the same person, once.
  const first = await ended.client.listen({ resourceSubscriptions: [INBOX] });
  const second = await ended.client.listen({ resourceSubscriptions: [INBOX] });
  const kept = await sibling.client.listen({ resourceSubscriptions: [INBOX] });
  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await until('both sessions to hear the question', () => ended.updates.length === 2 && sibling.updates.length === 1);

  // Ending it closes both of its streams at once, as the server closing the subscription.
  const t0 = Date.now();
  await call(admin, 'admin_end_session', { token: ended.token });
  expect(await settled(first.closed, 2000)).toBe('graceful');
  expect(await settled(second.closed, 2000)).toBe('graceful');
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(await settled(kept.closed, 100)).toBe('open');

  // Later changes reach the sibling and nobody else.
  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'And refunds?' });
  await until('the sibling to hear the next question', () => sibling.updates.length === 2);
  await new Promise((r) => setTimeout(r, 200));
  expect(ended.updates).toStrictEqual([INBOX, INBOX]);
  expect(sibling.updates).toStrictEqual([INBOX, INBOX]);

  // The ended token can't listen again: a new request with it is refused with 401.
  const listen = await fetch(server.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ended.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'listen:9', method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: [INBOX] } } }),
  });
  expect(listen.status).toBe(401);
  await listen.body?.cancel();
  await expect(connect(server.url, ended.token)).rejects.toThrow(/401|invalid_token|Unauthorized/i);
  await expect(ended.client.listen({ resourceSubscriptions: [INBOX] })).rejects.toThrow();

  await kept.close();
  await server.close();
});

/** Ends the next session whose token is checked, right after that check: between a request's auth and its listen gate. */
function endAfterAuth(server: KonjirServer) {
  const kolab = server.kolab;
  const sessionOpen = kolab.sessionOpen.bind(kolab);
  kolab.sessionOpen = async (id) => {
    const open = await sessionOpen(id);
    kolab.sessionOpen = sessionOpen;
    await kolab.db.query(`update session set ended_at = now() where id = $1`, [id]);
    return open;
  };
}

test('a listen stream opened with a session that has ended is refused in-band, as session_ended', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const pm2 = await agent(server, admin, 'pm-2', 'product');
  await spec(pm.client, pm2.client);

  endAfterAuth(server);
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pm.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'raw:2', method: 'subscriptions/listen',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} }, notifications: { resourceSubscriptions: [INBOX] } },
    }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text.startsWith('{') ? text : text.replace(/^event: message\ndata: /, '').trim()) as { id: string; error?: { code: number; data?: { reason?: string } } };
  expect(body).toMatchObject({ id: 'raw:2', error: { code: -32003, data: { reason: 'session_ended' } } });

  // The SDK client sees the same refusal, with its code and reason.
  endAfterAuth(server);
  const refused = await pm2.client.listen({ resourceSubscriptions: [INBOX] }).then(() => undefined, (e: unknown) => e);
  expect(refused).toMatchObject({ code: -32003, data: { reason: 'session_ended' } });
  expect(listenRefusal(refused)).toBe('session_ended');
  await server.close();
});

test('a listen stream whose session can\'t be checked is refused as gate_failed, with no token in the log', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const kolab = server.kolab;
  const sessionOpen = kolab.sessionOpen.bind(kolab);
  let calls = 0;
  kolab.sessionOpen = async (id) => {
    if (++calls === 2) { kolab.sessionOpen = sessionOpen; throw new Error(`connection terminated while checking ${id}`); }
    return sessionOpen(id);
  };
  const warned: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown) => { warned.push(String(chunk)); return true; };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  let refused: unknown;
  try {
    refused = await pm.client.listen({ resourceSubscriptions: [INBOX] }).then(() => undefined, (e: unknown) => e);
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
  }
  expect(refused).toMatchObject({ code: -32003, data: { reason: 'gate_failed' } });
  expect(listenRefusal(refused)).toBe('gate_failed');
  expect(warned.join('')).toMatch(/listen-stream gate failed/);
  expect(warned.join('')).not.toContain(pm.token);

  // A retry opens it.
  const sub = await pm.client.listen({ resourceSubscriptions: [INBOX] });
  await sub.close();
  await server.close();
});

test('a session ended without an event hears nothing more: the next update closes its stream instead', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const other = await agent(server, admin, 'pm-2', 'product', 'lee');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(pm.client, other.client);
  const sub = await pm.client.listen({ resourceSubscriptions: [INBOX] });
  const kept = await other.client.listen({ resourceSubscriptions: [INBOX] });

  // Ended straight in the database, as an expiry would: no event, so the stream stays open until it would be signalled.
  await server.kolab.db.query(`update session set ended_at = now() where id = $1`, [pm.token]);
  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  expect(await settled(sub.closed, 2000)).toBe('graceful');
  await until('the other session to hear the question', () => other.updates.length === 1);
  expect(pm.updates).toStrictEqual([]);
  expect(await settled(kept.closed, 100)).toBe('open');

  await kept.close();
  await server.close();
});

test('ending a session that is not listening, or one already ended, closes nothing else', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(pm.client);
  const sub = await pm.client.listen({ resourceSubscriptions: [INBOX] });

  await call(admin, 'admin_end_session', { token: eng.token });
  await call(admin, 'admin_end_session', { token: eng.token });
  await call(admin, 'admin_end_session', { token: 'kjs_no-such-session' });
  expect(await settled(sub.closed, 200)).toBe('open');

  const eng2 = await agent(server, admin, 'eng-2', 'engineer');
  await call(eng2.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await until('the listener to hear the question', () => pm.updates.length === 1);
  await sub.close();
  await server.close();
});

test('a stream is tracked under the token auth verified, however the header is written', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(pm.client);

  // Kolab's auth takes the second word of the header and ignores the rest.
  const odd = await rawListen(server.url, `Bearer ${pm.token} trailing`);
  expect(odd.status).toBe(200);
  await until('the acknowledgement', () => odd.data().some((m) => m.method === 'notifications/subscriptions/acknowledged'));
  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await until('the first update', () => odd.data().some((m) => m.method === 'notifications/resources/updated'));

  await call(admin, 'admin_end_session', { token: pm.token });
  await until('the stream to close', () => odd.ended(), 2000);
  const messages = odd.data();
  expect(messages.map((m) => m.method ?? `result ${m.id}`)).toStrictEqual([
    'notifications/subscriptions/acknowledged', 'notifications/resources/updated', 'result raw:1',
  ]);
  expect(messages[2].result).toMatchObject({ resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'konjir' } } });
  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'And refunds?' });
  await new Promise((r) => setTimeout(r, 200));
  expect(odd.data().length).toBe(3);
  await server.close();
});

test('each change checks every listening session in one query, however many streams there are', async () => {
  const { server, admin } = await boot();
  const eng = await agent(server, admin, 'eng', 'engineer');
  const listeners: Awaited<ReturnType<typeof agent>>[] = [];
  for (let i = 0; i < 4; i++) listeners.push(await agent(server, admin, `pm-${i}`, 'product', 'lee'));
  await spec(listeners[0].client, listeners[1].client);
  for (const l of listeners) for (let j = 0; j < 3; j++) await l.client.listen({ resourceSubscriptions: [INBOX] });

  const kolab = server.kolab;
  const counts = { openSessions: 0, sessionOpen: 0 };
  const openSessions = kolab.openSessions.bind(kolab);
  const sessionOpen = kolab.sessionOpen.bind(kolab);
  kolab.openSessions = (ids) => { counts.openSessions++; return openSessions(ids); };
  kolab.sessionOpen = (id) => { counts.sessionOpen++; return sessionOpen(id); };

  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await until('all 12 streams to hear it', () => listeners.every((l) => l.updates.length === 3));
  expect(counts.openSessions).toBe(1);
  expect(counts.sessionOpen).toBe(1); // the asker's own auth check, nothing per stream
  await server.close();
});

test('a failed session check holds back that one change, and closes no stream', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(pm.client);
  const sub = await pm.client.listen({ resourceSubscriptions: [INBOX] });

  const kolab = server.kolab;
  const openSessions = kolab.openSessions.bind(kolab);
  kolab.openSessions = async () => { kolab.openSessions = openSessions; throw new Error('connection terminated unexpectedly'); };
  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await new Promise((r) => setTimeout(r, 200));
  expect(pm.updates).toStrictEqual([]);
  expect(await settled(sub.closed, 100)).toBe('open');

  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'And refunds?' });
  await until('the next change', () => pm.updates.length === 1);
  await sub.close();
  await server.close();
});
