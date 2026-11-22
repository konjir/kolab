import { describe, expect, jest, test } from '@jest/globals';
import { forget, openOrKeep, teamShown, TTL_MS } from '../src/notification-open';
import { tapHandler, type Tap } from '../src/notification-taps';

// The native parts load on a phone; only the pure ones are tested here.
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-device', () => ({}));
const { cachedPrefs, prefsArgs, routeOf, DEFAULT_PREFS } = jest.requireActual<typeof import('../src/push')>('../src/push');

describe('push', () => {
  test('prefs become konjir_set_notification_prefs\' arguments: channels once each, sorted, none when nothing notifies', () => {
    expect(prefsArgs({ level: 'all', muted: ['#Design', 'releases', 'design', ''], hidePreview: true, agents: {} })).toEqual({ level: 'all', muted_channels: ['design', 'releases'], hide_preview: true });
    expect(prefsArgs({ level: 'none', muted: ['design'], hidePreview: false, agents: {} })).toEqual({ level: 'none', muted_channels: [], hide_preview: false });
    expect(DEFAULT_PREFS.level).toBe('mentions_and_dms');
    // Only the agent just changed goes to Kolab, which merges per agent: one since removed, still in
    // the prefs on screen, is never resent (Kolab would refuse the save).
    const prefs = { ...DEFAULT_PREFS, agents: { 'ann-helper': 'all' as const, 'ann-gone': 'never' as const } };
    expect(prefsArgs(prefs, { 'ann-helper': 'all' })).toMatchObject({ agents: { 'ann-helper': 'all' } });
    expect(prefsArgs(prefs, { 'ann-helper': 'all' }).agents).not.toHaveProperty('ann-gone');
    expect(prefsArgs(prefs)).not.toHaveProperty('agents');
  });

  test('a notification opens its conversation in its team, as Kolab\'s push data names it', () => {
    expect(routeOf({ team: 'hub', kind: 'channel', channel: 'general', message_id: 'm1' })).toEqual({ team: 'hub', path: '/c/channel/general' });
    expect(routeOf({ team: 'hub', kind: 'dm', with: 'ann/reviewer', message_id: 'm2' })).toEqual({ team: 'hub', path: '/c/dm/ann%2Freviewer' });
    expect(routeOf({ team: 'hub' })).toEqual({ team: 'hub', path: '/' });
    expect(routeOf({ channel: 'general' })).toBeUndefined();
    expect(routeOf(undefined)).toBeUndefined();
  });

  test('one about your agent opens its DM read-only, the channel on its messages, or its screen', () => {
    expect(routeOf({ team: 'hub', kind: 'agent', agent: 'ann-helper', reason: 'message', message_id: 'm', with: 'bo' })).toEqual({ team: 'hub', path: '/c/dm/bo?as=ann-helper' });
    expect(routeOf({ team: 'hub', kind: 'agent', agent: 'ann-helper', reason: 'mention', message_id: 'm', channel: 'general' })).toEqual({ team: 'hub', path: '/c/channel/general?only=ann-helper' });
    expect(routeOf({ team: 'hub', kind: 'agent', agent: 'ann-helper', reason: 'not_running', message_id: 'm' })).toEqual({ team: 'hub', path: '/agent/ann-helper' });
  });

  test('each tap opens once, however often the app is shown it (the listener, the launch, a re-render)', () => {
    const opened: unknown[] = [];
    const handle = tapHandler((d) => opened.push(d));
    const tap = (id: string, date = 1): Tap => ({ notification: { request: { identifier: id, content: { data: { team: 'hub', with: id } } }, date } });
    expect(handle(tap('a'))).toBe(true);
    expect(handle(tap('a'))).toBe(false);
    expect(handle(tap('a'))).toBe(false);
    expect(handle(null)).toBe(false);
    expect(handle(tap('b'))).toBe(true);
    expect(handle(tap('a', 2))).toBe(true);
    expect(opened).toHaveLength(3);
  });

  test('a tap for the team on screen opens at once; one for another team waits for the Gate to show that team, after its reset', () => {
    teamShown('hub');
    expect(openOrKeep({ team: 'hub', path: '/c/channel/general' })).toBe(true);
    expect(teamShown('hub')).toBeUndefined();

    expect(openOrKeep({ team: 'side', path: '/c/dm/bo' })).toBe(false);
    // The Gate shows hub again (a re-render, or a switch elsewhere): nothing opens there.
    expect(teamShown('hub')).toBeUndefined();
    // The switch lands: the Gate has reset to side's Home, and opens the conversation, once.
    expect(teamShown('side')).toBe('/c/dm/bo');
    expect(teamShown('side')).toBeUndefined();
  });

  test('a tap during a switch, before the Gate has shown the new team, waits for it even if the sign-in is already there', () => {
    teamShown('hub');
    // The sign-in is already in side, but the Gate hasn't reset yet: opening now would be undone.
    expect(openOrKeep({ team: 'side', path: '/c/channel/ops' })).toBe(false);
    expect(teamShown('side')).toBe('/c/channel/ops');
  });

  test('a target whose switch failed, or that waited too long, is never opened later', () => {
    teamShown('hub');
    const to = { team: 'side', path: '/c/dm/bo' };
    openOrKeep(to);
    forget(to);
    expect(teamShown('side')).toBeUndefined();

    teamShown('hub');
    openOrKeep(to, 1_000);
    expect(teamShown('side', 1_000 + TTL_MS + 1)).toBeUndefined();
    // Signed out: nothing is shown, and a later sign-in to side opens nothing.
    teamShown(undefined);
    expect(teamShown('side')).toBeUndefined();
  });

  test('the prefs the phone kept read back safely, agents included', () => {
    expect(cachedPrefs('{"level":"all"}')).toEqual({ ...DEFAULT_PREFS, level: 'all', agents: {} });
    expect(cachedPrefs('nope')).toEqual(DEFAULT_PREFS);
    expect(cachedPrefs(null)).toEqual(DEFAULT_PREFS);
  });
});
