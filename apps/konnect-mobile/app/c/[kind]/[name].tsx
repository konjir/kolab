import { FlashList, type ViewToken } from '@shopify/flash-list';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar } from '@/Avatar';
import { Composer, useBottomInset } from '@/Composer';
import { Icon } from '@/icons';
import { markReadUpTo } from '@/kolab/api';
import { markReader, type MarkReader } from '@/kolab/mark-read';
import { isAgent, useAgentConversation, useAnswers, useApi, useChannels, useConversation, useMembers, type ConversationKind } from '@/kolab/hooks';
import { agentsIn, at, disclosureOf, marksRead, onlyAgent, ownAgents, readingAs, readOnlyBanner } from '@/kolab/your-agents';
import { Button } from '@/ui';
import { displayName, handleOf, mentionsIn } from '@/kolab/names';
import { nonce, quoteOf, rowsOf, type Msg, type Row } from '@/kolab/thread';
import { readThrough } from '@/kolab/unread';
import { Markdown } from '@/markdown';
import { memberHref } from '@/routes';
import { FAMILIES, useAppTheme } from '@/theme';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/**
 * A conversation: a channel (`/c/channel/<name>`) or a DM (`/c/dm/<member>`). Newest at the bottom
 * (an inverted FlashList), grouped by sender and minute, with day separators and a New line above
 * the first unread message. Agents' messages are markdown. Long-press to reply, forward or copy. What
 * scrolls into view is marked read. Sending shows at once and is reconciled with Kolab's answer;
 * one that fails stays, with Retry.
 */
export default function Conversation() {
  // `as`: one of your agents, whose DM with `name` this is, read as its owner (read-only). `only`:
  // a channel opened on one of your agents' messages (its "Only @you/bot" filter).
  const { kind, name, as, only, chosen } = useLocalSearchParams<{ kind: ConversationKind; name: string; as?: string; only?: string; chosen?: string }>();
  const auth = useAuth();
  const team = auth.current?.team ?? "";
  const me = auth.current?.actor ?? "";
  const { readOnly, redirect } = readingAs({ kind, name, as, me });
  const { colors } = useAppTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const api = useApi();
  const own = useConversation(team, kind, name, !readOnly);
  const agentDm = useAgentConversation(team, readOnly ? as : undefined, name);
  const convo = readOnly ? agentDm : own;
  const members = useMembers(team).data?.members;
  // The filter comes in the route (`only`), chosen on the channel's details, which say when
  // (`chosen`); "Show all" sets aside that choice, until another is made.
  const choice = `${only ?? ''}@${chosen ?? ''}`;
  const [setAside, setSetAside] = useState<string>();
  const onlyOf = only && setAside !== choice ? only : undefined;
  const channels = useChannels(team).data?.channels;
  const answers = useAnswers(team).data;
  const [pending, setPending] = useState<Msg[]>([]);
  const [replyTo, setReplyTo] = useState<Msg>();
  const bottom = useBottomInset();

  const loaded = useMemo(() => convo.data?.pages.flatMap((p) => p.messages) ?? [], [convo.data]);
  const unread = useMemo(() => (readOnly ? [] : kind === 'channel'
    ? answers?.channels?.find((c) => c.channel === name)?.items?.map((i) => i.id)
    : answers?.messages?.items?.filter((m) => m.from === name).map((m) => m.id)) ?? [], [answers, kind, name, readOnly]);
  // Your agents that have spoken here: a channel can show only what one of them sent or was sent.
  const mine = useMemo(() => (kind === 'channel' ? agentsIn(loaded, ownAgents(members, me)) : []), [kind, loaded, members, me]);
  const filterBy = mine.find((a) => a.actor === onlyOf) ?? (onlyOf ? members?.find((m) => m.actor === onlyOf && m.owner === me) : undefined);
  const everything = useMemo(() => [...pending.filter((p) => !loaded.some((l) => l.id === p.id)), ...loaded], [pending, loaded]);
  const all = useMemo(() => (filterBy ? onlyAgent(everything, filterBy) : everything), [everything, filterBy]);
  const rows = useMemo(() => rowsOf(all, unread.find((id) => all.some((m) => m.id === id)), day), [all, unread]);
  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all]);

  const send = async (text: string, retryOf?: Msg) => {
    // Its id is its nonce: a Retry sends the same one, so Kolab keeps the message once.
    const local: Msg = retryOf ?? { id: nonce(), from: me, message: text, sent_at: new Date().toISOString(), reply_to: replyTo?.id, pending: 'sending' };
    setPending((p) => [{ ...local, pending: 'sending' }, ...p.filter((x) => x.id !== local.id)]);
    setReplyTo(undefined);
    try {
      const k = await api(team);
      if (kind === 'channel') await k.sendChannelMessage(name, local.message, mentionsIn(local.message, members ?? []), local.reply_to ?? undefined, local.id);
      else await k.sendMessage(name, local.message, local.reply_to ?? undefined, local.id);
      await qc.invalidateQueries({ queryKey: [team, kind, name] });
      setPending((p) => p.filter((x) => x.id !== local.id));
    } catch {
      setPending((p) => p.map((x) => (x.id === local.id ? { ...x, pending: 'failed' } : x)));
    }
  };

  // What is on screen, marked read (S2) up to the newest unread message seen: with this render's
  // unread and team, which the marker always calls the latest of.
  const markOnce = async (visible: string[]) => {
    const through = readThrough(unread, visible);
    if (!through) return;
    await markReadUpTo(await auth.client(team), kind, name, unread[through - 1]!);
    await qc.invalidateQueries({ queryKey: [team, 'answers'] });
    await qc.invalidateQueries({ queryKey: [team, 'channels'] });
  };
  const latestMark = useRef(markOnce);
  useEffect(() => { latestMark.current = markOnce; });
  // Retried a few times when Kolab can't be told, and never after the screen closes.
  const marker = useRef<MarkReader<string[]> | undefined>(undefined);
  useEffect(() => {
    const m = markReader<string[]>((visible) => latestMark.current(visible));
    marker.current = m;
    return () => { m.dispose(); if (marker.current === m) marker.current = undefined; };
  }, []);
  // Reading one of your agents' DMs marks nothing read, for it or for you; nor does a channel
  // filtered to one agent, where what is on screen isn't all that is there.
  const markRead = (visible: string[]) => { if (marksRead(readOnly, !!filterBy)) marker.current?.run(visible); };

  // A message's long-press: reply, forward (to anyone but its sender) or copy. In one of your
  // agents' DMs, read as its owner, there is nothing to reply with: forward or copy.
  const actions = (m: Msg) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const reply = () => setReplyTo(m);
    const copy = () => void Clipboard.setStringAsync(m.message);
    const where = kind === 'channel' ? `in #${name}` : readOnly ? `in ${at(as!, members)}'s conversation with ${at(name, members)}` : 'in a direct message';
    const forward = () => router.push({ pathname: '/forward', params: { from: m.from, text: m.message, where } });
    const options = [...(readOnly || m.pending ? [] : [{ text: 'Reply', run: reply }]), ...(m.pending ? [] : [{ text: 'Forward…', run: forward }]), { text: 'Copy', run: copy }];
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: [...options.map((o) => o.text), 'Cancel'], cancelButtonIndex: options.length }, (i) => options[i]?.run());
    else Alert.alert('Message', undefined, [...options.map((o) => ({ text: o.text, onPress: o.run })), { text: 'Cancel', style: 'cancel' }]);
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.type === 'day') return <Text style={[styles.day, { color: colors['ink-muted'] }]}>{item.label}</Text>;
    if (item.type === 'new') return <View style={styles.newLine}><View style={[styles.rule, { backgroundColor: colors.boundary }]} /><Text style={[styles.newText, { color: colors.boundary }]}>New</Text></View>;
    const m = item.msg;
    const parent = m.reply_to ? byId.get(m.reply_to) : undefined;
    const agent = isAgent(members, m.from);
    const sender = members?.find((x) => x.actor === m.from);
    const owner = sender?.owner ? members?.find((x) => x.actor === sender.owner) : undefined;
    const profile = () => router.push(memberHref(m.from, sender?.kind));
    return (
      <Pressable testID={`msg-${m.id}`} onLongPress={() => actions(m)} style={[styles.msg, item.head && styles.head]}>
        <View style={styles.gutter}>
          {item.head && (sender
            ? <Pressable accessibilityRole="button" accessibilityLabel={displayName(m.from, members)} onPress={profile}><Avatar member={sender} owner={owner} size={36} /></Pressable>
            : <View style={[styles.blank, { backgroundColor: colors['accent-soft'] }]} />)}
        </View>
        <View style={styles.content}>
          {item.head && (
            <View style={styles.meta}>
              <Text onPress={profile} style={[styles.from, { color: colors.ink }]}>{displayName(m.from, members)}</Text>
              {agent && <Text style={[styles.tag, { color: colors['ink-muted'], borderColor: colors.line }]}>agent</Text>}
              <Text style={[styles.time, { color: colors['ink-muted'] }]}>{time(m.sent_at)}</Text>
            </View>
          )}
          {m.reply_to && <Text numberOfLines={1} style={[styles.quote, { color: colors['ink-muted'], borderLeftColor: colors.line }]}>{parent ? `${displayName(parent.from, members)}: ${quoteOf(parent.message)}` : 'Replying to an earlier message'}</Text>}
          {agent ? <Markdown source={m.message} colors={colors} /> : <Text style={[styles.body, { color: colors.ink }]}>{m.message}</Text>}
          {m.capped && <Text style={[styles.note, { color: colors.stale }]}>Past the agent reply cap: it woke no agent.</Text>}
          {m.pending === 'sending' && <Text style={[styles.note, { color: colors['ink-muted'] }]}>Sending…</Text>}
          {m.pending === 'failed' && (
            <Pressable accessibilityRole="button" onPress={() => void send(m.message, m)} style={styles.retry}>
              <Icon name="failed" size={14} tintColor={colors.boundary} />
              <Text style={[styles.note, { color: colors.boundary }]}>Not sent. Retry</Text>
            </Pressable>
          )}
        </View>
      </Pressable>
    );
  };

  // Your agent's DM with you is your own DM with it, never read as its owner.
  if (redirect) return <Redirect href={{ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: redirect } }} />;
  const people = (members ?? []).filter((m) => m.actor !== me).map(handleOf);
  const title = kind === 'channel' ? `#${name}` : displayName(name, members);
  const agentHandle = readOnly ? at(as!, members) : '';
  const otherHandle = at(name, members);
  // Who else can read a DM with an agent, from Kolab's fields: said under the header, always.
  const disclosure = kind === 'dm' && !readOnly
    ? disclosureOf(members?.find((m) => m.actor === name), me, (convo.data?.pages[0] as { readableBy?: string[] } | undefined)?.readableBy)
    : undefined;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.surface }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ headerShown: true, title: readOnly ? `${agentHandle} · ${otherHandle}` : title, headerTitle: () => (
        // The title opens what it names: a channel's details, or the person or agent of a DM.
        <Pressable testID="conversation-title" accessibilityRole="button" accessibilityLabel={`${readOnly ? `${agentHandle} · ${otherHandle}` : title}, details`} hitSlop={8}
          onPress={() => router.push(kind === 'channel' ? { pathname: '/details/[name]', params: { name, only: filterBy?.actor ?? '' } } : memberHref(readOnly ? as! : name, members?.find((x) => x.actor === (readOnly ? as : name))?.kind))}
          style={styles.titleButton}>
          <Text numberOfLines={1} style={[styles.title, { color: colors.ink }]}>{readOnly ? `${agentHandle} · ${otherHandle}` : title}</Text>
          <Icon name="chevron" size={11} tintColor={colors['ink-muted']} />
        </Pressable>
      ) }} />
      {readOnly && <Text testID="read-only-banner" accessibilityRole="header" style={[styles.banner, { color: colors.ink, backgroundColor: colors['accent-soft'], borderColor: colors.line }]}>{readOnlyBanner(agentHandle, otherHandle)}</Text>}
      {disclosure && <Text testID="disclosure" style={[styles.disclosure, { color: colors['ink-muted'], borderColor: colors.line }]}>{disclosure}</Text>}
      {filterBy && (
        <View testID="filter-banner" style={[styles.filter, { backgroundColor: colors['accent-soft'], borderColor: colors.line }]}>
          <Text style={[styles.filterText, { color: colors.ink }]}>Only @{handleOf(filterBy)}&apos;s messages</Text>
          <Pressable testID="show-all" accessibilityRole="button" hitSlop={8} onPress={() => setSetAside(choice)}><Text style={[styles.filterText, { color: colors.accent, fontWeight: '700' }]}>Show all</Text></Pressable>
        </View>
      )}
      {/* A new key when the filter changes: FlashList, inverted, kept the filtered rows on screen
          after "Show all" when given the whole list again in place. */}
      <FlashList
        key={filterBy?.actor ?? 'everything'}
        testID="messages"
        data={rows}
        inverted
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.type}
        renderItem={renderRow}
        onEndReached={() => { if (convo.hasNextPage && !convo.isFetchingNextPage) void convo.fetchNextPage(); }}
        onViewableItemsChanged={({ viewableItems }: { viewableItems: ViewToken<Row>[] }) => {
          const ids = viewableItems.flatMap((v) => (v.item?.type === 'message' ? [v.item.msg.id] : []));
          markRead(ids);
        }}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors['ink-muted'] }]}>{convo.isLoading ? 'Reading…' : convo.isError ? `Couldn't read ${title}: ${(convo.error as Error).message}` : filterBy ? `Nothing from or to @${handleOf(filterBy)} here yet.` : readOnly ? 'No messages.' : 'No messages yet. Say something.'}</Text>}
      />
      {readOnly ? (
        // Not yours to write in: write to the other side yourself. A long-press forwards a message, to your agent or anyone.
        <View testID="read-only-actions" style={[styles.actions, { borderColor: colors.line, backgroundColor: colors['surface-raised'], paddingBottom: 12 + bottom }]}>
          <Button quiet testID="message-other" label={`Message ${otherHandle} yourself`} onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name } })} />
          <Text style={[styles.note, { color: colors['ink-muted'], textAlign: 'center' }]}>Long-press a message to forward it.</Text>
        </View>
      ) : (
        <Composer people={people} channels={(channels ?? []).map((c) => c.channel)} replyTo={replyTo} onCancelReply={() => setReplyTo(undefined)}
          onSend={(t) => void send(t)} placeholder={`Message ${title}`} />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  msg: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 2 },
  head: { paddingTop: 12 },
  gutter: { width: 36 },
  blank: { width: 36, height: 36, borderRadius: 18 },
  content: { flex: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  tag: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 10, textTransform: 'uppercase', borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 4, overflow: 'hidden' },
  titleButton: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 260 },
  title: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 17 },
  filter: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  filterText: { fontFamily: FAMILIES.sans, fontSize: 14 },
  from: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 15 },
  time: { fontFamily: FAMILIES.sans, fontSize: 12 },
  body: { fontFamily: FAMILIES.sans, fontSize: 16, lineHeight: 22 },
  quote: { fontFamily: FAMILIES.sans, fontSize: 13, borderLeftWidth: 3, paddingLeft: 8, marginBottom: 2 },
  note: { fontFamily: FAMILIES.sans, fontSize: 12 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  day: { textAlign: 'center', fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 12, paddingVertical: 10 },
  newLine: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth * 2 },
  newText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 12 },
  banner: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 14, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  disclosure: { fontFamily: FAMILIES.sans, fontSize: 12, paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: 'column', gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  empty: { textAlign: 'center', padding: 24, fontFamily: FAMILIES.sans, transform: [{ scaleY: -1 }] },
});
