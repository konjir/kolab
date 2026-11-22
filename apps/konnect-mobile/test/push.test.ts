import { describe, expect, jest, test } from '@jest/globals';
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
});
