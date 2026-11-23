import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar } from '@/Avatar';
import { useMembers } from '@/kolab/hooks';
import { displayOf, handleOf } from '@/kolab/names';
import { conversationHref, memberHref } from '@/routes';
import { FAMILIES, useAppTheme } from '@/theme';
import { Button, Hint, Row, Screen, Section } from '@/ui';

/** A person of the team: their picture, whether they're here, their agents, and a Message button. An agent's page is the agent screen. */
export default function Profile() {
  const { actor } = useLocalSearchParams<{ actor: string }>();
  const auth = useAuth();
  const team = auth.current?.team ?? '';
  const { colors } = useAppTheme();
  const router = useRouter();
  const members = useMembers(team).data?.members;
  const m = members?.find((x) => x.actor === actor);
  if (m?.kind === 'agent') return <Redirect href={memberHref(m.actor, 'agent')} />;
  const agents = (members ?? []).filter((x) => x.kind === 'agent' && x.owner === actor);
  return (
    <Screen title={m ? displayOf(m) : actor} testID="profile">
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      {!m && <Hint>Not a member of {team} now.</Hint>}
      {m && (
        <View style={styles.header}>
          <Avatar member={m} size={72} presence={m.here ? 'here' : undefined} />
          <Text style={[styles.sub, { color: colors['ink-muted'] }]}>{m.you ? 'You' : m.here ? 'Signed in here' : 'Not signed in'}{m.login ? ` · @${m.login} on GitHub` : ''}</Text>
        </View>
      )}
      {m && !m.you && <Button testID="message" label={`Message ${displayOf(m)}`} onPress={() => router.replace(conversationHref('dm', m.actor))} />}
      {agents.length > 0 && (
        <Section title={m?.you ? 'Your agents' : 'Their agents'}>
          {agents.map((a) => <Row key={a.actor} testID={`profile-agent-${a.actor}`} icon="agent" label={`@${handleOf(a)}`} detail={a.state ?? 'not running'} chevron onPress={() => router.push(memberHref(a.actor, 'agent'))} />)}
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: 10 },
  sub: { fontFamily: FAMILIES.sans, fontSize: 15 },
});
