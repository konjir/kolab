import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DELETED_ACCOUNT } from '@konjir/types';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar, presenceOf } from '@/Avatar';
import { useAgentActivity, useAgentConversations, useAgentStatus, useMembers } from '@/kolab/hooks';
import { displayName, handleOf, isGone } from '@/kolab/names';
import { conversationHref, memberHref } from '@/routes';
import { quoteOf } from '@/kolab/thread';
import { agentChannels, ago, at, contextOf, needsYouWords, whereOf } from '@/kolab/your-agents';
import { buttonCorners, FAMILIES, useAppTheme } from '@/theme';
import { Icon } from '@/icons';
import { Button, Hint, ListRow, Notice, Problem, Row, Screen, Section } from '@/ui';

type Tab = 'activity' | 'conversations' | 'channels';
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'activity', label: 'Activity' },
  { tab: 'conversations', label: 'Conversations' },
  { tab: 'channels', label: 'Channels' },
];

/**
 * An agent, anyone's: its picture with its state's dot, whose it is, its state and whether it is
 * here, and a button for your own DM with it. One of yours shows what it is doing too: its live
 * Activity (each row says where; a tap opens it), its Conversations (DMs, read-only), and the
 * Channels it is active in. Reading here marks nothing read for it. Kolab's owner tools are asked
 * only about your own.
 */
export default function YourAgent() {
  const { actor } = useLocalSearchParams<{ actor: string }>();
  const auth = useAuth();
  const team = auth.current?.team ?? '';
  const me = auth.current?.actor ?? '';
  const router = useRouter();
  const { colors } = useAppTheme();
  const [tab, setTab] = useState<Tab>('activity');
  const members = useMembers(team).data?.members;
  const m = members?.find((x) => x.actor === actor);
  const status = useAgentStatus(team);
  const mine = status.data?.find((s) => s.agent === actor);
  // Kolab's owner tools are asked only once the members list says it is yours.
  const yours = !!m && m.owner === me;
  const activity = useAgentActivity(team, actor, yours);
  const items = activity.data?.pages.flatMap((p) => p.items) ?? [];
  const lacking = status.data === null || activity.data?.pages.some((p) => 'lacking' in p && p.lacking);
  const conversations = useAgentConversations(team, actor, yours);
  const handle = m ? handleOf(m) : actor; // as written in a message; shown as @handle
  // An agent of a deleted account (migration 0060): named as the app names it, with no one to message.
  const gone = isGone(actor);
  const needs = needsYouWords(mine?.needs_you);

  const state = mine?.state ?? m?.state ?? null;
  const here = mine?.here ?? m?.here;
  const owner = m?.owner ? members?.find((x) => x.actor === m.owner) : undefined;
  return (
    <Screen title={gone ? DELETED_ACCOUNT : `@${handle}`} testID="agent">
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      <View style={styles.header}>
        {m && <Avatar member={m} owner={owner} size={56} presence={presenceOf(state)} />}
        <View style={{ flex: 1, gap: 2 }}>
          <Text testID="agent-owner" style={[styles.owner, { color: colors['ink-muted'] }]}>{yours ? 'Your agent' : gone ? 'An agent of a deleted account' : m?.owner ? `${displayName(m.owner, members)}'s agent` : 'An agent'}</Text>
          <Text testID="agent-state" style={[styles.state, { color: colors.ink }]}>{state ? state[0]!.toUpperCase() + state.slice(1) : 'Not running'}{here ? ' · signed in here' : ' · not signed in'}</Text>
          {needs.length > 0 && <Text testID="needs-you" style={[styles.needs, { color: colors.boundary }]}>Needs you: {needs.join(', ')}</Text>}
        </View>
      </View>
      {!m?.you && !gone && <Button testID="message-agent" label={`Message @${handle}`} onPress={() => router.push(conversationHref('dm', actor))} />}
      {m && !yours && (
        <Section title="About">
          {m.owner && <Row testID="agent-owner-row" icon="person" label="Owner" detail={displayName(m.owner, members)} chevron onPress={() => router.push(memberHref(m.owner!, 'person'))} />}
          <Row icon="agent" label="Name" detail={`@${handle}`} />
        </Section>
      )}
      {yours && (
        <>
      {lacking && <Notice icon="update">This Kolab is older than konnect&apos;s app: it can&apos;t show an agent&apos;s messages to its owner yet.</Notice>}
      <View accessibilityRole="tablist" style={[styles.tabs, { borderColor: colors.line }]}>
        {TABS.map((t) => (
          <Pressable key={t.tab} testID={`agent-tab-${t.tab}`} accessibilityRole="tab" accessibilityState={{ selected: tab === t.tab }} onPress={() => setTab(t.tab)}
            style={[styles.tab, tab === t.tab && { backgroundColor: colors.accent }]}>
            <Text style={[styles.tabText, { color: tab === t.tab ? colors['on-accent'] : colors.ink }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'activity' && (
        <Section title="Activity">
          {activity.error && <Problem>{(activity.error as Error).message}</Problem>}
          {activity.isLoading && <Hint>Reading…</Hint>}
          {!activity.isLoading && items.length === 0 && !lacking && <Hint>Nothing yet: it hasn&apos;t sent or been sent anything.</Hint>}
          {items.map((i) => {
            const to = contextOf(i);
            const who = i.from === actor ? 'It' : at(i.from, members);
            return (
              <ListRow key={`${i.kind}-${i.id}`} testID={`activity-${i.id}`} leading={<Icon name={i.kind === 'channel' ? 'channel' : 'message'} size={20} tintColor={colors.accent} />}
                title={whereOf(i, members)} unread subtitle={`${who}: ${quoteOf(i.message, 100)}`} time={ago(i.sent_at)}
                accessibilityLabel={`${whereOf(i, members)} · ${who === 'It' ? 'it' : who}: ${quoteOf(i.message, 60)}`}
                onPress={() => router.push(conversationHref(to.kind, to.name, to.as ? { as: to.as } : undefined))} />
            );
          })}
          {activity.hasNextPage && <Row icon="retry" label="Older" onPress={() => void activity.fetchNextPage()} />}
        </Section>
      )}
      {tab === 'conversations' && (
        <Section title="Its direct messages">
          {conversations.error && <Problem>{(conversations.error as Error).message}</Problem>}
          {conversations.isLoading && <Hint>Reading…</Hint>}
          {!conversations.isLoading && (conversations.data?.items.length ?? 0) === 0 && !lacking && <Hint>No direct messages.</Hint>}
          {conversations.data?.items.map((c) => {
            const other = members?.find((x) => x.actor === c.with);
            return (
              <ListRow key={c.with} testID={`agent-dm-${c.with}`} leading={other ? <Avatar member={other} size={36} /> : <Icon name="person" size={20} tintColor={colors.accent} />}
                title={at(c.with, members)} unread={c.unread > 0} badge={c.unread} badgeMore={c.unread_more}
                subtitle={`${c.last.from === actor ? 'It: ' : ''}${quoteOf(c.last.message, 80)}`} time={ago(c.last_at)}
                onPress={() => router.push(conversationHref('dm', c.with, { as: actor }))} />
            );
          })}
        </Section>
      )}
      {tab === 'channels' && (
        <Section title="Where it is active">
          {agentChannels(mine, items).map((c) => (
            <Row key={c.channel} testID={`agent-channel-${c.channel}`} icon="channel" label={c.channel}
              detail={c.unread ? `${c.unread} unread` : c.last ? ago(c.last) : undefined} chevron
              onPress={() => router.push(conversationHref('channel', c.channel, { only: actor }))} />
          ))}
          {agentChannels(mine, items).length === 0 && <Hint>Not active in any channel yet.</Hint>}
        </Section>
      )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  state: { fontFamily: FAMILIES.sans, fontWeight: '500', fontSize: 15 },
  owner: { fontFamily: FAMILIES.sans, fontSize: 14 },
  needs: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 14 },
  tabs: { flexDirection: 'row', height: 40, ...buttonCorners(40), borderWidth: 1, overflow: 'hidden' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 14 },
});
