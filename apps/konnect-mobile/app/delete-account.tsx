import { Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { AccountBlocked, DELETION_EXPLAINED, type AccountDeletionBlocker } from '@/kolab/account';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Body, Hint, Problem, Row, Screen, Section } from '@/ui';

/**
 * Delete account, from You (App Store guideline 5.1.1(v); Lee's decision of 2026-11-23, "remove me,
 * keep my words"): what deleting does, in plain words, and the person's name to type before it
 * runs. Kolab refuses while they own a team someone else is in, and the app lists each such team.
 * Deleted, the phone is signed out of every team, as Sign out does, and lands on the sign-in screen.
 */
export default function DeleteAccount() {
  const auth = useAuth();
  const { colors } = useAppTheme();
  const me = auth.current?.actor ?? '';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [blockers, setBlockers] = useState<AccountDeletionBlocker[]>([]);
  const named = typed.trim().replace(/^@/, '');

  const run = async () => {
    if (named !== me) { setProblem(`Type ${me} to delete your account.`); return; }
    setBusy(true); setProblem(undefined); setBlockers([]);
    try {
      // Signed out once it's done: the gate shows the sign-in screen in place of this one.
      await auth.deleteAccount(named);
    } catch (e) {
      if (e instanceof AccountBlocked) setBlockers(e.blockers);
      else setProblem((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Screen title="Delete account" testID="delete-account">
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      <Section title="What happens">
        <View style={styles.list}>
          {DELETION_EXPLAINED.map((line) => <Body key={line}>{`•  ${line}`}</Body>)}
        </View>
      </Section>
      {blockers.length > 0 && (
        <Section title="First, deal with these">
          <Hint>Kolab won&apos;t delete your account yet. Hand each of these over or delete it, then try again.</Hint>
          {blockers.map((b) => (
            <View key={`${b.kind}-${b.name}`} testID={`blocker-${b.name}`}>
              <Row icon="team" label={b.name} detail={b.reason === 'members' ? 'Has other members' : b.reason === 'documents' ? 'Holds documents' : 'Organization'} />
              <Hint>{b.why.charAt(0).toUpperCase() + b.why.slice(1)}.</Hint>
            </View>
          ))}
        </Section>
      )}
      <Section title="Confirm">
        <Hint>Type your name, {me}, to confirm.</Hint>
        <View style={styles.pad}>
          <TextInput testID="confirm-account" value={typed} onChangeText={setTyped} placeholder={me} autoCapitalize="none" autoCorrect={false} editable={!busy}
            accessibilityLabel={`Type ${me} to confirm`} placeholderTextColor={colors['ink-muted']}
            style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors.surface }]} />
        </View>
        <Row testID="delete-account-confirm" icon="delete" destructive label={busy ? 'Deleting your account…' : 'Delete my account'} onPress={busy ? undefined : () => void run()} />
      </Section>
      {problem && <Problem>{problem}</Problem>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  pad: { paddingHorizontal: 14, paddingBottom: 12 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 11, fontFamily: FAMILIES.sans, fontSize: 15 },
});
