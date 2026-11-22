import { describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { PALETTES } from '@konjir/brand';
import { MAX_MESSAGE_TEXT } from '@konjir/types';
import type { ReactElement } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import Home from '../app/(tabs)/index';
import You from '../app/(tabs)/you';
import DMs from '../app/(tabs)/dms';
import Activity from '../app/(tabs)/activity';
import { AuthProvider } from '@/auth/AuthProvider';
import type { SecureKV } from '@/auth/store';
import { themeFor } from '@/theme';
import { NOT_BUILT } from '@/ui';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));
const scheme = jest.mocked(useColorScheme);

/** A phone signed in to no team: an empty secure store. */
const empty: SecureKV = { get: async () => null, set: async () => undefined, remove: async () => undefined };
const signedOut = (ui: ReactElement) => render(<AuthProvider kv={empty}>{ui}</AuthProvider>);

describe('the brand theme', () => {
  test('is Predawn unless the system is light, with libs/brand\'s colours', () => {
    expect(themeFor('dark')).toEqual({ theme: 'dark', name: 'Predawn', colors: PALETTES.dark });
    expect(themeFor(null).name).toBe('Predawn');
    expect(themeFor('unspecified').name).toBe('Predawn');
    expect(themeFor('light')).toEqual({ theme: 'light', name: 'Daybreak', colors: PALETTES.light });
  });

  test.each([['dark', 'Predawn'], ['light', 'Daybreak']] as const)('Home draws in %s mode with %s\'s ink and surface', async (mode, name) => {
    scheme.mockReturnValue(mode);
    await signedOut(<Home />);
    await screen.findByText(/aren't signed in to a team/);
    const title = StyleSheet.flatten(screen.getByRole('header', { name: 'Home' }).props.style);
    expect(title).toMatchObject({ color: PALETTES[mode].ink, fontFamily: 'Fraunces', fontWeight: '600' });
    expect(StyleSheet.flatten(screen.getByTestId('home').props.style)).toMatchObject({ backgroundColor: PALETTES[mode].surface });
    expect(themeFor(mode).name).toBe(name);
  });
});

describe('signed out', () => {
  test('Home says so, offers sign-in, and shows nothing that passes for a team', async () => {
    scheme.mockReturnValue('dark');
    await signedOut(<Home />);
    expect(await screen.findByText(/aren't signed in to a team/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in on the You tab' })).toBeOnTheScreen();
    expect(screen.queryByText(/general/)).toBeNull();
  });

  test.each([['DMs', DMs], ['Activity', Activity]] as const)('%s says it isn\'t built yet', async (_, Tab) => {
    await signedOut(<Tab />);
    expect(screen.getByText(NOT_BUILT)).toBeOnTheScreen();
  });

  test('You offers sign-in and making a team, names the theme, and reads @konjir/types\' limits from their TypeScript source', async () => {
    scheme.mockReturnValue('light');
    await signedOut(<You />);
    expect(await screen.findByText('Not signed in to any team.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Sign in to a team' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Create' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
    expect(screen.getByText('Daybreak')).toBeOnTheScreen();
    expect(screen.getByText(new RegExp(`up to ${MAX_MESSAGE_TEXT.toLocaleString()} characters`))).toBeOnTheScreen();
  });
});
