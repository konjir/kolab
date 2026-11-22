// The tools konnect's phone app needs (docs/plans/konnect-mobile.md, S2 to S5), over MCP as the app
// calls them: what each takes and returns, and what each refuses.
import { expect, test } from '@jest/globals';
import { expoSender, pushOptionsFromEnv, startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

/** Expo's push API, as the tests stand it in: never exp.host. Each request is kept; `answer` gives each push's ticket, or a status for the whole request. */
function fakeExpo(answer: (push: { to: string }) => unknown = () => ({ status: 'ok', id: 'x' }), status: () => number = () => 200) {
  const requests: { url: string; headers: Record<string, string>; body: { to: string; title: string; body?: string; data: Record<string, string>; badge: number; sound: string }[] }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const code = status();
    return new Response(JSON.stringify(code === 200 ? { data: body.map(answer) } : { errors: [{ code: 'BAD', message: 'no' }] }), { status: code, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

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

test('list_members gives each member the GitHub login behind them, an agent its owner\'s, and null without one', async () => {
  const { admin, ann } = await hub();
  await call(admin, 'admin_link_identity', { actor: 'bo', provider: 'github', subject: '4242', login: 'BoGH' });
  const members = ((await call(ann, 'list_members', {})) as { members: { actor: string; login: string | null }[] }).members;
  expect(members.map((m) => [m.actor, m.login])).toStrictEqual([['ann', null], ['bo', 'BoGH'], ['bo-claude', 'BoGH']]);
});

const TOKEN = 'ExponentPushToken[bo-phone]';

test('the push verbs are a person\'s: register, unregister, and notification prefs; an agent is refused each, and arguments are checked', async () => {
  const { bo, agent } = await hub();
  expect(await call(bo, 'register_push_device', { token: TOKEN, platform: 'ios' }))
    .toStrictEqual({ device: { token: TOKEN, platform: 'ios', created_at: expect.any(String), last_seen_at: expect.any(String) } });
  expect(await call(bo, 'get_notification_prefs', {})).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: [], hide_preview: false });
  expect(await call(bo, 'set_notification_prefs', { level: 'all', muted_channels: ['general'], hide_preview: true })).toStrictEqual({ kolab: 'hub', level: 'all', muted_channels: ['general'], hide_preview: true });
  expect(await call(bo, 'set_notification_prefs', { level: 'mentions_and_dms' })).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: ['general'], hide_preview: true });
  expect(await call(bo, 'get_notification_prefs', {})).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: ['general'], hide_preview: true });
  expect(await rejection(call(bo, 'set_notification_prefs', { level: 'all', hide_preview: 'yes' }))).toMatch(/hide_preview/);
  expect(await call(bo, 'unregister_push_device', { token: TOKEN })).toStrictEqual({ unregistered: true });
  expect(await call(bo, 'unregister_push_device', { token: TOKEN })).toStrictEqual({ unregistered: false });

  for (const [verb, a] of [['register_push_device', { token: TOKEN, platform: 'ios' }], ['unregister_push_device', { token: TOKEN }],
    ['set_notification_prefs', { level: 'all' }], ['get_notification_prefs', {}]] as const) {
    expect(await rejection(call(agent, verb, a))).toMatch(/AccessError: bo-claude is an agent: only a person/);
  }
  expect(await rejection(call(bo, 'register_push_device', { token: TOKEN, platform: 'web' }))).toMatch(/platform/);
  expect(await rejection(call(bo, 'register_push_device', { token: 'nope', platform: 'ios' }))).toMatch(/token is an Expo push token/);
  expect(await rejection(call(bo, 'set_notification_prefs', { level: 'loud' }))).toMatch(/level/);
  expect(await rejection(call(bo, 'set_notification_prefs', { level: 'all', muted_channels: ['nope'] }))).toMatch(/kolab hub has no channel #nope/);
});

test('with an Expo access token, a message to a person with a device is pushed through Expo\'s API, once; a token Expo no longer knows is forgotten', async () => {
  const expo = fakeExpo((p) => (p.to === 'ExponentPushToken[gone]' ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'r1' }));
  const { server, ann, bo } = await hub({ push: { accessToken: 'expo-test-token', preview: true, fetch: expo.fetch, url: 'https://expo.invalid/push' } });
  await call(bo, 'register_push_device', { token: TOKEN, platform: 'ios' });
  await call(bo, 'register_push_device', { token: 'ExponentPushToken[gone]', platform: 'android' });
  const sent = (await call(ann, 'send_message', { to: 'bo', message: 'Lunch at noon?' }) as Sent).sent.id;
  await until('the push to reach Expo', () => expo.requests.length === 1);
  const [r] = expo.requests;
  expect(r.url).toBe('https://expo.invalid/push');
  expect(r.headers.authorization).toBe('Bearer expo-test-token');
  expect(r.body.map((m) => m.to).sort()).toStrictEqual(['ExponentPushToken[bo-phone]', 'ExponentPushToken[gone]']);
  expect(r.body[0]).toMatchObject({ title: 'ann', body: 'Lunch at noon?', data: { team: 'hub', kind: 'dm', with: 'ann', message_id: sent }, badge: 1, sound: 'default' });
  await until('the job to finish', async () => !(await server.kolab.db.query(`select 1 from outbox`)).rows.length);
  expect((await server.kolab.db.query(`select token from push_device`)).rows).toStrictEqual([{ token: TOKEN }]);

  // A channel message under the default prefs: pushed only when it mentions him.
  await call(ann, 'send_channel_message', { channel: 'general', message: 'standup' });
  await call(ann, 'send_channel_message', { channel: 'general', message: 'bo, standup', mentions: ['bo'] });
  await until('the mention\'s push', () => expo.requests.length === 2);
  expect(expo.requests[1].body).toMatchObject([{ title: 'ann in #general', body: 'bo, standup', data: { kind: 'channel', channel: 'general' } }]);
  await new Promise((r) => setTimeout(r, 200));
  expect(expo.requests.length).toBe(2);
});

test('nothing is pushed to a person while their listen stream is open in the team', async () => {
  const expo = fakeExpo();
  const { ann, bo } = await hub({ push: { accessToken: 'expo-test-token', preview: true, fetch: expo.fetch } });
  await call(bo, 'register_push_device', { token: TOKEN, platform: 'ios' });
  const stream = await bo.listen({ resourceSubscriptions: ['konjir://answers/hub/bo'] });
  await call(ann, 'send_message', { to: 'bo', message: 'you are here' });
  await new Promise((r) => setTimeout(r, 300));
  expect(expo.requests).toStrictEqual([]);
  await stream.close();
  await new Promise((r) => setTimeout(r, 200));
  await call(ann, 'send_message', { to: 'bo', message: 'and now you are not' });
  await until('the push', () => expo.requests.length === 1);
  expect(expo.requests[0].body[0]).toMatchObject({ body: 'and now you are not' });
});

test('without an Expo access token push is off and nothing is queued; KONJIR_PUSH_PREVIEW=off sends no words', async () => {
  const { server, ann, bo } = await hub({ push: { accessToken: null, preview: true } });
  await call(bo, 'register_push_device', { token: TOKEN, platform: 'ios' });
  await call(ann, 'send_message', { to: 'bo', message: 'quiet' });
  await new Promise((r) => setTimeout(r, 200));
  expect((await server.kolab.db.query(`select 1 from outbox`)).rows).toStrictEqual([]);

  expect(pushOptionsFromEnv({})).toStrictEqual({ accessToken: null, preview: true });
  expect(pushOptionsFromEnv({ KONJIR_EXPO_ACCESS_TOKEN: 'unset' })).toStrictEqual({ accessToken: null, preview: true });
  expect(pushOptionsFromEnv({ KONJIR_EXPO_ACCESS_TOKEN: ' tok ', KONJIR_PUSH_PREVIEW: 'off' })).toStrictEqual({ accessToken: 'tok', preview: false });
  expect(pushOptionsFromEnv({ KONJIR_EXPO_ACCESS_TOKEN: 'tok', KONJIR_PUSH_PREVIEW: 'on' })).toStrictEqual({ accessToken: 'tok', preview: true });

  const expo = fakeExpo();
  const quiet = await hub({ push: { accessToken: 'expo-test-token', preview: false, fetch: expo.fetch } });
  await call(quiet.bo, 'register_push_device', { token: TOKEN, platform: 'ios' });
  await call(quiet.ann, 'send_message', { to: 'bo', message: 'nobody reads this' });
  await until('the push', () => expo.requests.length === 1);
  expect(expo.requests[0].body[0]).not.toHaveProperty('body');
  expect(JSON.stringify(expo.requests[0].body)).not.toContain('nobody reads this');

  // A person's own hide_preview, with the server's previews on.
  const mine = fakeExpo();
  const own = await hub({ push: { accessToken: 'expo-test-token', preview: true, fetch: mine.fetch } });
  await call(own.bo, 'register_push_device', { token: TOKEN, platform: 'ios' });
  await call(own.bo, 'set_notification_prefs', { level: 'mentions_and_dms', hide_preview: true });
  await call(own.ann, 'send_message', { to: 'bo', message: 'hidden by bo' });
  await until('the push', () => mine.requests.length === 1);
  expect(mine.requests[0].body[0]).toMatchObject({ title: 'ann', data: { team: 'hub', kind: 'dm', with: 'ann' } });
  expect(mine.requests[0].body[0]).not.toHaveProperty('body');
});

test('Expo\'s sender: a 5xx, a 429 or no answer throws, so the outbox retries; another refusal gives each push an error ticket; DeviceNotRegistered says unregistered', async () => {
  const push = { to: TOKEN, title: 't', data: { team: 'hub', kind: 'dm' as const, with: 'ann', message_id: 'm' }, badge: 0, sound: 'default' as const };
  for (const code of [500, 503, 429]) {
    const expo = fakeExpo(undefined, () => code);
    await expect(expoSender({ accessToken: 't', fetch: expo.fetch })([push])).rejects.toThrow(new RegExp(`answered ${code}; the push is tried again`));
  }
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  await expect(expoSender({ accessToken: 't', fetch: down })([push])).rejects.toThrow(/could not be reached/);
  const refused = fakeExpo(undefined, () => 401);
  expect(await expoSender({ accessToken: 't', fetch: refused.fetch })([push, push])).toStrictEqual([
    { ok: false, unregistered: false, error: 'BAD' }, { ok: false, unregistered: false, error: 'BAD' }]);
  const mixed = fakeExpo((p) => (p.to === 'ExponentPushToken[gone]' ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }));
  expect(await expoSender({ accessToken: 't', fetch: mixed.fetch })([{ ...push, to: 'ExponentPushToken[gone]' }, push])).toStrictEqual([
    { ok: false, unregistered: true, error: 'DeviceNotRegistered' }, { ok: false, unregistered: false, error: 'MessageTooBig' }]);
  await expect(expoSender({ accessToken: 't', fetch: mixed.fetch })(Array.from({ length: 101 }, () => push))).rejects.toThrow(/at most 100/);
  // Its default URL is Expo's own API, which no test reaches: every test above gave its own fetch.
  expect(mixed.requests.every((r) => r.url === 'https://exp.host/--/api/v2/push/send')).toBe(true);
});
