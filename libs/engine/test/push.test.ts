// Push notifications to konnect's phone app (S4, migration 0058): a person registers their app's
// Expo push token in a team and chooses what they are told of there; each message sent through this
// Kolab is told to its listeners once it commits (onMessageSent), queuePushes decides who is pushed
// it under their prefs and queues one push job in the outbox, and the job sends it through the
// sender the server gives (Expo's push API, mocked here), forgetting devices that are no longer
// registered and retrying through the outbox when the service fails.
import { expect, test } from '@jest/globals';
import { MAX_PUSH_DEVICES, PUSH_BATCH, UNREAD_COUNT_CEILING, type SentMessage } from '@konjir/types';
import { wantsPush, type PushMessage, type PushTicket } from '@konjir/engine';
import { openKolab, rejection, type TestKolab } from '@konjir/engine/testing';

const token = (n: string | number) => `ExponentPushToken[${n}]`;

/**
 * Ann owns `hub`; Bo and Cy write there; Bo has an agent. Each has a session. Push is on, with a
 * sender that records what it is given and answers each with `answer` (ok by default).
 */
async function hub(opts: { answer?: (m: PushMessage) => PushTicket } = {}) {
  const k = await openKolab();
  for (const id of ['ann', 'bo', 'cy']) await k.addActor(id);
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('hub', { owner: 'ann' });
  for (const id of ['bo', 'cy', 'bo-claude']) await k.grant('hub', id, 'write');
  const s = {
    ann: await k.openSession('ann', 'product', { kolab: 'hub' }),
    bo: await k.openSession('bo', 'engineer', { kolab: 'hub' }),
    cy: await k.openSession('cy', 'engineer', { kolab: 'hub' }),
    agent: await k.openSession('bo-claude', 'engineer', { kolab: 'hub' }),
  };
  const batches: PushMessage[][] = [];
  k.push.send = async (messages) => { batches.push(messages); return messages.map(opts.answer ?? (() => ({ ok: true }))); };
  const sent: SentMessage[] = [];
  k.onMessageSent((m) => sent.push(m));
  /** Queues the pushes of the message just sent, and runs the job: what was sent, flattened. */
  const pushed = async (listening: string[] = []) => {
    const n = await k.queuePushes(sent[sent.length - 1], { listening });
    batches.length = 0;
    await k.drainOutbox();
    return { people: n, messages: batches.flat() };
  };
  return { kolab: k, ...s, batches, sent, pushed };
}

const jobs = async (k: TestKolab) => (await k.db.query<{ kind: string; payload: unknown; attempts: number }>(`select kind, payload, attempts from outbox order by id`)).rows;

test('the decision: a direct message under either level but none; a channel message with all, or with mentions_and_dms only when it mentions them; never muted, never while listening', () => {
  const cases: [Parameters<typeof wantsPush>[0], boolean][] = [];
  for (const level of ['all', 'mentions_and_dms', 'none'] as const) {
    for (const kind of ['dm', 'channel'] as const) {
      for (const mentioned of [false, true]) {
        for (const muted of [false, true]) {
          for (const listening of [false, true]) {
            const want = !listening && level !== 'none' && (kind === 'dm' || (!muted && (level === 'all' || mentioned)));
            cases.push([{ kind, level, mentioned, muted, listening }, want]);
          }
        }
      }
    }
  }
  expect(cases.length).toBe(48);
  for (const [input, want] of cases) expect([input, wantsPush(input)]).toStrictEqual([input, want]);
});

test('a person registers their app\'s token, idempotently; it moves to whoever registers it next in the team; they unregister it; an agent is refused every push verb', async () => {
  const { kolab, ann, bo, agent } = await hub();
  const first = await kolab.registerPushDevice(bo, token('phone'), 'ios');
  expect(first).toStrictEqual({ device: { token: token('phone'), platform: 'ios', created_at: expect.any(String), last_seen_at: expect.any(String) } });
  const again = await kolab.registerPushDevice(bo, token('phone'), 'ios');
  expect(again.device.created_at).toBe(first.device.created_at);
  expect(again.device.last_seen_at >= first.device.last_seen_at).toBe(true);
  expect((await kolab.db.query(`select actor_id from push_device`)).rows).toStrictEqual([{ actor_id: 'bo' }]);
  // The same phone, signed in as Ann: the token is hers now, and Bo's unregister finds nothing.
  const moved = await kolab.registerPushDevice(ann, token('phone'), 'android');
  expect(moved.device).toMatchObject({ platform: 'android' });
  expect((await kolab.db.query(`select actor_id, platform from push_device`)).rows).toStrictEqual([{ actor_id: 'ann', platform: 'android' }]);
  expect(await kolab.unregisterPushDevice(bo, token('phone'))).toStrictEqual({ unregistered: false });
  expect(await kolab.unregisterPushDevice(ann, token('phone'))).toStrictEqual({ unregistered: true });
  expect(await kolab.unregisterPushDevice(ann, token('phone'))).toStrictEqual({ unregistered: false });
  // Unregistering leaves no row, so the audit log says so, by platform, never by token.
  expect((await kolab.auditLog({ kolab: 'hub' })).filter((e) => e.action === 'push_device.unregistered').map((e) => [e.subject, e.by, e.detail]))
    .toStrictEqual([['ann', 'ann', { platform: 'android' }]]);

  // Agents: refused, and nothing written.
  const refusal = /AccessError: bo-claude is an agent: only a person/;
  expect(await rejection(kolab.registerPushDevice(agent, token('bot'), 'ios'))).toMatch(refusal);
  expect(await rejection(kolab.unregisterPushDevice(agent, token('bot')))).toMatch(refusal);
  expect(await rejection(kolab.setNotificationPrefs(agent, { level: 'all' }))).toMatch(refusal);
  expect(await rejection(kolab.notificationPrefs(agent))).toMatch(refusal);
  // A token or platform that isn't one.
  expect(await rejection(kolab.registerPushDevice(bo, 'apns:abc', 'ios'))).toMatch(/LimitError: token is an Expo push token/);
  expect(await rejection(kolab.registerPushDevice(bo, token('x'), 'web'))).toMatch(/LimitError: platform is one of ios, android/);
  expect((await kolab.db.query(`select 1 from push_device`)).rows).toStrictEqual([]);
});

test('a device is the person\'s: registered from any team, it is one device, and unregistering it from any team stops it everywhere', async () => {
  const { kolab, bo } = await hub();
  await kolab.registerPushDevice(bo, token('phone'), 'ios');
  // An admin opens one hand-issued session of a person's at a time: Bo's in hub ends first.
  await kolab.createKolab('side', { owner: 'bo' });
  await kolab.endSession(bo);
  const boSide = await kolab.openSession('bo', 'engineer', { kolab: 'side' });
  const again = await kolab.registerPushDevice(boSide, token('phone'), 'android');
  expect(again.device).toMatchObject({ token: token('phone'), platform: 'android' });
  expect((await kolab.db.query(`select token, actor_id, platform from push_device`)).rows)
    .toStrictEqual([{ token: token('phone'), actor_id: 'bo', platform: 'android' }]);
  expect(await kolab.unregisterPushDevice(boSide, token('phone'))).toStrictEqual({ unregistered: true });
  expect((await kolab.db.query(`select 1 from push_device`)).rows).toStrictEqual([]);
});

test('pushes cover every team the person is in: a device registered from one team is pushed another team\'s messages, under that team\'s prefs, and only that team\'s listen stream holds them back', async () => {
  const { kolab, ann, bo, cy, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  // side is Cy's team; Bo is a member, with no session there. Bo's prefs: none in hub, all in side.
  await kolab.createKolab('side', { owner: 'cy' });
  await kolab.grant('side', 'bo', 'write');
  await kolab.endSession(cy);
  const cySide = await kolab.openSession('cy', 'engineer', { kolab: 'side' });
  await kolab.setNotificationPrefs(bo, { level: 'none' });

  await kolab.sendMessage(ann, 'bo', 'in hub, where bo hears nothing');
  expect((await pushed()).messages).toStrictEqual([]);
  const m = await kolab.sendChannelMessage(cySide, 'general', 'in side, no mention');
  // Side's prefs are the default there, mentions_and_dms: an unmentioned channel message pushes nothing.
  expect((await pushed()).messages).toStrictEqual([]);
  const d = await kolab.sendMessage(cySide, 'bo', 'a direct message in side');
  const [dm] = (await pushed()).messages;
  expect(dm).toMatchObject({ to: token('b'), title: 'cy', data: { team: 'side', kind: 'dm', with: 'cy', message_id: d.id } });
  expect(m.id).toBeTruthy();

  // Bo's stream open in hub holds back hub's pushes, not side's.
  await kolab.setNotificationPrefs(bo, { level: 'all' });
  const boHub = (await kolab.sessionInfo(bo)).session;
  await kolab.sendMessage(ann, 'bo', 'hub, while bo listens in hub');
  expect((await pushed([boHub])).messages).toStrictEqual([]);
  await kolab.sendMessage(cySide, 'bo', 'side, while bo listens in hub');
  expect((await pushed([boHub])).messages).toMatchObject([{ data: { team: 'side' } }]);

  // A team Bo leaves pushes him nothing more; his device still hears hub.
  await kolab.revoke('side', 'bo');
  await rejection(kolab.sendMessage(cySide, 'bo', 'no longer a member'));
  await kolab.sendMessage(ann, 'bo', 'hub still');
  expect((await pushed()).messages).toMatchObject([{ data: { team: 'hub' } }]);
});

test('across teams, the decision is the message\'s team\'s alone: each level in the other team, against each level, mention and listening in this one', async () => {
  const { kolab, ann, bo, cy, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.createKolab('side', { owner: 'cy' });
  await kolab.grant('side', 'bo', 'write');
  await kolab.endSession(cy);
  const cySide = await kolab.openSession('cy', 'engineer', { kolab: 'side' });
  const boHub = (await kolab.sessionInfo(bo)).session;
  const levels = ['all', 'mentions_and_dms', 'none'] as const;
  let cases = 0;
  for (const inHub of levels) {
    await kolab.setNotificationPrefs(bo, { level: inHub });
    for (const inSide of levels) {
      await kolab.db.query(
        `insert into notification_pref(kolab_id, actor_id, level) values ('side', 'bo', $1) on conflict (kolab_id, actor_id) do update set level = excluded.level`, [inSide]);
      for (const kind of ['dm', 'channel'] as const) {
        for (const mentioned of [false, true]) {
          for (const listeningInHub of [false, true]) {
            if (kind === 'dm') await kolab.sendMessage(cySide, 'bo', 'side');
            else await kolab.sendChannelMessage(cySide, 'general', 'side', { mentions: mentioned ? ['bo'] : [] });
            const got = (await pushed(listeningInHub ? [boHub] : [])).messages.length > 0;
            // Only side's level counts, and listening in hub holds back nothing of side's.
            const want = wantsPush({ kind, level: inSide, muted: false, mentioned: kind === 'channel' && mentioned, listening: false });
            expect([inHub, inSide, kind, mentioned, listeningInHub, got]).toStrictEqual([inHub, inSide, kind, mentioned, listeningInHub, want]);
            cases++;
          }
        }
      }
    }
  }
  expect(cases).toBe(72);
  // And hub's own messages go by hub's level, held back while Bo listens there.
  await kolab.setNotificationPrefs(bo, { level: 'all' });
  await kolab.sendMessage(ann, 'bo', 'hub');
  expect((await pushed([boHub])).messages).toStrictEqual([]);
  await kolab.sendMessage(ann, 'bo', 'hub');
  expect((await pushed()).messages.length).toBe(1);
});

test(`a person keeps at most ${MAX_PUSH_DEVICES} devices, across their teams: one more forgets the least recently seen`, async () => {
  const { kolab, bo } = await hub();
  for (let i = 0; i < MAX_PUSH_DEVICES; i++) await kolab.registerPushDevice(bo, token(i), 'ios');
  // Device 0 seen again: device 1 is now the stalest.
  await kolab.registerPushDevice(bo, token(0), 'ios');
  await kolab.registerPushDevice(bo, token('new'), 'android');
  const kept = (await kolab.db.query<{ token: string }>(`select token from push_device where actor_id = 'bo'`)).rows.map((r) => r.token);
  expect(kept.length).toBe(MAX_PUSH_DEVICES);
  expect(kept).toContain(token(0));
  expect(kept).toContain(token('new'));
  expect(kept).not.toContain(token(1));
});

test('notification prefs: mentions_and_dms and nothing muted by default; a level and muted channels by name, which stay when left out; unknown channels and levels refused', async () => {
  const { kolab, bo } = await hub();
  expect(await kolab.notificationPrefs(bo)).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: [], hide_preview: false });
  await kolab.makeChannel(bo, 'deploys');
  await kolab.makeChannel(bo, 'alerts');
  expect(await kolab.setNotificationPrefs(bo, { level: 'all', muted_channels: ['#deploys', 'alerts', 'deploys'] }))
    .toStrictEqual({ kolab: 'hub', level: 'all', muted_channels: ['alerts', 'deploys'], hide_preview: false });
  expect(await kolab.setNotificationPrefs(bo, { level: 'none' })).toStrictEqual({ kolab: 'hub', level: 'none', muted_channels: ['alerts', 'deploys'], hide_preview: false });
  expect(await kolab.setNotificationPrefs(bo, { level: 'mentions_and_dms', muted_channels: [], hide_preview: false })).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: [], hide_preview: false });
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'all', muted_channels: ['nope', 'general'] }))).toMatch(/LimitError: kolab hub has no channel #nope/);
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'loud' }))).toMatch(/LimitError: level is one of all, mentions_and_dms, none/);
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'all', muted_channels: Array.from({ length: 201 }, (_, i) => `c${i}`) }))).toMatch(/at most 200/);
  expect(await kolab.notificationPrefs(bo)).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: [], hide_preview: false });
});

test('a direct message to a person with a device queues one push job, which sends the sender, the start of the message, what to open and their unread', async () => {
  const { kolab, ann, bo, cy, batches, sent } = await hub();
  await kolab.registerPushDevice(bo, token('b1'), 'ios');
  await kolab.registerPushDevice(bo, token('b2'), 'android');
  await kolab.sendChannelMessage(cy, 'general', 'one unread in general');
  const long = 'x'.repeat(150);
  const m = await kolab.sendMessage(ann, 'bo', long);
  expect(sent[sent.length - 1]).toStrictEqual({ kind: 'dm', kolab: 'hub', id: m.id, from: 'ann', to: 'bo', message: long, recipients: ['bo'] });
  const n = await kolab.queuePushes(sent[sent.length - 1]);
  expect(n).toBe(1);
  expect(await jobs(kolab)).toStrictEqual([{ kind: 'push', attempts: 0, payload: {
    message: m.id,
    notifications: [{ actor: 'bo', title: 'ann', body: 'x'.repeat(100), data: { team: 'hub', kind: 'dm', with: 'ann', message_id: m.id }, badge: 2 }],
  } }]);
  // The admin's list names the job by its kolab and message, never what it says.
  expect((await kolab.outboxJobs()).map((j) => [j.kind, j.subject])).toStrictEqual([['push', `hub message ${m.id}`]]);
  await kolab.drainOutbox();
  expect(batches.flat().map((x) => [x.to, x.title, x.badge])).toStrictEqual([[token('b1'), 'ann', 2], [token('b2'), 'ann', 2]]);
  expect(await jobs(kolab)).toStrictEqual([]);
});

test('the job sends one push per device, and a channel message\'s title names the channel', async () => {
  const { kolab, ann, bo, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b1'), 'ios');
  await kolab.registerPushDevice(bo, token('b2'), 'android');
  const m = await kolab.sendChannelMessage(ann, 'general', 'deploy is green, @bo', { mentions: ['bo'] });
  const r = await pushed();
  expect(r.people).toBe(1);
  expect(r.messages).toStrictEqual([token('b1'), token('b2')].map((to) => ({
    to, title: 'ann in #general', body: 'deploy is green, @bo', data: { team: 'hub', kind: 'channel', channel: 'general', message_id: m.id }, badge: 1, sound: 'default',
  })));
});

test('who is pushed a channel message: each prefs level, a muted channel, a mention or not; never its sender, never an agent, never someone listening', async () => {
  const { kolab, ann, bo, cy, agent, pushed } = await hub();
  for (const [s, t] of [[ann, 'a'], [bo, 'b'], [cy, 'c']] as const) await kolab.registerPushDevice(s, token(t), 'ios');
  const to = async () => [...new Set((await pushed()).messages.map((m) => m.to))].sort();

  // Default mentions_and_dms: only the mentioned; the sender never, though she has a device and follows general.
  await kolab.sendChannelMessage(ann, 'general', 'hello all');
  expect(await to()).toStrictEqual([]);
  await kolab.sendChannelMessage(ann, 'general', 'hello bo', { mentions: ['bo', 'bo/claude'] });
  expect(await to()).toStrictEqual([token('b')]);

  // all: every follower; none: nothing, not even a mention or a direct message.
  await kolab.setNotificationPrefs(cy, { level: 'all' });
  await kolab.setNotificationPrefs(bo, { level: 'none' });
  await kolab.sendChannelMessage(ann, 'general', 'to everyone', { mentions: ['bo'] });
  expect(await to()).toStrictEqual([token('c')]);
  await kolab.sendMessage(ann, 'bo', 'direct');
  expect(await to()).toStrictEqual([]);

  // Muted: nothing from that channel, a mention included, under any level; direct messages still come.
  await kolab.setNotificationPrefs(cy, { level: 'all', muted_channels: ['general'] });
  await kolab.sendChannelMessage(ann, 'general', 'muted', { mentions: ['cy'] });
  expect(await to()).toStrictEqual([]);
  await kolab.sendMessage(ann, 'cy', 'still direct');
  expect(await to()).toStrictEqual([token('c')]);

  // A channel Cy doesn't follow: with all, only a mention reaches her (she isn't among its recipients otherwise).
  await kolab.makeChannel(ann, 'deploys');
  await kolab.sendChannelMessage(ann, 'deploys', 'unfollowed');
  expect(await to()).toStrictEqual([]);
  await kolab.sendChannelMessage(ann, 'deploys', 'unfollowed, mentioned', { mentions: ['cy'] });
  expect(await to()).toStrictEqual([token('c')]);

  // An agent is never pushed: it has no device, and can register none; a direct message to one queues nothing.
  await kolab.sendMessage(ann, 'bo-claude', 'to the agent');
  expect(await to()).toStrictEqual([]);
  expect(await jobs(kolab)).toStrictEqual([]);

  // Someone whose listen stream is open in the team is skipped; one listening in another team isn't.
  const cyKey = (await kolab.sessionInfo(cy)).session;
  await kolab.sendMessage(ann, 'cy', 'you are here');
  expect((await pushed([cyKey])).messages).toStrictEqual([]);
  await kolab.sendMessage(agent, 'cy', 'from an agent, while not listening');
  expect(await to()).toStrictEqual([token('c')]);
});

test('previews off: a push carries no words of its message', async () => {
  const { kolab, ann, bo, pushed } = await hub();
  kolab.push.preview = false;
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.sendMessage(ann, 'bo', 'secret plans');
  const [m] = (await pushed()).messages;
  expect(m).toStrictEqual({ to: token('b'), title: 'ann', data: expect.objectContaining({ kind: 'dm', with: 'ann' }), badge: 1, sound: 'default' });
  expect(JSON.stringify(m)).not.toContain('secret');
});

test('hide_preview, a person\'s own choice in a team, keeps the words out of their pushes alone; it stays when left out', async () => {
  const { kolab, ann, bo, cy, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.registerPushDevice(cy, token('c'), 'ios');
  expect(await kolab.setNotificationPrefs(bo, { level: 'all', hide_preview: true })).toStrictEqual({ kolab: 'hub', level: 'all', muted_channels: [], hide_preview: true });
  expect(await kolab.setNotificationPrefs(bo, { level: 'all' })).toMatchObject({ hide_preview: true });
  expect(await kolab.notificationPrefs(bo)).toMatchObject({ hide_preview: true });
  await kolab.sendChannelMessage(ann, 'general', 'the plan, @bo @cy', { mentions: ['bo', 'cy'] });
  const byTo = Object.fromEntries((await pushed()).messages.map((m) => [m.to, m]));
  expect(byTo[token('b')]).not.toHaveProperty('body');
  expect(byTo[token('b')]).toMatchObject({ title: 'ann in #general', data: { kind: 'channel', channel: 'general' } });
  expect(byTo[token('c')]).toMatchObject({ body: 'the plan, @bo @cy' });
  expect(await kolab.setNotificationPrefs(bo, { level: 'all', hide_preview: false })).toMatchObject({ hide_preview: false });
  await kolab.sendMessage(ann, 'bo', 'words again');
  expect((await pushed()).messages[0]).toMatchObject({ body: 'words again' });
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'all', hide_preview: 'yes' as unknown as boolean }))).toMatch(/hide_preview is true or false/);
});

test('push off: nothing is decided or queued, and a job queued before it went off is dropped', async () => {
  const { kolab, ann, bo, sent } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.sendMessage(ann, 'bo', 'queued while on');
  expect(await kolab.queuePushes(sent[sent.length - 1])).toBe(1);
  kolab.push.send = null;
  await kolab.sendMessage(ann, 'bo', 'sent while off');
  expect(await kolab.queuePushes(sent[sent.length - 1])).toBe(0);
  expect((await jobs(kolab)).length).toBe(1);
  await kolab.drainOutbox();
  expect(await jobs(kolab)).toStrictEqual([]);
});

test('a device registered from a sign-in gets nothing once that sign-in is revoked or lapses', async () => {
  const { kolab, ann, bo, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.db.query(`insert into oauth_grant(id, client_id, actor_id, person_id, scope, expires_at) values ($1, 'app', 'bo', 'bo', 'konjir', now() + interval '1 day')`, ['g'.repeat(22)]);
  await kolab.db.query(`update push_device set grant_id = $1`, ['g'.repeat(22)]);
  await kolab.sendMessage(ann, 'bo', 'while signed in');
  expect((await pushed()).messages.length).toBe(1);
  await kolab.db.query(`update oauth_grant set revoked_at = now(), revoked_by = 'bo'`);
  await kolab.sendMessage(ann, 'bo', 'after signing out');
  expect((await pushed()).messages).toStrictEqual([]);
  await kolab.db.query(`update oauth_grant set revoked_at = null, revoked_by = null, expires_at = now() - interval '1 second'`);
  await kolab.sendMessage(ann, 'bo', 'after it lapsed');
  expect((await pushed()).messages).toStrictEqual([]);
});

test('a device Expo says is no longer registered is forgotten; other refusals are logged and not retried', async () => {
  const { kolab, ann, bo, cy, pushed } = await hub({
    answer: (m) => (m.to === token('gone') ? { ok: false, unregistered: true, error: 'DeviceNotRegistered' }
      : m.to === token('big') ? { ok: false, unregistered: false, error: 'MessageTooBig' } : { ok: true }),
  });
  await kolab.registerPushDevice(bo, token('gone'), 'ios');
  await kolab.registerPushDevice(bo, token('ok'), 'ios');
  await kolab.registerPushDevice(cy, token('big'), 'ios');
  await kolab.setNotificationPrefs(cy, { level: 'all' });
  await kolab.sendChannelMessage(ann, 'general', 'hi', { mentions: ['bo'] });
  expect((await pushed()).messages.map((m) => m.to).sort()).toStrictEqual([token('big'), token('gone'), token('ok')]);
  expect((await kolab.db.query(`select token from push_device order by token`)).rows).toStrictEqual([{ token: token('big') }, { token: token('ok') }]);
  expect(await jobs(kolab)).toStrictEqual([]);
});

test(`pushes go ${PUSH_BATCH} at a time; when the service fails, the job is retried through the outbox, and sends only what it hadn't`, async () => {
  const { kolab, ann, sent, batches } = await hub();
  // Twelve people with ten devices each: 120 pushes, two batches.
  const people = Array.from({ length: 12 }, (_, i) => `p${i}`);
  for (const id of people) {
    await kolab.addActor(id);
    await kolab.grant('hub', id, 'read');
    const s = await kolab.openSession(id, 'product', { kolab: 'hub' });
    for (let d = 0; d < MAX_PUSH_DEVICES; d++) await kolab.registerPushDevice(s, token(`${id}-${d}`), 'ios');
  }
  let failNext = false;
  kolab.push.send = async (messages) => {
    batches.push(messages);
    if (failNext) { failNext = false; throw new Error('Expo\'s push service answered 503'); }
    failNext = true;   // the second batch fails, once
    return messages.map(() => ({ ok: true as const }));
  };
  await kolab.sendChannelMessage(ann, 'general', 'everyone', { mentions: people });
  expect(await kolab.queuePushes(sent[sent.length - 1])).toBe(12);
  batches.length = 0;
  await kolab.drainOutbox();
  expect(batches.map((b) => b.length)).toStrictEqual([PUSH_BATCH, 120 - PUSH_BATCH]);
  const [job] = await jobs(kolab);
  expect(job).toMatchObject({ kind: 'push', attempts: 1 });
  expect((job.payload as { sent: string[] }).sent.length).toBe(PUSH_BATCH);
  // Due again: only the second batch is sent.
  const first = new Set(batches[0].map((m) => m.to));
  batches.length = 0;
  await kolab.db.query(`update outbox set run_after = clock_timestamp()`);
  await kolab.drainOutbox();
  expect(batches.map((b) => b.length)).toStrictEqual([120 - PUSH_BATCH]);
  expect(batches[0].some((m) => first.has(m.to))).toBe(false);
  expect(await jobs(kolab)).toStrictEqual([]);
});

test('the badge is the person\'s unread across every team they are in: direct messages, followed channels\' unread and others\' mentions, summed, at most the ceiling', async () => {
  const { kolab, ann, bo, cy, sent } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.makeChannel(cy, 'deploys');
  await kolab.sendChannelMessage(cy, 'deploys', 'not followed, no mention');
  await kolab.sendChannelMessage(cy, 'deploys', 'not followed, mentioned', { mentions: ['bo'] });
  await kolab.sendChannelMessage(cy, 'general', 'followed');
  await kolab.sendMessage(cy, 'bo', 'direct');
  await kolab.sendMessage(ann, 'bo', 'and this one');
  const last = sent[sent.length - 1];
  await kolab.queuePushes(last);
  expect(((await jobs(kolab))[0].payload as { notifications: { badge: number }[] }).notifications[0].badge).toBe(4);
  await kolab.db.query(`delete from outbox`);
  // Another team of Bo's adds its unread; an archived one, and one he isn't in, add nothing.
  await kolab.createKolab('side', { owner: 'cy' });
  await kolab.grant('side', 'bo', 'read');
  await kolab.createKolab('gone', { owner: 'cy' });
  await kolab.grant('gone', 'bo', 'read');
  await kolab.createKolab('elsewhere', { owner: 'cy' });
  await kolab.endSession(cy);
  for (const k of ['side', 'gone', 'elsewhere']) {
    const c = await kolab.openSession('cy', 'engineer', { kolab: k });
    await kolab.sendChannelMessage(c, 'general', `in ${k}`);
    await kolab.endSession(c);
  }
  await kolab.archive({ kolab: 'gone' });
  await kolab.queuePushes(last);
  expect(((await jobs(kolab))[0].payload as { notifications: { badge: number }[] }).notifications[0].badge).toBe(5);
  await kolab.db.query(`delete from outbox`);
  await kolab.db.query(
    `insert into message(id, kolab_id, sent_by, sent_to, body)
     select '01J' || lpad(g::text, 23, '0'), 'hub', 'cy', 'bo', 'x' from generate_series(1, $1::int) g`, [UNREAD_COUNT_CEILING]);
  await kolab.queuePushes(last);
  expect(((await jobs(kolab))[0].payload as { notifications: { badge: number }[] }).notifications[0].badge).toBe(UNREAD_COUNT_CEILING);
});

test('a refused send tells no listener', async () => {
  const { kolab, ann, sent } = await hub();
  await rejection(kolab.sendMessage(ann, 'nobody', 'refused'));
  await rejection(kolab.sendChannelMessage(ann, 'nope', 'refused'));
  expect(sent).toStrictEqual([]);
});

test('erasing a team removes its prefs and push jobs, and its members keep their devices; an archived team takes no prefs, and its members\' devices go on', async () => {
  const { kolab, ann, bo, sent } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.registerPushDevice(ann, token('a'), 'ios');
  await kolab.setNotificationPrefs(bo, { level: 'all' });
  await kolab.sendMessage(ann, 'bo', 'before the erase');
  await kolab.queuePushes(sent[sent.length - 1]);
  expect((await jobs(kolab)).length).toBe(1);
  await kolab.eraseOwnKolab(ann, 'hub');
  for (const t of ['notification_pref', 'outbox']) expect((await kolab.db.query(`select 1 from ${t}`)).rows).toStrictEqual([]);
  expect((await kolab.db.query(`select actor_id from push_device order by actor_id`)).rows).toStrictEqual([{ actor_id: 'ann' }, { actor_id: 'bo' }]);

  const { kolab: k2, bo: bo2 } = await hub();
  await k2.registerPushDevice(bo2, token('b'), 'ios');
  await k2.setNotificationPrefs(bo2, { level: 'all' });
  await k2.archive({ kolab: 'hub' });
  expect(await rejection(k2.db.query(`update notification_pref set level = 'none'`))).toMatch(/archived/);
  await k2.db.query(`update push_device set last_seen_at = now()`);
});
