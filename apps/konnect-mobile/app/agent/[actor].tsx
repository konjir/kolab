import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar } from '@/Avatar';
import { useAgentActivity, useAgentConversations, useAgentStatus, useMembers } from '@/kolab/hooks';
import { handleOf } from '@/kolab/names';
import { quoteOf } from '@/kolab/thread';
import { agentChannels, ago, at, contextOf, needsYouWords, whereOf } from '@/kolab/your-agents';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Button, Hint, Notice, Problem, Row, Screen, Section } from '@/ui';

type Tab = 'activity' | 'conversations' | 'channels';
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'activity', label: 'Activity' },
  { tab: 'conversations', label: 'Conversations' },
  { tab: 'channels', label: 'Channels' },
];

/**
 * One of your agents: its name, state and whether it is here, a button for your own DM with it, and
 * what it is doing: its live Activity (each row says where; a tap opens it), its Conversations
 * (DMs, read-only), and the Channels it is active in. Reading here marks nothing read for it.
 * Someone else's agent is a profile with a Message button (app/profile).
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
  // Asked of Kolab only once the members list says it is yours: someone else's goes to its profile.
  const yours = !!m && m.owner === me;
  const activity = useAgentActivity(team, actor, yours);
  const items = activity.data?.pages.flatMap((p) => p.items) ?? [];
  const lacking = status.data === null || activity.data?.pages.some((p) => 'lacking' in p && p.lacking);
  const conversations = useAgentConversations(team, actor, yours);
  const handle = m ? handleOf(m) : actor; // as written in a message; shown as @handle
  const needs = needsYouWords(mine?.needs_you);

  if (m && m.owner !== me) {
    // Not yours: only its profile, with a Message button.
    return <Redirect href={{ pathname: '/profile/[actor]', params: { actor } }} />;
  }
  return (
    <Screen title={`@${handle}`} testID="agent">
      <Stack.Screen options={{ headerShown: true, title: '', headerBackTitle: 'Home', headerStyle: { backgroundColor: colors['surface-raised'] }, headerTintColor: colors.ink }} />
      <View style={styles.header}>
        {m && <Avatar member={m} size={56} />}
        <View style={{ flex: 1, gap: 2 }}>
          <Text testID="agent-state" style={[styles.state, { color: colors.ink }]}>{mine?.state ?? m?.state ?? 'not running'}{(mine?.here ?? m?.here) ? ' · here' : ' · not signed in'}</Text>
          {needs.length > 0 && <Text testID="needs-you" style={[styles.needs, { color: colors.boundary }]}>Needs you: {needs.join(', ')}</Text>}
        </View>
      </View>
      <Button testID="message-agent" label={`Message @${handle}`} onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: actor } })} />
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
            const who = i.from === actor ? 'it' : at(i.from, members);
            return (
              <Row key={`${i.kind}-${i.id}`} testID={`activity-${i.id}`} icon={i.kind === 'channel' ? 'channel' : 'message'} label={`${whereOf(i, members)} · ${who}: ${quoteOf(i.message, 60)}`} detail={ago(i.sent_at)}
                onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: to })} />
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
          {conversations.data?.items.map((c) => (
            <Row key={c.with} testID={`agent-dm-${c.with}`} icon={members?.find((x) => x.actor === c.with)?.kind === 'agent' ? 'agent' : 'person'}
              label={`${at(c.with, members)}: ${c.last.from === actor ? 'it: ' : ''}${quoteOf(c.last.message, 40)}`}
              detail={`${c.unread ? `${c.unread}${c.unread_more ? '+' : ''} unread · ` : ''}${ago(c.last_at)}`}
              onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: c.with, as: actor } })} />
          ))}
        </Section>
      )}
      {tab === 'channels' && (
        <Section title="Where it is active">
          {agentChannels(mine, items).map((c) => (
            <Row key={c.channel} testID={`agent-channel-${c.channel}`} icon="channel" label={c.channel}
              detail={c.unread !== undefined ? `${c.unread} unread` : c.last ? ago(c.last) : undefined}
              onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'channel', name: c.channel, only: actor } })} />
          ))}
          {agentChannels(mine, items).length === 0 && <Hint>Not active in any channel yet.</Hint>}
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  state: { fontFamily: FAMILIES.mono, fontSize: 14 },
  needs: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 14 },
  tabs: { flexDirection: 'row', borderRadius: RADII.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabText: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 14 },
});
