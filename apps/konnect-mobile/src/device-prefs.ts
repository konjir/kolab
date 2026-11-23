/**
 * Settings of this phone alone, kept in its kv-store and shared through the query cache, so a
 * change on one screen shows at once on another: whether Home has an Unreads section, and the
 * theme.
 */
import { THEME_STORAGE_KEY } from '@konjir/brand';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Storage from 'expo-sqlite/kv-store';
import { Appearance } from 'react-native';

export const SHOW_UNREADS_KEY = 'konnect.home.showUnreads';
const KEY = ['device', 'showUnreads'] as const;

/** Whether Home lists what is unread in a section of its own. Off until the person turns it on. */
export function useShowUnreads(): [boolean, (on: boolean) => void] {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, staleTime: Infinity, queryFn: async () => (await Storage.getItem(SHOW_UNREADS_KEY).catch(() => null)) === 'on' });
  const set = (on: boolean) => {
    qc.setQueryData(KEY, on);
    void Storage.setItem(SHOW_UNREADS_KEY, on ? 'on' : 'off').catch(() => undefined);
  };
  return [q.data ?? false, set];
}

/** The theme: the phone's appearance (Predawn when it is dark, Daybreak when it is light), or one of the two always. */
export type ThemeChoice = 'device' | 'dark' | 'light';
export const THEME_CHOICES: { choice: ThemeChoice; label: string }[] = [
  { choice: 'device', label: 'Match this phone' },
  { choice: 'dark', label: 'Predawn' },
  { choice: 'light', label: 'Daybreak' },
];
const THEME_KEY = ['device', 'theme'] as const;
const themeChoiceOf = (s: string | null): ThemeChoice => (s === 'dark' || s === 'light' ? s : 'device');

/**
 * The app's appearance, set as the choice says. React Native's override reaches useColorScheme, so
 * every screen's colours follow, and iOS's own (the keyboard, the tab bar, sheets) with them.
 */
export function applyTheme(choice: ThemeChoice) {
  Appearance.setColorScheme(choice === 'device' ? 'unspecified' : choice);
}

/** The choice kept on this phone, applied once as the app starts. */
export async function restoreTheme(): Promise<ThemeChoice> {
  const choice = themeChoiceOf(await Storage.getItem(THEME_STORAGE_KEY).catch(() => null));
  if (choice !== 'device') applyTheme(choice);
  return choice;
}

export function useThemeChoice(): [ThemeChoice, (c: ThemeChoice) => void] {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: THEME_KEY, staleTime: Infinity, queryFn: async () => themeChoiceOf(await Storage.getItem(THEME_STORAGE_KEY).catch(() => null)) });
  const set = (c: ThemeChoice) => {
    applyTheme(c);
    qc.setQueryData(THEME_KEY, c);
    void Storage.setItem(THEME_STORAGE_KEY, c).catch(() => undefined);
  };
  return [q.data ?? 'device', set];
}
