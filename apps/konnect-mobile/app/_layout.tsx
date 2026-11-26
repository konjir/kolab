import * as Linking from 'expo-linking';
import { router, Stack, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { restoreTheme } from '@/device-prefs';
import { remember } from '@/auth/pending-link';
import { KolabCache } from '@/kolab/live';
import { teamShown } from '@/notification-open';
import { BackButton, CancelButton } from '@/HeaderButtons';
import { Horizon } from '@/Horizon';
import { PushManager } from '@/PushManager';
import { FAMILIES, useAppTheme } from '@/theme';

// The splash stays up until the stored sign-ins are read, so the tabs never flash before the gate;
// meanwhile the theme chosen on this phone, if it isn't the phone's own, is put back.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
void restoreTheme().catch(() => undefined);

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
  // A new team (switched to, from the switcher or a notification, or moved to by Kolab): back to its
  // Home, every screen of the team before closed, with what was being written in them. Then the
  // conversation a notification's tap was opening in that team, if one waits (notification-open.ts).
  const team = auth.current?.team;
  const shown = useRef(team);
  useEffect(() => {
    if (shown.current && team && shown.current !== team) {
      if (router.canDismiss()) router.dismissAll();
      router.replace('/');
    }
    shown.current = team;
    const tapped = teamShown(team);
    if (!tapped) return;
    const t = setTimeout(() => router.push(tapped as Href), 50);
    return () => clearTimeout(t);
  }, [team]);
  // Kolab moved the sign-in because the person lost the team: say so.
  const { moved, clearMoved } = auth;
  useEffect(() => {
    if (!moved) return;
    Alert.alert(`You're no longer in ${moved.from}`, moved.to ? `konnect moved you to ${moved.to}.` : undefined);
    clearMoved();
  }, [moved, clearMoved]);
  if (!auth.ready) return null;
  return (
    <>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      {/* Pushed screens that show a header have a back chevron of the app's own, which VoiceOver
          calls "Back": iOS's names itself after the screen it goes back to, which here is a route,
          "(tabs)". Swiping back from the edge works as ever. */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface }, headerBackVisible: false, headerLeft: ({ canGoBack }) => (canGoBack ? <BackButton /> : undefined), headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.ink, headerTitleStyle: { fontFamily: FAMILIES.sans, fontWeight: '600' } }}>
        {/* First, so it is where the gate lands while signed out. */}
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" />
          <Stack.Screen name="server" options={{ headerShown: true, title: '' }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="c/[kind]/[name]" />
          <Stack.Screen name="browse" />
          <Stack.Screen name="new" options={{ presentation: 'modal', headerLeft: () => <CancelButton /> }} />
          <Stack.Screen name="profile/[actor]" />
          <Stack.Screen name="agent/[actor]" />
          <Stack.Screen name="team" />
          <Stack.Screen name="notifications" />
          <Stack.Screen name="about" />
          <Stack.Screen name="delete-account" />
          <Stack.Screen name="forward" options={{ presentation: 'modal', headerLeft: () => <CancelButton /> }} />
          <Stack.Screen name="details/[name]" />
          <Stack.Screen name="dev" />
        </Stack.Protected>
      </Stack>
      {signedIn && <PushManager />}
      <Horizon />
    </>
  );
}
