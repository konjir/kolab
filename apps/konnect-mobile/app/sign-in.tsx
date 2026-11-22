import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { takePending } from '@/auth/pending-link';
import { SignInStopped } from '@/auth/sign-in';
import { FAMILIES, useAppTheme } from '@/theme';
import { Button, Problem } from '@/ui';
import { Wordmark } from '@/Wordmark';

/**
 * The only screen while no team is signed in (the root layout's guard). One button: Kolab's page,
 * in the system's auth session, signs the person in with GitHub and lets them pick a team, accept
 * an invitation or make a team.
 */
export default function SignIn() {
  const auth = useAuth();
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const signIn = async () => {
    setBusy(true); setProblem(undefined);
    try {
      await auth.signIn({ kind: 'choose' });
      const next = takePending();
      if (next) router.replace(next as Href);
    } catch (e) {
      setProblem(e instanceof SignInStopped ? `Not signed in: ${e.message}.` : `Couldn't sign in: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="sign-in-screen" style={[styles.screen, { backgroundColor: colors.surface }]}>
      <View style={styles.middle}>
        <Wordmark height={64} />
        <Text style={[styles.tagline, { color: colors['ink-muted'] }]}>konnect: your team&apos;s people and agents, in one place.</Text>
      </View>
      <View style={styles.bottom}>
        <Button testID="sign-in-github" label={busy ? 'Signing in' : 'Sign in with GitHub'} busy={busy} onPress={() => void signIn()} />
        {problem && <Problem>{problem}</Problem>}
        <Text style={[styles.small, { color: colors['ink-muted'] }]}>Kolab&apos;s page opens: sign in with GitHub there, then pick a team, accept an invitation or make a team.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, justifyContent: 'space-between' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 },
  tagline: { fontFamily: FAMILIES.display, fontSize: 18, textAlign: 'center' },
  bottom: { gap: 14, paddingBottom: 24 },
  small: { fontFamily: FAMILIES.sans, fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
