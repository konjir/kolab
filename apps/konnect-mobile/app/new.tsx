import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { useChannels, useMembers } from '@/kolab/hooks';
import { handleOf } from '@/kolab/names';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Row, Screen, Section } from '@/ui';

/** New message: pick a person, an agent or a channel, and the conversation opens. */
export default function NewMessage() {
  const auth = useAuth();
  const team = auth.current?.team ?? "";
  const { colors } = useAppTheme();
  const router = useRouter();
  const members = useMembers(team).data?.members ?? [];
  const channels = useChannels(team).data?.channels ?? [];
  const [q, setQ] = useState('');
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase().replace(/^[@#]/, ''));
  const open = (kind: 'dm' | 'channel', name: string) => router.replace({ pathname: '/c/[kind]/[name]', params: { kind, name } });
  return (
    <Screen title="New message" testID="new">
      <Stack.Screen options={{ headerShown: true, title: 'New message', presentation: 'modal', headerStyle: { backgroundColor: colors['surface-raised'] }, headerTintColor: colors.ink }} />
      <TextInput testID="to" autoFocus value={q} onChangeText={setQ} placeholder="To: a person, an agent or #channel" placeholderTextColor={colors['ink-muted']} autoCapitalize="none" autoCorrect={false}
        style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }]} />
      <Section title="People and agents">
        {members.filter((m) => m.actor !== auth.current?.actor && (match(m.actor) || match(handleOf(m)))).map((m) => (
          <Row key={m.actor} icon={m.kind === 'agent' ? 'agent' : 'person'} label={handleOf(m)} onPress={() => open('dm', m.actor)} />
        ))}
      </Section>
      <Section title="Channels">
        {channels.filter((c) => match(c.channel)).map((c) => <Row key={c.channel} icon="channel" label={c.channel} onPress={() => open('channel', c.channel)} />)}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 11, fontFamily: FAMILIES.sans, fontSize: 16 },
});
