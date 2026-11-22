import { FlashList, type ViewToken } from '@shopify/flash-list';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { Composer } from '@/Composer';
import { Icon } from '@/icons';
import { kolab } from '@/kolab/api';
import { isAgent, useAnswers, useApi, useChannels, useConversation, useMembers, type ConversationKind } from '@/kolab/hooks';
import { handleOf, mentionsIn } from '@/kolab/names';
import { quoteOf, rowsOf, type Msg, type Row } from '@/kolab/thread';
import { readThrough } from '@/kolab/unread';
import { Markdown } from '@/markdown';
import { FAMILIES, useAppTheme } from '@/theme';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/**
 * A conversation: a channel (`/c/channel/<name>`) or a DM (`/c/dm/<member>`). Newest at the bottom
 * (an inverted FlashList), grouped by sender and minute, with day separators and a New line above
 * the first unread message. Agents' messages are markdown. Long-press to reply or copy. What
 * scrolls into view is marked read. Sending shows at once and is reconciled with Kolab's answer;
 * one that fails stays, with Retry.
 */
export default function Conversation() {
  const { kind, name } = useLocalSearchParams<{ kind: ConversationKind; name: string }>();
  const auth = useAuth();
  const team = auth.current?.team ?? "";
  const me = auth.current?.actor ?? "";
  const { colors } = useAppTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const api = useApi();
  const convo = useConversation(team, kind, name);
  const members = useMembers(team).data?.members;
  const channels = useChannels(team).data?.channels;
  const answers = useAnswers(team).data;
  const [pending, setPending] = useState<Msg[]>([]);
  const [replyTo, setReplyTo] = useState<Msg>();
  const marking = useRef(false);

  const loaded = useMemo(() => convo.data?.pages.flatMap((p) => p.messages) ?? [], [convo.data]);
  const unread = useMemo(() => (kind === 'channel'
    ? answers?.channels?.find((c) => c.channel === name)?.items?.map((i) => i.id)
    : answers?.messages?.items?.filter((m) => m.from === name).map((m) => m.id)) ?? [], [answers, kind, name]);
  const all = useMemo(() => [...pending.filter((p) => !loaded.some((l) => l.id === p.id)), ...loaded], [pending, loaded]);
  const rows = useMemo(() => rowsOf(all, unread.find((id) => all.some((m) => m.id === id)), day), [all, unread]);
  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all]);

  const send = async (text: string, retryOf?: Msg) => {
    const local: Msg = retryOf ?? { id: `local-${Date.now()}`, from: me, message: text, sent_at: new Date().toISOString(), reply_to: replyTo?.id, pending: 'sending' };
    setPending((p) => [{ ...local, pending: 'sending' }, ...p.filter((x) => x.id !== local.id)]);
    setReplyTo(undefined);
    try {
      const k = await api(team);
      if (kind === 'channel') await k.sendChannelMessage(name, local.message, mentionsIn(local.message, members ?? []), local.reply_to ?? undefined);
      else await k.sendMessage(name, local.message, local.reply_to ?? undefined);
      await qc.invalidateQueries({ queryKey: [team, kind, name] });
      setPending((p) => p.filter((x) => x.id !== local.id));
    } catch {
      setPending((p) => p.map((x) => (x.id === local.id ? { ...x, pending: 'failed' } : x)));
    }
  };

  const markRead = async (visible: string[]) => {
    const through = readThrough(unread, visible);
    if (!through || marking.current) return;
    marking.current = true;
    try {
      const k = kolab(await auth.client(team));
      // Kolab marks read oldest first, 20 at a time (S2 brings "read up to here").
      for (let left = through; left > 0; left -= 20) await (kind === 'channel' ? k.readChannel(name, Math.min(20, left)) : k.readMessages(name, Math.min(20, left)));
      await qc.invalidateQueries({ queryKey: [team, 'answers'] });
      await qc.invalidateQueries({ queryKey: [team, 'channels'] });
    } catch { /* tried again on the next scroll */ } finally { marking.current = false; }
  };

  const actions = (m: Msg) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const reply = () => setReplyTo(m);
    const copy = () => void Clipboard.setStringAsync(m.message);
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: ['Reply', 'Copy', 'Cancel'], cancelButtonIndex: 2 }, (i) => (i === 0 ? reply() : i === 1 ? copy() : undefined));
    else Alert.alert('Message', undefined, [{ text: 'Reply', onPress: reply }, { text: 'Copy', onPress: copy }, { text: 'Cancel', style: 'cancel' }]);
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.type === 'day') return <Text style={[styles.day, { color: colors['ink-muted'] }]}>{item.label}</Text>;
    if (item.type === 'new') return <View style={styles.newLine}><View style={[styles.rule, { backgroundColor: colors.boundary }]} /><Text style={[styles.newText, { color: colors.boundary }]}>New</Text></View>;
    const m = item.msg;
    const parent = m.reply_to ? byId.get(m.reply_to) : undefined;
    const agent = isAgent(members, m.from);
    return (
      <Pressable testID={`msg-${m.id}`} onLongPress={() => actions(m)} style={[styles.msg, item.head && styles.head]}>
        {item.head && (
          <View style={styles.meta}>
            <Text onPress={() => router.push({ pathname: '/profile/[actor]', params: { actor: m.from } })} style={[styles.from, { color: colors.ink }]}>{m.from}{agent ? ' · agent' : ''}</Text>
            <Text style={[styles.time, { color: colors['ink-muted'] }]}>{time(m.sent_at)}</Text>
          </View>
        )}
        {m.reply_to && <Text numberOfLines={1} style={[styles.quote, { color: colors['ink-muted'], borderLeftColor: colors.line }]}>{parent ? `${parent.from}: ${quoteOf(parent.message)}` : 'Replying to an earlier message'}</Text>}
        {agent ? <Markdown source={m.message} colors={colors} /> : <Text selectable style={[styles.body, { color: colors.ink }]}>{m.message}</Text>}
        {m.capped && <Text style={[styles.note, { color: colors.stale }]}>Past the agent reply cap: it woke no agent.</Text>}
        {m.pending === 'sending' && <Text style={[styles.note, { color: colors['ink-muted'] }]}>Sending…</Text>}
        {m.pending === 'failed' && (
          <Pressable accessibilityRole="button" onPress={() => void send(m.message, m)} style={styles.retry}>
            <Icon name="failed" size={14} tintColor={colors.boundary} />
            <Text style={[styles.note, { color: colors.boundary }]}>Not sent. Retry</Text>
          </Pressable>
        )}
      </Pressable>
    );
  };

  const people = (members ?? []).filter((m) => m.actor !== me).map(handleOf);
  const title = kind === 'channel' ? `#${name}` : name;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.surface }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title, headerShown: true, headerBackTitle: 'Home', headerStyle: { backgroundColor: colors['surface-raised'] }, headerTintColor: colors.ink, headerTitleStyle: { fontFamily: FAMILIES.sans } }} />
      <FlashList
        testID="messages"
        data={rows}
        inverted
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.type}
        renderItem={renderRow}
        onEndReached={() => { if (convo.hasNextPage && !convo.isFetchingNextPage) void convo.fetchNextPage(); }}
        onViewableItemsChanged={({ viewableItems }: { viewableItems: ViewToken<Row>[] }) => {
          const ids = viewableItems.flatMap((v) => (v.item?.type === 'message' ? [v.item.msg.id] : []));
          void markRead(ids);
        }}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors['ink-muted'] }]}>{convo.isLoading ? 'Reading…' : convo.isError ? `Couldn't read ${title}: ${(convo.error as Error).message}` : 'No messages yet. Say something.'}</Text>}
      />
      <Composer people={people} channels={(channels ?? []).map((c) => c.channel)} replyTo={replyTo} onCancelReply={() => setReplyTo(undefined)}
        onSend={(t) => void send(t)} placeholder={`Message ${title}`} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  msg: { paddingHorizontal: 16, paddingVertical: 2 },
  head: { paddingTop: 10 },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 2 },
  from: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 15 },
  time: { fontFamily: FAMILIES.mono, fontSize: 11 },
  body: { fontFamily: FAMILIES.sans, fontSize: 16, lineHeight: 22 },
  quote: { fontFamily: FAMILIES.sans, fontSize: 13, borderLeftWidth: 3, paddingLeft: 8, marginBottom: 2 },
  note: { fontFamily: FAMILIES.sans, fontSize: 12 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  day: { textAlign: 'center', fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 12, paddingVertical: 10 },
  newLine: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth * 2 },
  newText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 12 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FAMILIES.sans, transform: [{ scaleY: -1 }] },
});
