/**
 * The brand (libs/brand) as React Native styles: Predawn when the system is dark, Daybreak when it
 * is light; the phone's own type (Lee, 2026-11-23: San Francisco on iOS, Roboto on Android, and
 * their monospace), with the brand's voice in its colours, the horizon and the buttons' corners.
 */
import { Platform, useColorScheme } from 'react-native';
import { PALETTES, THEME_NAMES, type Palette, type Theme } from '@konjir/brand';

/** The phone's faces: titles and text in its system face, code in its monospace. `fontWeight` picks the weight. */
const SYSTEM = Platform.select({ ios: 'System', default: 'sans-serif' });
export const FAMILIES = { display: SYSTEM, sans: SYSTEM, mono: Platform.select({ ios: 'Menlo', default: 'monospace' }) } as const;

/**
 * A button's corners, as the web's (apps/web, the design system's Button): fully round at the
 * left, a small top-right and a larger bottom-right, for a button `height` tall.
 */
export const buttonCorners = (height: number) => ({
  borderTopLeftRadius: height / 2, borderBottomLeftRadius: height / 2,
  borderTopRightRadius: height * 0.14, borderBottomRightRadius: height * 0.4,
});

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
