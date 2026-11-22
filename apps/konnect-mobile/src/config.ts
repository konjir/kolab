/** What app.config.ts put in the build: its variant and the Kolab it talks to. */
import Constants from 'expo-constants';

export interface AppExtra { variant: 'development' | 'preview' | 'production'; konnectUrl: string }

export function appExtra(): AppExtra {
  const extra = (Constants.expoConfig?.extra ?? {}) as Partial<AppExtra>;
  return { variant: extra.variant ?? 'development', konnectUrl: extra.konnectUrl ?? 'https://kolab.konjir.com/mcp' };
}
