import { describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { PALETTES } from '@konjir/brand';
import { MAX_MESSAGE_TEXT } from '@konjir/types';
import type { ReactElement } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import SignIn from '../app/sign-in';
import You from '../app/(tabs)/you';
import DMs from '../app/(tabs)/dms';
import Activity from '../app/(tabs)/activity';
import { AuthProvider } from '@/auth/AuthProvider';
import type { SecureKV } from '@/auth/store';
import { themeFor } from '@/theme';
import { NOT_BUILT } from '@/ui';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('expo-router', () => ({ router: { replace: jest.fn() }, useRouter: () => ({ navigate: jest.fn() }) }));
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

  test.each([['dark', 'Predawn'], ['light', 'Daybreak']] as const)('the sign-in screen draws in %s mode with %s\'s surface, ink and wordmark', async (mode, name) => {
    scheme.mockReturnValue(mode);
    await signedOut(<SignIn />);
    expect(StyleSheet.flatten(screen.getByTestId('sign-in-screen').props.style)).toMatchObject({ backgroundColor: PALETTES[mode].surface });
    expect(screen.getByLabelText('Konjir')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByText(/Sign in with GitHub/).props.style)).toMatchObject({ color: PALETTES[mode]['on-accent'], fontFamily: 'Instrument Sans' });
    expect(themeFor(mode).name).toBe(name);
  });
});

describe('the tabs', () => {
  test.each([['DMs', DMs], ['Activity', Activity]] as const)('%s says it isn\'t built yet', async (_, Tab) => {
    await signedOut(<Tab />);
    expect(screen.getByText(NOT_BUILT)).toBeTruthy();
  });

  test('You offers another sign-in and making a team, names the theme, and reads @konjir/types\' limits from their TypeScript source', async () => {
    scheme.mockReturnValue('light');
    await signedOut(<You />);
    expect(await screen.findByText('Not signed in to any team.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in to a team' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.getByText('Daybreak')).toBeTruthy();
    expect(screen.getByText(new RegExp(`up to ${MAX_MESSAGE_TEXT.toLocaleString()} characters`))).toBeTruthy();
  });
});
