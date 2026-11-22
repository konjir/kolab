import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar } from '@/Avatar';
import { useMembers } from '@/kolab/hooks';
import { displayOf } from '@/kolab/names';
import { useAppTheme } from '@/theme';
import { Button, Hint, Row, Screen, Section } from '@/ui';

/** A person or an agent of the team: an agent's owner and state, and a Message button. */
export default function Profile() {
  const { actor } = useLocalSearchParams<{ actor: string }>();
  const auth = useAuth();
  const team = auth.current?.team ?? "";
  const { colors } = useAppTheme();
  const router = useRouter();
  const m = useMembers(team).data?.members.find((x) => x.actor === actor);
  return (
    <Screen title={m ? displayOf(m) : actor} testID="profile">
      <Stack.Screen options={{ headerShown: true, title: '', headerStyle: { backgroundColor: colors['surface-raised'] }, headerTintColor: colors.ink }} />
      {m && <Avatar member={m} size={72} />}
      {!m && <Hint>Not a member of {team} now.</Hint>}
      {m && (
        <Section title={m.kind === 'agent' ? 'Agent' : 'Person'}>
          <Row icon={m.kind === 'agent' ? 'agent' : 'person'} label="Name" detail={m.actor} />
          {m.kind === 'agent' && <Row icon="person" label="Owner" detail={m.owner ?? 'an organization'} />}
          {m.kind === 'agent' && <Row icon="stateRunning" label="State" detail={m.state ?? 'not running'} />}
          <Row icon="signIn" label="Signed in here" detail={m.here ? 'yes' : 'no'} />
        </Section>
      )}
      {m && m.kind === 'agent' && m.owner === auth.current?.actor && <Button quiet testID="open-agent" label="What it is doing" onPress={() => router.replace({ pathname: '/agent/[actor]', params: { actor: m.actor } })} />}
      {m && !m.you && <Button testID="message" label={`Message ${displayOf(m)}`} onPress={() => router.replace({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: m.actor } })} />}
    </Screen>
  );
}
