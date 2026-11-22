import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { AuthProvider } from '@/auth/AuthProvider';
import { DevStart } from '@/dev/DevStart';
import { useAppTheme } from '@/theme';

export default function RootLayout() {
  const { theme, colors } = useAppTheme();
  useEffect(() => { void SystemUI.setBackgroundColorAsync(colors.surface); }, [colors.surface]);
  return (
    <AuthProvider>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }}>
        <Stack.Screen name="(tabs)" />
      </Stack>
      <DevStart />
    </AuthProvider>
  );
}
