import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { MAX_MESSAGE_TEXT, MAX_MESSAGES_PER_HOUR } from '@konjir/types';
import { useAuth } from '@/auth/AuthProvider';
import { appExtra } from '@/config';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Body, Button, Hint, Problem, Row, Screen, Section } from '@/ui';

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** You: your teams and their sign-ins, and this build. Notification settings come with push. */
export default function You() {
  const auth = useAuth();
  const router = useRouter();
  const { name, colors } = useAppTheme();
  const { variant, konnectUrl } = appExtra();
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();
  const [newTeam, setNewTeam] = useState('');
  const version = `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;

  const run = async (what: string, f: () => Promise<string | void>) => {
    setBusy(what); setProblem(undefined); setSaid(undefined);
    try { const s = await f(); if (s) setSaid(s); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); } finally { setBusy(undefined); }
  };

  return (
    <Screen title="You" testID="you">
      <Section title="Teams">
        {auth.teams.map((t) => (
          <Row key={t.team} testID={`team-${t.team}`} icon={t.team === auth.current?.team ? 'following' : 'team'} label={t.team} detail={`${t.actor}`}
            onPress={t.team === auth.current?.team ? undefined : () => void auth.switchTeam(t.team)} />
        ))}
        {auth.ready && auth.teams.length === 0 && <Hint>Not signed in to any team.</Hint>}
        {auth.current && <Row testID="team-settings" icon="settings" label={`${auth.current.team} settings`} detail="invite, remove, leave" onPress={() => router.push('/team')} />}
      </Section>
      <Button testID="sign-in" label="Sign in to a team" busy={busy === 'sign-in'}
        onPress={() => void run('sign-in', async () => `Signed in to ${await auth.signIn({ kind: 'choose' })}.`)} />
      <View style={styles.create}>
        <TextInput testID="new-team" value={newTeam} onChangeText={(s) => setNewTeam(s.toLowerCase())} placeholder="new-team-name" autoCapitalize="none" autoCorrect={false}
          placeholderTextColor={colors['ink-muted']} style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }]} />
        <Button testID="create-team" quiet label="Create" busy={busy === 'create'}
          onPress={() => {
            if (!NAME.test(newTeam)) { setProblem('A team\'s name is up to 40 lowercase letters, digits and \'-\', starting with a letter or digit.'); return; }
            void run('create', async () => { const t = await auth.signIn({ kind: 'create', team: newTeam }); setNewTeam(''); return `Made ${t}, and signed in.`; });
          }} />
      </View>
      {auth.current && (
        <Button testID="sign-out" quiet label={`Sign out of ${auth.current.team}`} busy={busy === 'sign-out'}
          onPress={() => { const team = auth.current!.team; void run('sign-out', async () => { const { revoked } = await auth.signOut(team); return revoked ? `Signed out of ${team}.` : `Signed out of ${team} on this phone, but Kolab couldn't be reached to end the sign-in; it lapses after 30 days unused.`; }); }} />
      )}
      {problem && <Problem>{problem}</Problem>}
      {said && <Body>{said}</Body>}
      <Section title="Notifications">
        {auth.current ? <Row testID="notification-settings" icon="notifications" label={`What notifies you from ${auth.current.team}`} onPress={() => router.push('/notifications')} /> : <Hint>Sign in to a team first.</Hint>}
      </Section>
      <Section title="This app">
        <Row icon="update" label="Version" detail={version} />
        <Row icon="settings" label="Variant" detail={variant} />
        <Row icon="update" label="Update channel" detail={Updates.channel || 'none'} />
        <Row icon="settings" label="Theme" detail={name} />
      </Section>
      <Body mono>{konnectUrl}</Body>
      <Body>A message holds up to {MAX_MESSAGE_TEXT.toLocaleString()} characters, and you and your agents send up to {MAX_MESSAGES_PER_HOUR} an hour between you.</Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  create: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 11, fontFamily: FAMILIES.mono, fontSize: 15 },
});
