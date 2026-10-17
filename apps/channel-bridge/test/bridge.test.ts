// The bridge's Kolab side in-process, for what a child process can't show: a Kolab that
// stops answering, and how fast stop() returns.
import { expect, test } from '@jest/globals';
import { createServer, type Socket } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '@konjir/server';
import { closeAtEnd, testStore } from '@konjir/engine/testing';
import { KolabBridge } from '../src/bridge.js';
import type { ChannelMessage } from '../src/messages.js';

const ADMIN = 'bridge-test-admin';

async function until(what: string, check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function agentToken(url: string) {
  const admin = new Client({ name: 't', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await admin.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${ADMIN}` } } }));
  await admin.callTool({ name: 'konjir_admin_add_actor', arguments: { id: 'pm' } });
  await admin.callTool({ name: 'konjir_admin_add_kolab', arguments: { name: 'test', owner: 'pm' } });
  const r = await admin.callTool({ name: 'konjir_admin_open_session', arguments: { actor: 'pm', role: 'product' } });
  await admin.close();
  return (r.structuredContent as { token: string }).token;
}

test('a Kolab that stops answering is reconnected to', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  closeAtEnd(server);
  const token = await agentToken(server.url);
  // Liveness checks hang while `deaf` is set, as they would on a half-open connection.
  let deaf = false;
  const fetchStub: typeof fetch = (input, init) => {
    if (deaf && typeof init?.body === 'string' && init.body.includes('"name":"konjir_whoami"')) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return fetch(input, init);
  };
  const logs: string[] = [];
  const messages: ChannelMessage[] = [];
  let listens = 0;
  const bridge = new KolabBridge({
    url: server.url, token, fetch: fetchStub as never,
    forward: async (m) => { messages.push(m); },
    log: (l) => logs.push(l),
    backoff: { initialMs: 300, maxMs: 600 },
    liveness: { intervalMs: 100, timeoutMs: 200 },
  });
  bridge.onListening = () => { listens++; };
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  await until('the first listen', () => listens === 1);
  await new Promise((r) => setTimeout(r, 400)); // checks answered: still on the first connection
  expect(listens).toBe(1);
  deaf = true;
  await until('the failed check', () => logs.some((l) => /stopped answering; reconnecting/.test(l)));
  deaf = false;
  await until('the reconnect', () => listens === 2);
  expect(logs.filter((l) => /reconnected to Kolab/.test(l)).length).toBeGreaterThanOrEqual(1);
  expect(messages).toStrictEqual([]);
  await bridge.stop();
  await server.close();
});

test('stop() returns promptly while a request to Kolab hangs', async () => {
  // A server that accepts connections and never answers.
  const sockets: Socket[] = [];
  const silent = createServer((s) => { sockets.push(s); });
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  const port = (silent.address() as { port: number }).port;
  const logs: string[] = [];
  const bridge = new KolabBridge({ url: `http://127.0.0.1:${port}/mcp`, token: 'kjs_x', forward: async () => undefined, log: (l) => logs.push(l) });
  bridge.start();
  await until('the connection', () => sockets.length > 0);
  const t0 = Date.now();
  await bridge.stop();
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(logs).toStrictEqual([]);
  for (const s of sockets) s.destroy();
  await new Promise((r) => silent.close(r));
});

/**
 * A fetch that marks each subscriptions/listen request, and a Kolab whose session check does
 * `atGate` to the check that request's listen gate makes: the second after the mark, the first
 * being the request's own auth.
 */
function atListenGate(server: Awaited<ReturnType<typeof startServer>>, atGate: (id: string, check: (id: string) => Promise<boolean>) => Promise<boolean>) {
  let checks = -1;
  const kolab = server.kolab;
  const sessionOpen = kolab.sessionOpen.bind(kolab);
  kolab.sessionOpen = async (id) => {
    if (checks >= 0 && ++checks === 2) { checks = -1; kolab.sessionOpen = sessionOpen; return atGate(id, sessionOpen); }
    return sessionOpen(id);
  };
  const fetchStub: typeof fetch = (input, init) => {
    if (typeof init?.body === 'string' && init.body.includes('"method":"subscriptions/listen"') && kolab.sessionOpen !== sessionOpen) checks = 0;
    return fetch(input, init);
  };
  return fetchStub;
}

test('a listen refused in-band as session_ended is the token refused, not Kolab unreachable', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  closeAtEnd(server);
  const token = await agentToken(server.url);
  // The session ends between the listen request's auth and its gate.
  const fetchStub = atListenGate(server, async (id, check) => {
    await server.kolab.db.query(`update session set ended_at = now() where id = $1`, [id]);
    return check(id);
  });
  const logs: string[] = [];
  const messages: ChannelMessage[] = [];
  const bridge = new KolabBridge({
    url: server.url, token, fetch: fetchStub as never,
    forward: async (m) => { messages.push(m); }, log: (l) => logs.push(l),
    backoff: { initialMs: 100, maxMs: 200 },
  });
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  await until('the refusal', () => logs.some((l) => /refused the token/.test(l)));
  await bridge.stop();
  expect(logs.filter((l) => /cannot reach|couldn't open/.test(l))).toStrictEqual([]);
  expect(messages.map((m) => m.meta.status)).toStrictEqual(['refused']);
  await server.close();
});

test('a listen refused in-band because the session couldn\'t be checked is retried', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  closeAtEnd(server);
  const token = await agentToken(server.url);
  const fetchStub = atListenGate(server, async () => { throw new Error('connection terminated unexpectedly'); });
  const logs: string[] = [];
  let listens = 0;
  const bridge = new KolabBridge({
    url: server.url, token, fetch: fetchStub as never,
    forward: async () => undefined, log: (l) => logs.push(l),
    backoff: { initialMs: 100, maxMs: 200 },
  });
  bridge.onListening = () => { listens++; };
  closeAtEnd({ close: () => bridge.stop() });
  bridge.start();
  await until('the retried listen', () => listens === 1);
  expect(logs.some((l) => /couldn't open the subscription just now \(gate_failed\); retrying/.test(l))).toBe(true);
  expect(logs.filter((l) => /refused the token|cannot reach/.test(l))).toStrictEqual([]);
  await bridge.stop();
  await server.close();
});
