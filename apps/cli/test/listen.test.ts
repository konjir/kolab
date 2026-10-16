// Ending a session closes its subscriptions/listen streams, and nothing more is signalled to them (API4, D41).
import { afterAll, expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer, type KonjirServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { testStore } from '@konjir/engine/testing';

const ADMIN = 'listen-test-admin';
const INBOX = 'konjir://inbox/functional';

const open: { close(): Promise<void> }[] = [];
afterAll(async () => { for (const o of open.reverse()) await o.close().catch(() => undefined); });

async function boot() {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  open.push(server, admin);
  await call(admin, 'admin_add_actor', { id: 'lee' });
  return { server, admin };
}

async function agent(server: KonjirServer, admin: Client, id: string, role: 'product' | 'engineer', owner?: string) {
  await call(admin, 'admin_add_actor', { id, ...(owner && { owner }) });
  const { token } = await call(admin, 'admin_open_session', { actor: id, role }) as { token: string };
  const client = await connect(server.url, token);
  open.push(client);
  const updates: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', (n) => { updates.push(n.params.uri); });
  return { token, client, updates };
}

/** A spec the engineer can ask about, so each question changes the functional inbox. */
async function spec(pm: Client) {
  await call(pm, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
}

async function until(what: string, check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** How a subscription closed, or 'open' if it is still open after `ms`. */
const settled = (closed: Promise<unknown>, ms: number) =>
  Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), ms).unref())]);

test('ending a session closes its listen streams promptly; other sessions, of the same owner too, keep hearing', async () => {
  const { server, admin } = await boot();
  const ended = await agent(server, admin, 'lee-pm', 'product', 'lee');
  const sibling = await agent(server, admin, 'lee-pm-2', 'product', 'lee');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(ended.client);

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

test('a session ended without an event hears nothing more: the next update closes its stream instead', async () => {
  const { server, admin } = await boot();
  const pm = await agent(server, admin, 'pm', 'product');
  const other = await agent(server, admin, 'pm-2', 'product', 'lee');
  const eng = await agent(server, admin, 'eng', 'engineer');
  await spec(pm.client);
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
