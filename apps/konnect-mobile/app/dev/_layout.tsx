import { Stack } from 'expo-router';
import { appExtra } from '@/config';
import { Hint, Screen } from '@/ui';

/**
 * Phase 0's spikes and the brand sheet: behind the sign-in gate like every screen (the root
 * layout), and in the development variant only. No redirect from here: one inside a guarded stack
 * sends the router round in a loop.
 */
export default function DevLayout() {
  if (appExtra().variant !== 'development') return <Screen title="Not here"><Hint>The spikes are in development builds only.</Hint></Screen>;
  return <Stack screenOptions={{ headerShown: true }} />;
}
