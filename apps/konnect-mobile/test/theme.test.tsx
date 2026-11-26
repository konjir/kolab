import { describe, expect, jest, test } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PALETTES } from '@konjir/brand';
import { MAX_MESSAGE_TEXT } from '@konjir/types';
import type { ReactElement } from 'react';
import { Appearance, StyleSheet, useColorScheme } from 'react-native';
import SignIn from '../app/sign-in';
import You from '../app/(tabs)/you';
import About from '../app/about';
import { restoreTheme } from '@/device-prefs';
import { AuthProvider } from '@/auth/AuthProvider';
import type { SecureKV } from '@/auth/store';
import { themeFor } from '@/theme';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('expo-router', () => ({ router: { replace: jest.fn() }, useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }), Stack: { Screen: () => null }, Link: ({ children }: { children: unknown }) => children }));
const mockKv = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItem: async (k: string) => mockKv.get(k) ?? null, setItem: async (k: string, v: string) => { mockKv.set(k, v); }, removeItem: async (k: string) => { mockKv.delete(k); } } }));
const scheme = jest.mocked(useColorScheme);

/** A phone signed in to no team: an empty secure store. */
const empty: SecureKV = { get: async () => null, set: async () => undefined, remove: async () => undefined };
const signedOut = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AuthProvider kv={empty}>{ui}</AuthProvider></QueryClientProvider>);

describe('the brand theme', () => {
  test('is Predawn unless the system is light, with libs/brand\'s colours', () => {
    expect(themeFor('dark')).toEqual({ theme: 'dark', name: 'Predawn', colors: PALETTES.dark });
    expect(themeFor(null).name).toBe('Predawn');
    expect(themeFor('unspecified').name).toBe('Predawn');
    expect(themeFor('light')).toEqual({ theme: 'light', name: 'Daybreak', colors: PALETTES.light });
  });

  test.each([['dark', 'Predawn'], ['light', 'Daybreak']] as const)('the sign-in screen draws in %s mode with %s\'s surface, ink and wordmark', async (mode, name) => {
    scheme.mockReturnValue(mode);
    await signedOut(<SignIn />);
    expect(StyleSheet.flatten(screen.getByTestId('sign-in-screen').props.style)).toMatchObject({ backgroundColor: PALETTES[mode].surface });
    expect(screen.getByLabelText('Konjir')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText(/^Sign in$/).props.style)).toMatchObject({ color: PALETTES[mode]['on-accent'], fontFamily: 'System' });
    expect(themeFor(mode).name).toBe(name);
  });
});

describe('the tabs', () => {
  test('You offers no per-team sign-in, and About names the theme and reads @konjir/types\' limits from their TypeScript source', async () => {
    scheme.mockReturnValue('light');
    await signedOut(<You />);
    expect(await screen.findByText('Not signed in.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign in to a team|Create/ })).toBeNull();
    expect(screen.getByTestId('about')).toBeTruthy();
    await signedOut(<About />);
    expect(screen.getByText('Daybreak')).toBeTruthy();
    expect(screen.getByText(new RegExp(`up to ${MAX_MESSAGE_TEXT.toLocaleString()} characters`))).toBeTruthy();
  });
});

describe('choosing the theme', () => {
  test('You offers the phone\'s appearance, Predawn or Daybreak; a choice overrides the appearance and is kept, and the phone\'s own takes the override off', async () => {
    const set = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
    mockKv.clear();
    await signedOut(<You />);
    const checked = (id: string) => screen.getByTestId(id).props.accessibilityState?.checked;
    await waitFor(() => expect(checked('theme-device')).toBe(true));
    await fireEvent.press(screen.getByTestId('theme-light'));
    expect(set).toHaveBeenLastCalledWith('light');
    await waitFor(() => expect(mockKv.get('konjir.theme')).toBe('light'));
    await waitFor(() => expect(checked('theme-light')).toBe(true));
    expect(checked('theme-device')).toBe(false);
    await fireEvent.press(screen.getByTestId('theme-device'));
    expect(set).toHaveBeenLastCalledWith('unspecified');
    await waitFor(() => expect(mockKv.get('konjir.theme')).toBe('device'));
    set.mockRestore();
  });

  test('a kept choice is put back as the app starts, and none leaves the phone\'s own', async () => {
    const set = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
    mockKv.clear();
    expect(await restoreTheme()).toBe('device');
    expect(set).not.toHaveBeenCalled();
    mockKv.set('konjir.theme', 'dark');
    expect(await restoreTheme()).toBe('dark');
    expect(set).toHaveBeenCalledWith('dark');
    set.mockRestore();
  });
});
