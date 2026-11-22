import Constants from 'expo-constants';
import { useCallback } from 'react';
import { localKolab } from '@/dev/local';
import { LogScreen } from '@/dev/LogScreen';
import { runOAuthSpike } from '@/dev/oauth-spike';

/** Phase 0: expo-auth-session against scripts/local-kolab.mts, up to where Kolab refuses a native redirect. */
export default function OAuthSpike() {
  const run = useCallback(async (log: (l: string) => void) => {
    const scheme = Constants.expoConfig?.scheme;
    await runOAuthSpike((await localKolab()).url, Array.isArray(scheme) ? scheme[0]! : scheme!, log);
  }, []);
  return <LogScreen title="OAuth spike" tag="oauth-spike" run={run} />;
}
