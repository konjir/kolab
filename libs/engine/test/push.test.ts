// Push notifications to konnect's phone app (S4, migration 0058): a person registers their app's
// Expo push token in a team and chooses what they are told of there; each message sent through this
// Kolab queues, in the send's own transaction, one push job naming the message alone when someone it
// reaches has a live device; the job, in the outbox's push lane, reads the message again, decides who
// is pushed it under their prefs, and sends it through the sender the server gives (Expo's push API,
// mocked here), forgetting devices that are no longer registered and retrying with its own backoff.
import { expect, test } from '@jest/globals';
import { MAX_PUSH_DEVICES, PUSH_BATCH, UNREAD_COUNT_CEILING, type SentMessage } from '@konjir/types';
import { PUSH_MAX_AGE_S, wantsPush, type PushMessage, type PushTicket } from '@konjir/engine';
import { createHash, randomBytes } from 'node:crypto';
import { appSignIn, openKolab, rejection, type TestKolab } from '@konjir/engine/testing';

const token = (n: string | number) => `ExponentPushToken[${n}]`;

/**
 * Ann owns `hub`; Bo and Cy write there; Bo has an agent. Each person is signed in through konnect's
 * app, whose sign-in alone registers devices and sets prefs, and the agent has a hand-issued session.
 * `phone` signs a person in again, as another phone of theirs. Push is on, with a sender that records
 * what it is given and answers each with `answer` (ok by default).
 */
async function hub(opts: { answer?: (m: PushMessage) => PushTicket } = {}) {
  const k = await openKolab();
  for (const id of ['ann', 'bo', 'cy']) await k.addActor(id);
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('hub', { owner: 'ann' });
  for (const id of ['bo', 'cy', 'bo-claude']) await k.grant('hub', id, 'write');
  const signIns = { ann: await appSignIn(k, 'ann', 'hub'), bo: await appSignIn(k, 'bo', 'hub'), cy: await appSignIn(k, 'cy', 'hub') };
  const s = {
    ann: signIns.ann.access, bo: signIns.bo.access, cy: signIns.cy.access,
    agent: await k.openSession('bo-claude', 'engineer', { kolab: 'hub' }),
  };
  const phone = async (actor: string, kolab = 'hub') => (await appSignIn(k, actor, kolab)).access;
  const batches: PushMessage[][] = [];
  k.push.send = async (messages) => { batches.push(messages); return messages.map(opts.answer ?? (() => ({ ok: true }))); };
  const sent: SentMessage[] = [];
  k.onMessageSent((m) => sent.push(m));
  /** Runs the push jobs the sends queued, with `listening` the sessions this process hears streams of: what was sent, flattened. */
  const pushed = async (listening: string[] = []) => {
    k.push.listening = () => listening;
    batches.length = 0;
    await k.drainOutbox();
    return { messages: batches.flat() };
  };
  /** A push job for message `id` run again, as if just queued: what it sends now. */
  const rerun = async (id: string, kind: 'dm' | 'channel' = 'dm') => {
    await k.db.query(`insert into outbox(id, kind, version_id, kolab_id, payload) values ($1, 'push', null, 'hub', $2)`, [`~push-${id}-${batches.length}-${Date.now()}`, JSON.stringify({ message: id, kind })]);
    return pushed();
  };
  return { kolab: k, ...s, signIns, phone, batches, sent, pushed, rerun };
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
  await kolab.createKolab('side', { owner: 'bo' });
  const boSide = (await appSignIn(kolab, 'bo', 'side')).access;
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
  const { kolab, phone } = await hub();
  // One device for each sign-in, so a phone each.
  const phones: string[] = [];
  for (let i = 0; i < MAX_PUSH_DEVICES; i++) {
    phones.push(await phone('bo'));
    await kolab.registerPushDevice(phones[i], token(i), 'ios');
  }
  // Device 0 seen again: device 1 is now the stalest.
  await kolab.registerPushDevice(phones[0], token(0), 'ios');
  await kolab.registerPushDevice(await phone('bo'), token('new'), 'android');
  const kept = (await kolab.db.query<{ token: string }>(`select token from push_device where actor_id = 'bo'`)).rows.map((r) => r.token);
  expect(kept.length).toBe(MAX_PUSH_DEVICES);
  expect(kept).toContain(token(0));
  expect(kept).toContain(token('new'));
  expect(kept).not.toContain(token(1));
});

test('notification prefs: mentions_and_dms and nothing muted by default; a level and muted channels by name, which stay when left out; unknown channels and levels refused', async () => {
  const { kolab, bo } = await hub();
  expect(await kolab.notificationPrefs(bo)).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: [], hide_preview: false, agents: { 'bo-claude': 'stuck' } });
  await kolab.makeChannel(bo, 'deploys');
  await kolab.makeChannel(bo, 'alerts');
  expect(await kolab.setNotificationPrefs(bo, { level: 'all', muted_channels: ['#deploys', 'alerts', 'deploys'] }))
    .toStrictEqual({ kolab: 'hub', level: 'all', muted_channels: ['alerts', 'deploys'], hide_preview: false, agents: { 'bo-claude': 'stuck' } });
  expect(await kolab.setNotificationPrefs(bo, { level: 'none' })).toStrictEqual({ kolab: 'hub', level: 'none', muted_channels: ['alerts', 'deploys'], hide_preview: false, agents: { 'bo-claude': 'stuck' } });
  expect(await kolab.setNotificationPrefs(bo, { level: 'mentions_and_dms', muted_channels: [], hide_preview: false, agents: { 'bo-claude': 'stuck' } })).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: [], hide_preview: false, agents: { 'bo-claude': 'stuck' } });
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'all', muted_channels: ['nope', 'general'] }))).toMatch(/LimitError: kolab hub has no channel #nope/);
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'loud' }))).toMatch(/LimitError: level is one of all, mentions_and_dms, none/);
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'all', muted_channels: Array.from({ length: 201 }, (_, i) => `c${i}`) }))).toMatch(/at most 200/);
  expect(await kolab.notificationPrefs(bo)).toStrictEqual({ kolab: 'hub', level: 'mentions_and_dms', muted_channels: [], hide_preview: false, agents: { 'bo-claude': 'stuck' } });
});

test('a direct message to a person with a device queues one push job, which sends the sender, the start of the message, what to open and their unread', async () => {
  const { kolab, ann, bo, cy, phone, batches, sent } = await hub();
  await kolab.registerPushDevice(bo, token('b1'), 'ios');
  await kolab.registerPushDevice(await phone('bo'), token('b2'), 'android');
  await kolab.sendChannelMessage(cy, 'general', 'one unread in general');
  const long = 'x'.repeat(150);
  const m = await kolab.sendMessage(ann, 'bo', long);
  expect(sent[sent.length - 1]).toStrictEqual({ kind: 'dm', kolab: 'hub', id: m.id, from: 'ann', to: 'bo', message: long, recipients: ['bo'] });
  // Queued in the send's own transaction, naming the message alone: no words of it wait in the outbox.
  const queued = await jobs(kolab);
  expect(queued.filter((j) => (j.payload as { message: string }).message === m.id)).toStrictEqual([{ kind: 'push', attempts: 0, payload: { message: m.id, kind: 'dm' } }]);
  expect(JSON.stringify(queued)).not.toContain('xxxxxxxx');
  // The admin's list names the job by its kolab and message, never what it says.
  expect((await kolab.outboxJobs()).filter((j) => j.subject === `hub message ${m.id}`).map((j) => j.kind)).toStrictEqual(['push']);
  batches.length = 0;
  await kolab.drainOutbox();
  // Decided as it runs: the start of the message, read from the message itself, and the unread now.
  const dm = batches.flat().filter((x) => x.data.message_id === m.id);
  expect(dm.map((x) => [x.to, x.title, x.body, x.badge])).toStrictEqual([[token('b1'), 'ann', 'x'.repeat(100), 2], [token('b2'), 'ann', 'x'.repeat(100), 2]]);
  expect(dm[0].data).toStrictEqual({ team: 'hub', kind: 'dm', with: 'ann', message_id: m.id });
  expect(await jobs(kolab)).toStrictEqual([]);
});

test('the job sends one push per device, and a channel message\'s title names the channel', async () => {
  const { kolab, ann, bo, phone, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b1'), 'ios');
  await kolab.registerPushDevice(await phone('bo'), token('b2'), 'android');
  const m = await kolab.sendChannelMessage(ann, 'general', 'deploy is green, @bo', { mentions: ['bo'] });
  const r = await pushed();
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
  expect(await kolab.setNotificationPrefs(bo, { level: 'all', hide_preview: true, agents: { 'bo-claude': 'stuck' } })).toStrictEqual({ kolab: 'hub', level: 'all', muted_channels: [], hide_preview: true, agents: { 'bo-claude': 'stuck' } });
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
  expect((await jobs(kolab)).length).toBe(1);
  kolab.push.send = null;
  await kolab.sendMessage(ann, 'bo', 'sent while off');
  expect((await jobs(kolab)).length).toBe(1);
  // Push off on this process from the start: the job is dropped, and says so.
  await kolab.drainOutbox();
  expect(await jobs(kolab)).toStrictEqual([]);
  expect(sent.length).toBe(2);
});

test('a device registered from the app\'s sign-in gets nothing once that sign-in is revoked, lapses, or has no open session', async () => {
  const { kolab, ann, bo, signIns, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.sendMessage(ann, 'bo', 'while signed in');
  expect((await pushed()).messages.length).toBe(1);
  // The grant's session ended, the grant itself still live: nothing.
  const grant = (await kolab.db.query<{ grant_id: string }>(`select grant_id from push_device`)).rows[0].grant_id;
  await kolab.db.query(`update session set ended_at = now(), ended_by = 'bo' where grant_id = $1 and ended_at is null`, [grant]);
  await kolab.sendMessage(ann, 'bo', 'with no session');
  expect((await pushed()).messages).toStrictEqual([]);
  // Lapsed.
  await kolab.db.query(`update session set ended_at = null, ended_by = null where id = $1`, [signIns.bo.session]);
  await kolab.sendMessage(ann, 'bo', 'open again');
  expect((await pushed()).messages.length).toBe(1);
  await kolab.db.query(`update oauth_grant set expires_at = now() - interval '1 second' where id = $1`, [grant]);
  await kolab.sendMessage(ann, 'bo', 'after it lapsed');
  expect((await pushed()).messages).toStrictEqual([]);
  // Revoked, by signing out.
  await kolab.db.query(`update oauth_grant set expires_at = now() + interval '1 day' where id = $1`, [grant]);
  expect(await kolab.revokeToken(signIns.bo.refresh)).toBe(true);
  await kolab.sendMessage(ann, 'bo', 'after signing out');
  expect((await pushed()).messages).toStrictEqual([]);
  // A device with no sign-in at all, as one from before only the app could register, is never pushed to.
  await kolab.db.query(`update push_device set grant_id = null`);
  await kolab.sendMessage(ann, 'bo', 'no sign-in');
  expect((await pushed()).messages).toStrictEqual([]);
});

test('only konnect\'s app\'s sign-in registers a device, unregisters one or sets prefs: a hosted client\'s, the CLI\'s and a hand-issued session are refused; a second token from the same sign-in evicts the first', async () => {
  const { kolab, ann, bo, phone, pushed } = await hub();
  // A hosted MCP client signed in as Bo himself, and his CLI on loopback, and a hand-issued session.
  const signedIn = async (redirectUri: string, scope?: string) => {
    const client = (await kolab.registerClient({ name: 'Some client', redirectUris: [redirectUri] })).id;
    const verifier = randomBytes(32).toString('base64url');
    const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), ...(scope ? { scope } : {}) });
    const { csrf } = await kolab.identifyAuthorization(binding, state, 'bo');
    const { code } = scope
      ? await kolab.consentPerson(binding, csrf, { kolab: 'hub' })
      : await kolab.consent(binding, csrf, { as: { kind: 'self' }, kolab: 'hub', role: 'product' });
    return (await kolab.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier })).accessToken;
  };
  const hosted = await signedIn('https://app.example/cb');
  const cli = await signedIn('http://127.0.0.1:9/cb', 'konjir choose:kolab');
  await kolab.addActor('dee');
  await kolab.grant('hub', 'dee', 'write');
  const hand = await kolab.openSession('dee', 'product', { kolab: 'hub' });
  for (const [who, s, why] of [['hosted', hosted, /registering a device for push is for konnect's own app only/], ['cli', cli, /is for konnect's own app only/], ['hand', hand, /this session is no sign-in through an app/]] as const) {
    expect([who, await rejection(kolab.registerPushDevice(s, token(who), 'ios'))]).toStrictEqual([who, expect.stringMatching(why)]);
    expect([who, await rejection(kolab.unregisterPushDevice(s, token(who)))]).toStrictEqual([who, expect.stringMatching(/is for konnect's own app|no sign-in through an app/)]);
    expect([who, await rejection(kolab.setNotificationPrefs(s, { level: 'all' }))]).toStrictEqual([who, expect.stringMatching(/is for konnect's own app|no sign-in through an app/)]);
    expect([who, await rejection(kolab.notificationPrefs(s))]).toStrictEqual([who, expect.stringMatching(/is for konnect's own app|no sign-in through an app/)]);
  }
  expect((await kolab.db.query(`select 1 from push_device`)).rows).toStrictEqual([]);

  // One device per sign-in: an intruder's token named from Bo's grant is evicted when the app registers its own again at launch.
  await kolab.registerPushDevice(bo, token('intruder'), 'ios');
  await kolab.registerPushDevice(bo, token('real'), 'ios');
  expect((await kolab.db.query<{ token: string }>(`select token from push_device order by token`)).rows.map((r) => r.token)).toStrictEqual([token('real')]);
  // Another phone of his, its own sign-in, keeps its own.
  await kolab.registerPushDevice(await phone('bo'), token('tablet'), 'android');
  await kolab.sendMessage(ann, 'bo', 'to both');
  expect((await pushed()).messages.map((m) => m.to).sort()).toStrictEqual([token('real'), token('tablet')]);
});

test('a device Expo says is no longer registered is forgotten; other refusals are logged and not retried', async () => {
  const { kolab, ann, bo, cy, phone, pushed } = await hub({
    answer: (m) => (m.to === token('gone') ? { ok: false, unregistered: true, error: 'DeviceNotRegistered' }
      : m.to === token('big') ? { ok: false, unregistered: false, error: 'MessageTooBig' } : { ok: true }),
  });
  await kolab.registerPushDevice(bo, token('gone'), 'ios');
  await kolab.registerPushDevice(await phone('bo'), token('ok'), 'ios');
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
    // One device for each sign-in: a phone each.
    for (let d = 0; d < MAX_PUSH_DEVICES; d++) await kolab.registerPushDevice((await appSignIn(kolab, id, 'hub')).access, token(`${id}-${d}`), 'ios');
  }
  let failNext = false;
  kolab.push.send = async (messages) => {
    batches.push(messages);
    if (failNext) { failNext = false; throw new Error('Expo\'s push service answered 503'); }
    failNext = true;   // the second batch fails, once
    return messages.map(() => ({ ok: true as const }));
  };
  await kolab.sendChannelMessage(ann, 'general', 'everyone', { mentions: people });
  expect((await jobs(kolab)).length).toBe(1);
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
  const { kolab, ann, bo, cy, sent, rerun } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.makeChannel(cy, 'deploys');
  await kolab.sendChannelMessage(cy, 'deploys', 'not followed, no mention');
  await kolab.sendChannelMessage(cy, 'deploys', 'not followed, mentioned', { mentions: ['bo'] });
  await kolab.sendChannelMessage(cy, 'general', 'followed');
  await kolab.sendMessage(cy, 'bo', 'direct');
  await kolab.sendMessage(ann, 'bo', 'and this one');
  const last = sent[sent.length - 1];
  await kolab.db.query(`delete from outbox`);
  const badge = async () => (await rerun(last.id)).messages.map((m) => m.badge);
  expect(await badge()).toStrictEqual([4]);
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
  await kolab.db.query(`delete from outbox`);
  expect(await badge()).toStrictEqual([5]);
  await kolab.db.query(
    `insert into message(id, kolab_id, sent_by, sent_to, body)
     select '01J' || lpad(g::text, 23, '0'), 'hub', 'cy', 'bo', 'x' from generate_series(1, $1::int) g`, [UNREAD_COUNT_CEILING]);
  expect(await badge()).toStrictEqual([UNREAD_COUNT_CEILING]);
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
  expect((await jobs(kolab)).length).toBe(1);
  expect(sent.length).toBe(1);
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

test('a slow push holds the push lane, never the worker: with another push due behind it, the worker\'s timer leaves push jobs to the lane and does not spin', async () => {
  const { kolab, ann, bo, batches } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  kolab.push.send = async (messages) => { batches.push(messages); await gate; return messages.map(() => ({ ok: true as const })); };
  await kolab.sendMessage(ann, 'bo', 'first, sent slowly');
  await kolab.sendMessage(ann, 'bo', 'second, due behind it');
  const query = kolab.db.query.bind(kolab.db);
  let queries = 0;
  kolab.db.query = (async (sql: string, params?: unknown[]) => { queries++; return query(sql, params); }) as typeof kolab.db.query;
  kolab.startWorker();
  const until = async (done: () => Promise<boolean> | boolean) => { for (let i = 0; i < 200 && !(await done()); i++) await new Promise((r) => setTimeout(r, 25)); };
  await until(() => batches.length === 1);
  expect(batches.length).toBe(1);
  // The first push waits on the service; the second is due, and the lane takes it once the first is done.
  queries = 0;
  await new Promise((r) => setTimeout(r, 1000));
  // Before, the worker's timer fell to its 20 ms floor and read the outbox about 200 times a second.
  expect(queries).toBeLessThan(20);
  release();
  await until(async () => (await jobs(kolab)).length === 0);
  expect(batches.map((b) => b[0].body)).toStrictEqual(['first, sent slowly', 'second, due behind it']);
});

test('a push job decides as it runs: a direct message\'s recipient removed from the team since is pushed nothing, as a channel\'s member is not', async () => {
  const { kolab, ann, bo, cy, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.setNotificationPrefs(bo, { level: 'all' });
  await kolab.sendMessage(ann, 'bo', 'before he left');
  await kolab.sendChannelMessage(cy, 'general', 'to everyone, before he left');
  expect((await jobs(kolab)).length).toBe(2);
  await kolab.revoke('hub', 'bo');
  expect((await pushed()).messages).toStrictEqual([]);
  expect(await jobs(kolab)).toStrictEqual([]);
});

test(`a push job older than ${PUSH_MAX_AGE_S / 60} minutes is dropped as stale: an archived team unarchived later pushes none of its old messages`, async () => {
  const { kolab, ann, bo, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.sendMessage(ann, 'bo', 'sent before the archive');
  await kolab.archive({ kolab: 'hub' });
  // Its job waits while the team is archived.
  expect((await pushed()).messages).toStrictEqual([]);
  expect((await jobs(kolab)).length).toBe(1);
  await kolab.unarchive({ kolab: 'hub' });
  await kolab.db.query(`update outbox set created_at = clock_timestamp() - make_interval(secs => $1)`, [PUSH_MAX_AGE_S + 1]);
  expect((await pushed()).messages).toStrictEqual([]);
  expect(await jobs(kolab)).toStrictEqual([]);
});

test('a push job just short of the age limit still goes', async () => {
  const { kolab, ann, bo, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  await kolab.sendMessage(ann, 'bo', 'late, not stale');
  await kolab.db.query(`update outbox set created_at = clock_timestamp() - make_interval(secs => $1)`, [PUSH_MAX_AGE_S - 60]);
  expect((await pushed()).messages.map((m) => m.body)).toStrictEqual(['late, not stale']);
});

test('per-agent prefs: stuck by default, set by label for one\'s own agents only, the rest kept; never, stuck and all decide what the owner is pushed of an agent', async () => {
  const { kolab, ann, bo, cy, agent, pushed } = await hub();
  await kolab.registerPushDevice(bo, token('b'), 'ios');
  expect((await kolab.notificationPrefs(bo)).agents).toStrictEqual({ 'bo-claude': 'stuck' });
  expect((await kolab.notificationPrefs(ann)).agents).toStrictEqual({});
  expect(await rejection(kolab.setNotificationPrefs(bo, { level: 'mentions_and_dms', agents: { claude: 'loud' } }))).toMatch(/LimitError: each agent's choice is one of never, stuck, all/);
  expect(await rejection(kolab.setNotificationPrefs(ann, { level: 'mentions_and_dms', agents: { 'bo/claude': 'all' } }))).toMatch(/LimitError: bo\/claude names no agent of yours in kolab hub/);
  const agentPushes = async () => (await pushed()).messages.filter((m) => m.data.kind === 'agent');

  // stuck, the default: nothing runs as it (no listen stream, no state), so a direct message to it says so, once an hour.
  const d1 = await kolab.sendMessage(ann, 'bo-claude', 'are you there?');
  expect((await agentPushes()).map((m) => [m.title, m.body, m.data])).toStrictEqual([[
    "bo/claude isn't running", 'A message waits for it, and nothing is running as it.', { team: 'hub', kind: 'agent', agent: 'bo-claude', reason: 'not_running', message_id: d1.id, with: 'ann' },
  ]]);
  await kolab.sendMessage(ann, 'bo-claude', 'still there?');
  expect(await agentPushes()).toStrictEqual([]);
  // An hour on, again.
  await kolab.db.query(`update notification_pref set agents_stuck_pushed = '{"bo-claude": "2000-01-01T00:00:00Z"}' where actor_id = 'bo'`);
  await kolab.sendMessage(cy, 'bo-claude', 'hello?');
  expect((await agentPushes()).map((m) => m.data)).toMatchObject([{ reason: 'not_running' }]);
  // Running: no stuck push. A message from Bo himself: none either.
  kolab.push.agentRunning = () => true;
  await kolab.db.query(`update notification_pref set agents_stuck_pushed = '{}'`);
  await kolab.sendMessage(ann, 'bo-claude', 'while it runs');
  expect(await agentPushes()).toStrictEqual([]);

  // all: each direct message to it, and each mention of it, from someone else; by label.
  expect((await kolab.setNotificationPrefs(bo, { level: 'mentions_and_dms', agents: { claude: 'all' } })).agents).toStrictEqual({ 'bo-claude': 'all' });
  const d2 = await kolab.sendMessage(ann, 'bo-claude', 'the plan');
  expect((await agentPushes()).map((m) => [m.title, m.body, m.data])).toStrictEqual([['ann to bo/claude', 'the plan', { team: 'hub', kind: 'agent', agent: 'bo-claude', reason: 'message', message_id: d2.id, with: 'ann' }]]);
  const c1 = await kolab.sendChannelMessage(cy, 'general', 'over to you, @bo/claude', { mentions: ['bo/claude'] });
  expect((await agentPushes()).map((m) => [m.title, m.data])).toStrictEqual([['cy in #general, to bo/claude', { team: 'hub', kind: 'agent', agent: 'bo-claude', reason: 'mention', message_id: c1.id, channel: 'general' }]]);
  await kolab.sendMessage(bo, 'bo-claude', 'from Bo himself');
  expect(await agentPushes()).toStrictEqual([]);
  // Bo mentioned in the same message is told of it once, as himself.
  await kolab.sendChannelMessage(cy, 'general', '@bo and @bo/claude', { mentions: ['bo', 'bo/claude'] });
  expect((await pushed()).messages.map((m) => m.data.kind)).toStrictEqual(['channel']);

  // Capped: the agent's own message that reaches the cap says so, under all or stuck, once an hour.
  await kolab.setAgentReplyCap(ann, 2);
  await kolab.sendChannelMessage(agent, 'general', 'one');
  expect(await agentPushes()).toStrictEqual([]);
  const capped = await kolab.sendChannelMessage(agent, 'general', 'two');
  expect((await agentPushes()).map((m) => [m.title, m.data.kind === 'agent' && m.data.reason, m.data.message_id])).toStrictEqual([['bo/claude is stuck', 'capped', capped.id]]);
  await kolab.sendChannelMessage(agent, 'general', 'past it');
  expect(await agentPushes()).toStrictEqual([]);

  // never: nothing; the agents left out keep theirs.
  expect((await kolab.setNotificationPrefs(bo, { level: 'mentions_and_dms', agents: { 'bo/claude': 'never' } })).agents).toStrictEqual({ 'bo-claude': 'never' });
  expect((await kolab.setNotificationPrefs(bo, { level: 'mentions_and_dms' })).agents).toStrictEqual({ 'bo-claude': 'never' });
  await kolab.sendMessage(ann, 'bo-claude', 'anything');
  await kolab.sendChannelMessage(agent, 'general', 'three');
  expect(await agentPushes()).toStrictEqual([]);
  // Level none: nothing, whatever the agent's choice.
  await kolab.setNotificationPrefs(bo, { level: 'none', agents: { claude: 'all' } });
  await kolab.sendMessage(ann, 'bo-claude', 'anything');
  expect(await agentPushes()).toStrictEqual([]);
});
