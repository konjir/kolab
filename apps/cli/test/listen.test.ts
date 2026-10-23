// Ending a session closes its subscriptions/listen streams, and nothing more is signalled to them (API4, D41).
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer, type KonjirServer } from '@konjir/server';
import { connect, call, listenRefusal } from '../src/cli.js';
import { sessionKey } from '@konjir/engine';
import { closeAtEnd, testStore } from '@konjir/engine/testing';

const ADMIN = 'listen-test-admin';
const INBOX = 'konjir://inbox/test/functional';

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

test('archiving closes the listen streams of every session it ends: a person\'s and their agents\', then a whole kolab\'s (D52)', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'lee-pm', 'product', 'lee');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(pm.client);
  const pmStream = await pm.client.listen({ resourceSubscriptions: [INBOX] });
  const leeStream = await lee!.listen({ resourceSubscriptions: [INBOX] });
  const engStream = await eng.client.listen({ resourceSubscriptions: [INBOX] });

  // Lee, a person: her session and her agent's end, and their streams close; the engineer's stays.
  expect(await call(admin, 'admin_archive', { actor: 'lee' })).toStrictEqual({ archived: { actor: 'lee' }, with_kolabs: [], with_agents: ['lee-pm'], ended_sessions: 2 });
  expect(await settled(pmStream.closed, 2000)).toBe('graceful');
  expect(await settled(leeStream.closed, 2000)).toBe('graceful');
  expect(await settled(engStream.closed, 100)).toBe('open');
  await expect(connect(server.url, pm.token)).rejects.toThrow(/401|invalid_token|Unauthorized/i);
  await expect(call(admin, 'admin_open_session', { actor: 'lee-pm', role: 'product' })).rejects.toThrow(/lee-pm's owner lee is archived/);
  expect(await call(admin, 'admin_list_actors', {})).toMatchObject({ actors: [{ id: 'eng' }] });
  expect((await call(admin, 'admin_list_actors', { archived: true }) as { actors: { id: string; archived: boolean }[] }).actors
    .map((a) => [a.id, a.archived])).toStrictEqual([['eng', false], ['lee', true], ['lee-pm', true]]);

  // The kolab: everyone left in it is ended, and it leaves the listing but for archived=true.
  expect(await call(admin, 'admin_archive', { kolab: 'test' })).toMatchObject({ archived: { kolab: 'test' }, ended_sessions: 1 });
  expect(await settled(engStream.closed, 2000)).toBe('graceful');
  expect(await call(admin, 'admin_list_kolabs', {})).toStrictEqual({ kolabs: [], next: null });
  expect(await call(admin, 'admin_list_kolabs', { archived: true })).toMatchObject({ kolabs: [{ id: 'test', archived: true }] });
  await expect(call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' })).rejects.toThrow(/the kolab name test is taken: kolab names are unique across all of Konjir. The archived kolab test holds it, and an archived name stays reserved: konjir_admin_unarchive kolab=test restores it/);
  await expect(call(admin, 'admin_archive', { kolab: 'test', actor: 'eng' })).rejects.toThrow(/name exactly one of kolab, organization or actor/);
  await expect(call(admin, 'admin_archive', {})).rejects.toThrow(/name exactly one of kolab, organization or actor/);

  // Unarchived, it works as before with new sessions.
  expect(await call(admin, 'admin_unarchive', { kolab: 'test' })).toStrictEqual({ unarchived: { kolab: 'test' }, with_kolabs: [], with_agents: [] });
  const { token, kolab } = await call(admin, 'admin_open_session', { actor: 'eng', role: 'engineer' }) as { token: string; kolab: string };
  expect(kolab).toBe('test');
  const again = await connect(server.url, token);
  closeAtEnd(again);
  expect(await call(again, 'whoami')).toMatchObject({ actor: 'eng', kolab: 'test' });
  await expect(call(again, 'admin_archive', { kolab: 'test' })).rejects.toThrow(/konjir_admin_archive is an admin verb/);
});

/** Ends the next session whose token is checked, right after that check: between a request's auth (liveSession) and its listen gate. */
function endAfterAuth(server: KonjirServer) {
  const kolab = server.kolab;
  const liveSession = kolab.liveSession.bind(kolab);
  kolab.liveSession = async (id) => {
    const live = await liveSession(id);
    kolab.liveSession = liveSession;
    await kolab.db.query(`update session set ended_at = now(), ended_by = 'admin' where id = $1`, [sessionKey(id)]);
    return live;
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
  // The first check is the listen gate's: the request's own auth checks the token with liveSession.
  kolab.sessionOpen = async (id) => {
    if (++calls === 1) { kolab.sessionOpen = sessionOpen; throw new Error(`connection terminated while checking ${id}`); }
    return sessionOpen(id);
  };
  const warned: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown) => { warned.push(String(chunk)); return true; };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  // Kolab's JSON log lines go through the console (P11, D68), which Jest buffers apart from the streams.
  const consoles = { warn: console.warn, error: console.error };
  console.warn = console.error = (m: unknown) => { capture(`${String(m)}\n`); };
  let refused: unknown;
  try {
    refused = await pm.client.listen({ resourceSubscriptions: [INBOX] }).then(() => undefined, (e: unknown) => e);
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
    Object.assign(console, consoles);
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
  await server.kolab.db.query(`update session set ended_at = now(), ended_by = 'admin' where id = $1`, [sessionKey(pm.token)]);
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
  // Ending it again, or a session that never was, is an error, and closes nothing.
  await expect(call(admin, 'admin_end_session', { token: eng.token })).rejects.toThrow(/no open session matched/);
  await expect(call(admin, 'admin_end_session', { token: 'kjs_no-such-session' })).rejects.toThrow(/no open session matched/);
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
  const counts = { openSessions: 0, liveSession: 0, sessionOpen: 0 };
  const openSessions = kolab.openSessions.bind(kolab);
  const liveSession = kolab.liveSession.bind(kolab);
  const sessionOpen = kolab.sessionOpen.bind(kolab);
  kolab.openSessions = (ids) => { counts.openSessions++; return openSessions(ids); };
  kolab.liveSession = (id) => { counts.liveSession++; return liveSession(id); };
  kolab.sessionOpen = (id) => { counts.sessionOpen++; return sessionOpen(id); };

  await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await until('all 12 streams to hear it', () => listeners.every((l) => l.updates.length === 3));
  expect(counts.openSessions).toBe(1);
  expect(counts.liveSession).toBe(1); // the asker's own auth check, nothing per stream
  expect(counts.sessionOpen).toBe(0);
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

/** A session in a second kolab, `other`, with Write on `role`'s layer there. */
async function inOther(admin: Client, server: KonjirServer, id: string, role: 'product' | 'engineer') {
  await call(admin, 'admin_add_kolab', { name: 'other', owner: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_add_actor', { id });
  await call(admin, 'admin_grant', { kolab: 'other', to: id, level: 'write', layers: [role === 'product' ? 'functional' : 'technical'] });
  const { token } = await call(admin, 'admin_open_session', { actor: id, role, kolab: 'other' }) as { token: string };
  const client = await connect(server.url, token);
  closeAtEnd(client);
  const updates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', (n) => { updates.push(n.params.uri); });
  return { token, client, updates };
}

test('a change in one kolab wakes its own subscribers and no other kolab\'s', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const eng = await agent(server, admin, 'eng', 'engineer');
  const otherPm = await inOther(admin, server, 'other-pm', 'product');
  const otherEng = await inOther(admin, server, 'other-eng', 'engineer');
  await spec(pm.client);
  // In the other kolab, its product agent is alone on its layer, so the checks alone commit its spec (W1.6).
  await call(otherPm.client, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(otherPm.client, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(otherPm.client, 'submit_for_review', { node: 'orders', version: 1 });

  // Each listens to what whoami lists for it: its own kolab's.
  const subscribe = async (c: Client) => (await call(c, 'whoami') as { subscribe: string[] }).subscribe;
  expect(await subscribe(otherPm.client)).toStrictEqual(['konjir://inbox/other/functional', 'konjir://answers/other/other-pm']);
  for (const c of [pm, eng, otherPm, otherEng]) await c.client.listen({ resourceSubscriptions: await subscribe(c.client) });

  const { query } = await call(eng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' }) as { query: string };
  await call(pm.client, 'answer_query', { query, answer: 'Any before Completed.' });
  await until('the test kolab to hear both', () => pm.updates.length === 2 && eng.updates.length === 1);
  await new Promise((r) => setTimeout(r, 200));
  expect(pm.updates).toStrictEqual([INBOX, INBOX]);
  expect(eng.updates).toStrictEqual(['konjir://answers/test/eng']);
  expect([otherPm.updates, otherEng.updates]).toStrictEqual([[], []]);

  await call(otherEng.client, 'ask', { address: 'kj:orders#R8', question: 'Which statuses?' });
  await until('the other kolab to hear it', () => otherPm.updates.length === 1);
  await new Promise((r) => setTimeout(r, 200));
  expect(otherPm.updates).toStrictEqual(['konjir://inbox/other/functional']);
  expect([pm.updates.length, eng.updates.length]).toStrictEqual([2, 1]);
  await server.close();
});

test('a session may listen to and read only its own kolab\'s inboxes and its own answers there', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const otherPm = await inOther(admin, server, 'other-pm', 'product');
  await spec(pm.client);

  // Another kolab's inbox, a release before D50's per-layer inbox, and another actor's answers are each refused in-band.
  for (const uri of [INBOX, 'konjir://inbox/functional', 'konjir://answers/other/pm', 'konjir://inbox/other/nonsense']) {
    const refused = await otherPm.client.listen({ resourceSubscriptions: ['konjir://inbox/other/functional', uri] }).then(() => undefined, (e: unknown) => e);
    expect(refused).toMatchObject({ code: -32003, data: { reason: 'not_subscribable' } });
    expect(listenRefusal(refused)).toBe('not_subscribable');
  }
  // Nothing about the other kolab is in the refusal.
  const raw = await fetch(server.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${otherPm.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'raw:3', method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: [INBOX] } } }),
  });
  const body = await raw.json() as { id: string; error: { code: number; data: { reason: string } } };
  expect(body).toMatchObject({ id: 'raw:3', error: { code: -32003, data: { reason: 'not_subscribable' } } });
  expect(JSON.stringify(body)).not.toMatch(/orders|pm\b|kjs_/);

  // Its own still open, and the refused tries closed nothing.
  const own = await otherPm.client.listen({ resourceSubscriptions: ['konjir://inbox/other/functional', 'konjir://inbox/other/technical', 'konjir://answers/other/other-pm'] });
  expect(await settled(own.closed, 100)).toBe('open');

  // Reading another kolab's inbox is as if it didn't exist; another kolab's answers, or another actor's, are refused.
  await expect(otherPm.client.readResource({ uri: INBOX })).rejects.toThrow(/no inbox/);
  await expect(otherPm.client.readResource({ uri: 'konjir://answers/test/other-pm' })).rejects.toThrow(/your own answers/);
  await expect(pm.client.readResource({ uri: 'konjir://answers/other/other-pm' })).rejects.toThrow(/your own answers/);
  const mine = JSON.parse(((await otherPm.client.readResource({ uri: 'konjir://inbox/other/functional' })).contents[0] as { text: string }).text) as { kolab: string; queries: unknown[] };
  expect(mine).toMatchObject({ kolab: 'other', queries: [] });

  // The admin token, which belongs to no kolab, may listen to any.
  const any = await admin.listen({ resourceSubscriptions: [INBOX, 'konjir://inbox/other/functional'] });
  expect(await settled(any.closed, 100)).toBe('open');
  await own.close(); await any.close();
  await server.close();
});

/** A POST to the MCP endpoint, by hand, with the headers the test gives. */
async function post(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = (() => { try { return JSON.parse(text.startsWith('{') ? text : text.replace(/^event: message\ndata: /, '').trim()); } catch { return text; } })();
  return { status: res.status, body: json as { id?: unknown; error?: { code: number; message?: string; data?: { reason?: string } } } };
}
const LISTEN_HEADERS = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen' };
const listenBody = (id: unknown, uris: string[]) => ({
  jsonrpc: '2.0', id, method: 'subscriptions/listen',
  params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} }, notifications: { resourceSubscriptions: uris } },
});

test('the listen scope answers nothing the transport would refuse first: a blocked origin, or a request with no valid id', async () => {
  const { server, admin } = await boot();
  const otherPm = await inOther(admin, server, 'other-pm', 'product');
  const auth = { authorization: `Bearer ${otherPm.token}` };
  // A foreign origin gets the transport's 403, whatever it asks for: no lookup, no in-band answer.
  const blocked = await post(server.url, { ...auth, ...LISTEN_HEADERS, origin: 'https://evil.example' }, listenBody('o:1', [INBOX]));
  expect(blocked.status).toBe(403);
  expect(JSON.stringify(blocked.body)).not.toMatch(/not_subscribable/);
  // A listen whose id is no JSON-RPC id is the transport's to refuse, as an invalid request.
  const badId = await post(server.url, { ...auth, ...LISTEN_HEADERS }, listenBody({ a: 1 }, [INBOX]));
  expect(badId.status).toBe(400);
  expect(JSON.stringify(badId.body)).not.toMatch(/not_subscribable/);
  await server.close();
});

test('a session lookup that hangs refuses the listen stream in-band as gate_timeout', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const kolab = server.kolab;
  const sessionScope = kolab.sessionScope.bind(kolab);
  kolab.sessionScope = () => { kolab.sessionScope = sessionScope; return new Promise(() => undefined); };
  const t0 = Date.now();
  const refused = await pm.client.listen({ resourceSubscriptions: [INBOX] }).then(() => undefined, (e: unknown) => e);
  expect(listenRefusal(refused)).toBe('gate_timeout');
  expect(Date.now() - t0).toBeLessThan(15_000);
  const sub = await pm.client.listen({ resourceSubscriptions: [INBOX] });   // a retry opens it
  await sub.close();
  await server.close();
}, 30_000);

// The listen scope covers subscriptions/listen alone, which is enough only because the transport
// is stateless: a 2025-era resources/subscribe needs a session, and would bypass it. If someone
// turns sessions on (McpHttpModule's `session`), this fails, and the scope must cover that too.
test('the transport is stateless: a 2025-era resources/subscribe, for any kolab, is refused', async () => {
  const { server, admin } = await boot();
  const otherPm = await inOther(admin, server, 'other-pm', 'product');
  for (const uri of [INBOX, 'konjir://inbox/other/functional']) {
    const r = await post(server.url, { authorization: `Bearer ${otherPm.token}`, 'mcp-protocol-version': '2025-06-18' },
      { jsonrpc: '2.0', id: 'legacy:1', method: 'resources/subscribe', params: { uri } });
    expect(r.body).toMatchObject({ error: { code: -32601 } });
  }
  await server.close();
});

test('a malformed kolab in an inbox or answers URI reads as no inbox, like any other wrong one', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  await expect(pm.client.readResource({ uri: 'konjir://inbox/%E0/functional' })).rejects.toThrow(/no inbox/);
  await expect(pm.client.readResource({ uri: 'konjir://answers/%E0/pm' })).rejects.toThrow(/your own answers/);
  await server.close();
});
