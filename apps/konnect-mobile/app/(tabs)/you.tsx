import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar } from '@/Avatar';
import { THEME_CHOICES, useShowUnreads, useThemeChoice } from '@/device-prefs';
import { useMembers } from '@/kolab/hooks';
import { FAMILIES, useAppTheme } from '@/theme';
import { Button, ChoiceRow, Hint, Problem, Row, Screen, Section, SwitchRow } from '@/ui';

/**
 * You: the GitHub account signed in, how Home lists things on this phone, its theme (the phone's
 * appearance, or Predawn or Daybreak always), signing this phone out, deleting the account (App
 * Store guideline 5.1.1(v), on a screen of its own that says what it does),
 * and About, which says which build this is. What belongs to a team (its settings, inviting, what
 * notifies you from it) is in the team menu, from the team at the top of Home.
 */
export default function You() {
  const auth = useAuth();
  const router = useRouter();
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [showUnreads, setShowUnreads] = useShowUnreads();
  const [theme, setTheme] = useThemeChoice();
  const me = auth.current;
  const self = useMembers(me?.team).data?.members.find((m) => m.actor === me?.actor);

  const signOut = async () => {
    setBusy(true); setProblem(undefined);
    try {
      const { revoked } = await auth.signOut();
      if (!revoked) setProblem('Signed out on this phone, but Kolab couldn\'t be reached to end the sign-in; it lapses after 30 days unused.');
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Screen title="You" testID="you">
      {me ? (
        <View testID="account" accessible accessibilityLabel={`${me.actor}, signed in with GitHub, ${me.team}, ${me.role}`} style={[styles.card, { backgroundColor: colors['surface-raised'], borderColor: colors.line }]}>
          {self ? <Avatar member={self} size={56} /> : <View style={{ width: 56 }} />}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.name, { color: colors.ink }]}>{me.actor}</Text>
            <Text style={[styles.sub, { color: colors['ink-muted'] }]}>Signed in with GitHub · {me.team}, {me.role}</Text>
          </View>
        </View>
      ) : <Hint>Not signed in.</Hint>}
      <Section title="Home screen">
        <SwitchRow testID="show-unreads" icon="unreads" label="Unreads in their own section" value={showUnreads} onChange={setShowUnreads} />
      </Section>
      <Section title="Theme">
        {THEME_CHOICES.map((c) => <ChoiceRow key={c.choice} testID={`theme-${c.choice}`} label={c.label} chosen={theme === c.choice} onPress={() => setTheme(c.choice)} />)}
      </Section>
      <Section title="This app">
        <Row testID="about" icon="info" label="About konnect" chevron onPress={() => router.push('/about')} />
      </Section>
      {me && <Button testID="sign-out" quiet label="Sign out" busy={busy} onPress={() => void signOut()} />}
      {problem && <Problem>{problem}</Problem>}
      {me && (
        <Section title="Account">
          <Row testID="delete-account" icon="delete" label="Delete account" destructive chevron onPress={() => router.push('/delete-account')} />
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  name: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 18 },
  sub: { fontFamily: FAMILIES.sans, fontSize: 14 },
});
