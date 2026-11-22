/**
 * The brand (libs/brand) as React Native styles: Predawn when the system is dark, Daybreak when it
 * is light, and the three faces the app embeds (app.config.ts, expo-font), named by family so
 * `fontWeight` picks the face on both platforms.
 */
import { useColorScheme } from 'react-native';
import { PALETTES, THEME_NAMES, type Palette, type Theme } from '@konjir/brand';

/** The faces' families, as the font files name them (iOS) and app.config.ts declares them (Android). */
export const FAMILIES = { display: 'Fraunces', sans: 'Instrument Sans', mono: 'JetBrains Mono' } as const;

/** libs/brand's radii, in points. */
export const RADII = { hair: 2, md: 6, full: 999 } as const;

export interface AppTheme {
  theme: Theme;
  /** What the theme is called where a person reads its name: Predawn or Daybreak. */
  name: string;
  colors: Palette;
}

/** The theme for a color scheme: Predawn, the brand's default, unless the system is light. */
export function themeFor(scheme: string | null | undefined): AppTheme {
  const theme: Theme = scheme === 'light' ? 'light' : 'dark';
  return { theme, name: THEME_NAMES[theme], colors: PALETTES[theme] };
}

/** The theme the system's appearance asks for now. */
export function useAppTheme(): AppTheme {
  return themeFor(useColorScheme());
}
