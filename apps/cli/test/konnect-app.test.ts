// The tools konnect's phone app needs (docs/plans/konnect-mobile.md, S2 to S5), over MCP as the app
// calls them: what each takes and returns, and what each refuses.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

/** Ann owns `hub`; Bo writes there, and so does his agent bo-claude. Each has a session there. */
async function hub(opts: Partial<Parameters<typeof startServer>[0]> = {}) {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()), ...opts });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  for (const id of ['ann', 'bo']) await call(admin, 'admin_add_actor', { id });
  await call(admin, 'admin_add_actor', { id: 'bo-claude', owner: 'bo' });
  await call(admin, 'admin_add_kolab', { name: 'hub', owner: 'ann' });
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'bo', level: 'write' });
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'bo-claude', level: 'write' });
  const session = async (actor: string, kolab = 'hub') => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'engineer', kolab }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  return { server, admin, session, ann: await session('ann'), bo: await session('bo'), agent: await session('bo-claude') };
}

type Sent = { sent: { id: string } };

test('mark_channel_read and mark_messages_read move the caller\'s own read state forward, and refuse an id outside the channel or conversation', async () => {
  const { ann, bo, agent } = await hub();
  const c1 = (await call(ann, 'send_channel_message', { channel: 'general', message: 'one' }) as Sent).sent.id;
  const c2 = (await call(ann, 'send_channel_message', { channel: 'general', message: 'two' }) as Sent).sent.id;
  expect(await call(bo, 'mark_channel_read', { channel: '#general', up_to: c1 })).toStrictEqual({ channel: 'general', read_to: c1, moved: true });
  expect(await call(bo, 'mark_channel_read', { channel: 'general', up_to: c1 })).toStrictEqual({ channel: 'general', read_to: c1, moved: false });
  expect(await call(agent, 'mark_channel_read', { channel: 'general', up_to: c2 })).toStrictEqual({ channel: 'general', read_to: c2, moved: true });
  expect(((await call(bo, 'read_channel', { channel: 'general' })) as { messages: { id: string }[] }).messages.map((m) => m.id)).toStrictEqual([c2]);

  const d1 = (await call(ann, 'send_message', { to: 'bo', message: 'hi' }) as Sent).sent.id;
  const d2 = (await call(ann, 'send_message', { to: 'bo', message: 'there' }) as Sent).sent.id;
  const toAgent = (await call(ann, 'send_message', { to: 'bo-claude', message: 'for you' }) as Sent).sent.id;
  expect(await call(bo, 'mark_messages_read', { with: 'ann', up_to: d1 })).toStrictEqual({ with: 'ann', up_to: d1, marked: 1 });
  expect(await call(agent, 'mark_messages_read', { with: 'ann', up_to: toAgent })).toStrictEqual({ with: 'ann', up_to: toAgent, marked: 1 });

  // Another's conversation, a channel message, another channel's message: refused, and nothing changes.
  expect(await rejection(call(bo, 'mark_messages_read', { with: 'ann', up_to: toAgent }))).toMatch(/up_to names no message between you and ann/);
  expect(await rejection(call(bo, 'mark_messages_read', { with: 'ann', up_to: c1 }))).toMatch(/up_to names no message between you and ann/);
  expect(await rejection(call(bo, 'mark_channel_read', { channel: 'general', up_to: d2 }))).toMatch(/up_to names no message of #general/);
  expect(await rejection(call(bo, 'mark_channel_read', { channel: 'general' }))).toMatch(/up_to/);
  expect(await rejection(call(bo, 'mark_messages_read', { with: 'ann', up_to: d2, from: 'x' }))).toMatch(/unknown argument from/);
  expect(((await call(bo, 'read_messages', {})) as { messages: { id: string }[] }).messages.map((m) => m.id)).toStrictEqual([d2]);
});

test('list_conversations gives one row per member talked with, newest first, paged, each with its last message and unread', async () => {
  const { ann, bo, agent } = await hub();
  const a = (await call(ann, 'send_message', { to: 'bo', message: 'one' }) as Sent).sent.id;
  const b = (await call(agent, 'send_message', { to: 'bo', message: 'two' }) as Sent).sent.id;
  type Page = { conversations: { with: string; last: { id: string; from: string; to: string; message: string }; unread: number; unread_more: boolean; last_at: string }[]; next: string | null };
  const first = await call(bo, 'list_conversations', { limit: 1 }) as Page;
  expect(first.conversations).toStrictEqual([{ with: 'bo-claude', last: expect.objectContaining({ id: b, from: 'bo-claude', to: 'bo', message: 'two', read_at: null }), unread: 1, unread_more: false, last_at: expect.any(String) }]);
  expect(first.next).toEqual(expect.any(String));
  const second = await call(bo, 'list_conversations', { limit: 1, cursor: first.next }) as Page;
  expect(second).toStrictEqual({ conversations: [expect.objectContaining({ with: 'ann', last: expect.objectContaining({ id: a }), unread: 1 })], next: null });
  // Ann's is her own: Bo, and nothing of Bo's with his agent.
  expect(((await call(ann, 'list_conversations', {})) as Page).conversations.map((c) => [c.with, c.unread])).toStrictEqual([['bo', 0]]);
  expect(await rejection(call(ann, 'list_conversations', { cursor: first.next }))).toMatch(/invalid cursor/);
});
