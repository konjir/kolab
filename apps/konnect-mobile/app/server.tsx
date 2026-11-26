import { router, Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { defaultServer, RUN_YOUR_OWN_URL, serverName } from '@/server';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Body, Button, Problem, Screen, Section } from '@/ui';

/**
 * The Kolab server konnect signs in to, chosen while signed out: Konjir's own, where anyone can sign
 * up, or a team's own Kolab. A server is kept only once a Kolab answers there.
 */
export default function Server() {
  const auth = useAuth();
  const { colors } = useAppTheme();
  const [typed, setTyped] = useState(auth.server.isDefault ? '' : serverName(auth.url));
  const [busy, setBusy] = useState<'use' | 'konjir'>();
  const [problem, setProblem] = useState<string>();
  const input = [styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }];

  const use = async (which: 'use' | 'konjir') => {
    setBusy(which); setProblem(undefined);
    try {
      await auth.server.use(which === 'konjir' ? null : typed);
      if (router.canGoBack()) router.back(); else router.replace('/sign-in');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Screen title="Server" testID="server-screen">
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      <Body>
        konnect is the app for Kolab, where a team&apos;s people and agents talk. It comes set to {serverName(defaultServer())}. Konjir runs the Kolab at kolab.konjir.com, where anyone can sign up; if your team runs its own, enter its address.
      </Body>
      <Section title="Now">
        <Body mono>{serverName(auth.url)}</Body>
      </Section>
      <View style={styles.form}>
        <TextInput
          testID="server-address" value={typed} onChangeText={setTyped} placeholder="kolab.example.com"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" returnKeyType="go"
          onSubmitEditing={() => void use('use')} placeholderTextColor={colors['ink-muted']} style={input}
        />
        <Button testID="use-server" label={busy === 'use' ? 'Checking' : 'Use this server'} busy={!!busy} onPress={() => void use('use')} />
        {!auth.server.isDefault && (
          <Button testID="use-konjir" quiet label={busy === 'konjir' ? 'Checking' : `Use ${serverName(defaultServer())}`} busy={!!busy} onPress={() => void use('konjir')} />
        )}
        {problem && <Problem>{problem}</Problem>}
      </View>
      <Body>
        Each server has its own sign-in. Kolab&apos;s source is public: to run one for your team, see{' '}
        <Text testID="run-your-own" accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(RUN_YOUR_OWN_URL)} style={[styles.link, { color: colors.accent }]}>Running your own Kolab</Text>.
      </Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 },
  link: { fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 11, fontFamily: FAMILIES.sans, fontSize: 15 },
});
