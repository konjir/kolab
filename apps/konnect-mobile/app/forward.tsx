import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { MAX_MESSAGE_TEXT, textLength } from '@konjir/types';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar, presenceOf } from '@/Avatar';
import { forwardPeople, forwardText } from '@/kolab/forward';
import { useApi, useChannels, useMembers } from '@/kolab/hooks';
import { displayName, displayOf, handleOf, mentionsIn } from '@/kolab/names';
import { nonce, quoteOf } from '@/kolab/thread';
import { conversationHref } from '@/routes';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { ListRow, Problem, Row, Screen, Section } from '@/ui';

/**
 * Forward a message, from its long-press: the message, a note of your own to go with it, and who
 * it goes to: anyone of the team but its sender, or a channel. Choosing one sends it and opens
 * that conversation; a direct message going into a channel is asked about first.
 */
export default function Forward() {
  const { from, text, where } = useLocalSearchParams<{ from: string; text: string; where: string }>();
  const auth = useAuth();
  const team = auth.current?.team ?? '';
  const me = auth.current?.actor ?? '';
  const { colors } = useAppTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const api = useApi();
  const members = useMembers(team).data?.members ?? [];
  const channels = useChannels(team).data?.channels ?? [];
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase().replace(/^[@#]/, ''));
  const people = forwardPeople(members, me, from).filter((m) => match(m.actor) || match(handleOf(m)));

  const message = forwardText(note, { from: displayName(from, members), where, message: text });
  const tooLong = textLength(message) > MAX_MESSAGE_TEXT;
  // A direct message forwarded into a channel is read by the whole team: asked first.
  const choose = (kind: 'dm' | 'channel', to: string) => {
    if (busy) return;
    if (tooLong) { setProblem(`Forwarded, it would be over ${MAX_MESSAGE_TEXT.toLocaleString()} characters: shorten the note, or copy the part that matters.`); return; }
    if (kind === 'channel' && !where.startsWith('in #')) {
      Alert.alert(`Forward a direct message to #${to}?`, `Everyone in ${team} can read #${to}.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Forward', onPress: () => void send(kind, to) }]);
    } else void send(kind, to);
  };
  const send = async (kind: 'dm' | 'channel', to: string) => {
    setBusy(`${kind}:${to}`); setProblem(undefined);
    try {
      const k = await api(team);
      if (kind === 'channel') await k.sendChannelMessage(to, message, mentionsIn(note, members), undefined, nonce());
      else await k.sendMessage(to, message, undefined, nonce());
      await qc.invalidateQueries({ queryKey: [team] });
      // To that conversation: back to it if it is open under this sheet, else opened.
      router.dismissTo(conversationHref(kind, to));
    } catch (e) { setProblem((e as Error).message); setBusy(undefined); }
  };

  return (
    <Screen title="Forward" testID="forward">
      <Stack.Screen options={{ headerShown: true, title: '', presentation: 'modal' }} />
      <View testID="forwarded" style={[styles.quote, { borderLeftColor: colors.accent, backgroundColor: colors['surface-raised'] }]}>
        <Text style={[styles.who, { color: colors.ink }]}>{displayName(from, members)} <Text style={{ color: colors['ink-muted'], fontWeight: '400' }}>· {where}</Text></Text>
        <Text numberOfLines={4} style={[styles.text, { color: colors.ink }]}>{quoteOf(text, 400)}</Text>
      </View>
      <TextInput testID="forward-note" value={note} onChangeText={setNote} placeholder="Add a note (optional)" placeholderTextColor={colors['ink-muted']} multiline
        style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }]} />
      <TextInput testID="forward-to" value={q} onChangeText={setQ} placeholder="To: a person, an agent or #channel" placeholderTextColor={colors['ink-muted']} autoCapitalize="none" autoCorrect={false}
        style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }]} />
      {problem && <Problem>{problem}</Problem>}
      <Section title="People and agents">
        {people.map((m) => (
          <ListRow key={m.actor} testID={`forward-to-${m.actor}`} title={busy === `dm:${m.actor}` ? `Sending to ${displayOf(m)}…` : displayOf(m)} unread
            leading={<Avatar member={m} owner={m.owner ? members.find((x) => x.actor === m.owner) : undefined} size={32} presence={m.kind === 'agent' ? presenceOf(m.state) : m.here ? 'here' : undefined} />}
            onPress={() => choose('dm', m.actor)} />
        ))}
      </Section>
      <Section title="Channels">
        {channels.filter((c) => match(c.channel)).map((c) => (
          <Row key={c.channel} testID={`forward-to-channel-${c.channel}`} icon="channel" label={busy === `channel:${c.channel}` ? `Sending to #${c.channel}…` : c.channel} onPress={() => choose('channel', c.channel)} />
        ))}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  quote: { borderLeftWidth: 3, borderRadius: RADII.md, padding: 12, gap: 4 },
  who: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 14 },
  text: { fontFamily: FAMILIES.sans, fontSize: 15, lineHeight: 21 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 11, fontFamily: FAMILIES.sans, fontSize: 16 },
});
