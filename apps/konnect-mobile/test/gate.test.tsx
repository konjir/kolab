import { describe, expect, jest, test } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import type { SecureKV } from '../src/auth/store';

jest.mock('expo-sqlite/kv-store', () => {
  const m = new Map<string, string>();
  return { __esModule: true, default: { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); }, removeItem: async (k: string) => { m.delete(k); } } };
});

/** The secure store, as a Map, with `teams` signed in at the app's default Kolab URL. */
function storeWith(teams: string[]): SecureKV {
  const ns = 'konnect.kolab.konjir.com_mcp';
  const m = new Map<string, string>();
  if (teams.length) {
    m.set(`${ns}.teams`, JSON.stringify(teams));
    for (const t of teams) m.set(`${ns}.login.${t}`, JSON.stringify({ team: t, actor: 'ann', role: 'product', url: 'https://kolab.konjir.com/mcp', clientId: 'kjcl_x', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 600_000 }));
  }
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } };
}

let mockKv: SecureKV;
jest.mock('../src/auth/AuthProvider', () => {
  const actual = jest.requireActual<typeof import('../src/auth/AuthProvider')>('../src/auth/AuthProvider');
  return { ...actual, AuthProvider: ({ children }: { children: ReactNode }) => <actual.AuthProvider kv={mockKv}>{children}</actual.AuthProvider> };
});
// Push: a simulator gets no token (Device.isDevice is false), and nothing is tapped.
jest.mock('expo-device', () => ({ isDevice: false }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), addNotificationResponseReceivedListener: () => ({ remove: jest.fn() }), getLastNotificationResponse: () => null, setBadgeCountAsync: async () => true }));
// Home reads the team from Kolab; here the gate is what's tested, so nothing answers.
jest.mock('../src/auth/mcp', () => ({ teamClient: () => new Promise(() => undefined) }));

const routes = () => ({
  _layout: require('../app/_layout').default,
  'sign-in': require('../app/sign-in').default,
  '(tabs)/_layout': require('../app/(tabs)/_layout').default,
  '(tabs)/index': require('../app/(tabs)/index').default,
  '(tabs)/you': require('../app/(tabs)/you').default,
  '(tabs)/dms': require('../app/(tabs)/dms').default,
  '(tabs)/activity': require('../app/(tabs)/activity').default,
  '+not-found': require('../app/+not-found').default,
});

describe('the auth gate', () => {
  test('signed in to no team, the app is the sign-in screen and nothing else, even for a deep link', async () => {
    mockKv = storeWith([]);
    await renderRouter(routes(), { initialUrl: '/expo-development-client?url=http%3A%2F%2F127.0.0.1%3A8081' });
    expect(await screen.findByTestId('sign-in-screen')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy();
    expect(screen.getByLabelText('Konjir')).toBeTruthy();
    expect(screen.queryByTestId('you')).toBeNull();
    expect(screen.queryByTestId('home')).toBeNull();
  });

  test('signed in, the tabs, and no sign-in screen', async () => {
    mockKv = storeWith(['hub']);
    await renderRouter(routes(), { initialUrl: '/' });
    expect(await screen.findByTestId('home')).toBeTruthy();
    expect(screen.queryByTestId('sign-in-screen')).toBeNull();
  });
});
