import { describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { PALETTES } from '@konjir/brand';
import { MAX_MESSAGE_TEXT } from '@konjir/types';
import { StyleSheet, useColorScheme } from 'react-native';
import Home from '../app/(tabs)/index';
import You from '../app/(tabs)/you';
import DMs from '../app/(tabs)/dms';
import Activity from '../app/(tabs)/activity';
import { themeFor } from '@/theme';
import { NOT_YET } from '@/ui';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn() }));
const scheme = jest.mocked(useColorScheme);

describe('the brand theme', () => {
  test('is Predawn unless the system is light, with libs/brand\'s colours', () => {
    expect(themeFor('dark')).toEqual({ theme: 'dark', name: 'Predawn', colors: PALETTES.dark });
    expect(themeFor(null).name).toBe('Predawn');
    expect(themeFor('unspecified').name).toBe('Predawn');
    expect(themeFor('light')).toEqual({ theme: 'light', name: 'Daybreak', colors: PALETTES.light });
  });

  test.each([['dark', 'Predawn'], ['light', 'Daybreak']] as const)('Home draws in %s mode with %s\'s ink and surface', async (mode, name) => {
    scheme.mockReturnValue(mode);
    await render(<Home />);
    const title = StyleSheet.flatten(screen.getByRole('header', { name: 'Home' }).props.style);
    expect(title).toMatchObject({ color: PALETTES[mode].ink, fontFamily: 'Fraunces', fontWeight: '600' });
    expect(StyleSheet.flatten(screen.getByTestId('home').props.style)).toMatchObject({ backgroundColor: PALETTES[mode].surface });
    for (const section of ['Channels', 'Direct messages', 'Agents']) expect(screen.getByRole('header', { name: section })).toBeOnTheScreen();
    expect(themeFor(mode).name).toBe(name);
  });

  test.each([['Home', Home], ['DMs', DMs], ['Activity', Activity], ['You', You]] as const)('%s says it can\'t sign in yet, and shows nothing that passes for a team', async (_, Tab) => {
    scheme.mockReturnValue('dark');
    await render(<Tab />);
    expect(screen.getByText(NOT_YET)).toBeOnTheScreen();
    expect(screen.queryByText(/general|Nobody yet|Sign in to a team/)).toBeNull();
  });

  test('You names the theme and reads @konjir/types\' limits from their TypeScript source', async () => {
    scheme.mockReturnValue('light');
    await render(<You />);
    expect(screen.getByText('Daybreak')).toBeOnTheScreen();
    expect(screen.getByText(new RegExp(`up to ${MAX_MESSAGE_TEXT.toLocaleString()} characters`))).toBeOnTheScreen();
  });
});
