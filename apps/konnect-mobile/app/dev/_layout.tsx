import { Redirect, Stack } from 'expo-router';
import { appExtra } from '@/config';

/** Phase 0's spikes and the brand sheet: in the development variant only. */
export default function DevLayout() {
  if (appExtra().variant !== 'development') return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: true }} />;
}
