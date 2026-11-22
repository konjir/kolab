import { describe, expect, jest, test } from '@jest/globals';
import { forget, openOrKeep, teamShown, TTL_MS } from '../src/notification-open';
import { tapHandler, type Tap } from '../src/notification-taps';

// The native parts load on a phone; only the pure ones are tested here.
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-device', () => ({}));
const { prefsArgs, routeOf, DEFAULT_PREFS } = jest.requireActual<typeof import('../src/push')>('../src/push');

describe('push', () => {
  test('prefs become konjir_set_notification_prefs\' arguments: channels once each, sorted, none when nothing notifies', () => {
    expect(prefsArgs({ level: 'all', muted: ['#Design', 'releases', 'design', ''], hidePreview: true })).toEqual({ level: 'all', muted_channels: ['design', 'releases'], hide_preview: true });
    expect(prefsArgs({ level: 'none', muted: ['design'], hidePreview: false })).toEqual({ level: 'none', muted_channels: [], hide_preview: false });
    expect(DEFAULT_PREFS.level).toBe('mentions_and_dms');
  });

  test('a notification opens its conversation in its team, as Kolab\'s push data names it', () => {
    expect(routeOf({ team: 'hub', kind: 'channel', channel: 'general', message_id: 'm1' })).toEqual({ team: 'hub', path: '/c/channel/general' });
    expect(routeOf({ team: 'hub', kind: 'dm', with: 'ann/reviewer', message_id: 'm2' })).toEqual({ team: 'hub', path: '/c/dm/ann%2Freviewer' });
    expect(routeOf({ team: 'hub' })).toEqual({ team: 'hub', path: '/' });
    expect(routeOf({ channel: 'general' })).toBeUndefined();
    expect(routeOf(undefined)).toBeUndefined();
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
});
