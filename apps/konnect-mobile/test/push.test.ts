import { describe, expect, jest, test } from '@jest/globals';

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

  test('a notification opens its conversation in its team', () => {
    expect(routeOf({ team: 'hub', channel: 'general' })).toEqual({ team: 'hub', path: '/c/channel/general' });
    expect(routeOf({ team: 'hub', with: 'ann/reviewer' })).toEqual({ team: 'hub', path: '/c/dm/ann%2Freviewer' });
    expect(routeOf({ team: 'hub' })).toEqual({ team: 'hub', path: '/' });
    expect(routeOf({ channel: 'general' })).toBeUndefined();
    expect(routeOf(undefined)).toBeUndefined();
  });
});
