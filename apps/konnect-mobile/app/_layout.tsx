import * as Linking from 'expo-linking';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { remember } from '@/auth/pending-link';
import { DevStart } from '@/dev/DevStart';
import { KolabCache } from '@/kolab/live';
import { useAppTheme } from '@/theme';

// The splash stays up until the stored sign-ins are read, so the tabs never flash before the gate.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  return (
    <AuthProvider>
      <KolabCache>
        <Gate />
      </KolabCache>
    </AuthProvider>
  );
}

/**
 * The auth gate: signed in to no team, the app is the sign-in screen and nothing else; a deep link
 * opened meanwhile is remembered and followed after sign-in. Signing out of the last team comes
 * back here.
 */
function Gate() {
  const auth = useAuth();
  const { theme, colors } = useAppTheme();
  const signedIn = auth.teams.length > 0;
  const url = Linking.useLinkingURL();
  useEffect(() => { void SystemUI.setBackgroundColorAsync(colors.surface); }, [colors.surface]);
  useEffect(() => { if (auth.ready) void SplashScreen.hideAsync().catch(() => undefined); }, [auth.ready]);
  useEffect(() => { if (auth.ready && !signedIn) remember(url); }, [auth.ready, signedIn, url]);
  if (!auth.ready) return null;
  return (
    <>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
      <DevStart />
    </>
  );
}
