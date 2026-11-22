import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { useAgentActivity, useAgentStatus, useAnswers, useMembers } from '@/kolab/hooks';
import { quoteOf } from '@/kolab/thread';
import { activityOf } from '@/kolab/unread';
import { at, contextOf, ownAgents, whereOf, yourAgentsActivity } from '@/kolab/your-agents';
import { FAMILIES, useAppTheme } from '@/theme';
import { Hint, Notice, Problem, Row, Screen, Section } from '@/ui';

const KIND = { mention: { icon: 'mention', says: 'mentioned you' }, reply: { icon: 'reply', says: 'replied' }, capped: { icon: 'capped', says: 'past the reply cap, woke no agent' } } as const;

/**
 * Activity: unread mentions of you, replies to you, and channel messages past an agent's reply
 * cap, newest first, from what waits for you (the answers resource). Tapping one opens its
 * conversation. Replies are known for what you sent from this phone since it started; S6 lists them.
 *
 * "Your agents", for a person who has some: DMs to them, mentions of them, capped messages, and
 * those not running with messages waiting, from Kolab's owner tools.
 */
export default function Activity() {
  const auth = useAuth();
  const team = auth.current?.team;
  const me = auth.current?.actor ?? '';
  const router = useRouter();
  const { colors } = useAppTheme();
  const answers = useAnswers(team);
  const members = useMembers(team).data?.members;
  const hasAgents = ownAgents(members, me).length > 0;
  const [filter, setFilter] = useState<'you' | 'agents'>('you');
  const items = activityOf(answers.data);
  const showAgents = hasAgents && filter === 'agents';
  return (
    <Screen title="Activity" testID="activity">
      {hasAgents && (
        <View accessibilityRole="tablist" style={styles.filters}>
          {([['you', 'For you'], ['agents', 'Your agents']] as const).map(([f, label]) => (
            <Pressable key={f} testID={`activity-filter-${f}`} accessibilityRole="tab" accessibilityState={{ selected: filter === f }} onPress={() => setFilter(f)}
              style={[styles.chip, { borderColor: colors.line }, filter === f && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
              <Text style={[styles.chipText, { color: filter === f ? colors['on-accent'] : colors.ink }]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {showAgents ? <YourAgents team={team} /> : (
        <>
          {answers.error && <Problem>{(answers.error as Error).message}</Problem>}
          <Section title="Unread">
            {answers.isLoading && <Hint>Reading…</Hint>}
            {!answers.isLoading && items.length === 0 && <Hint>Nothing waits for you: no unread mentions, replies or capped messages.</Hint>}
            {items.map(({ kind, item }) => {
              const where = 'channel' in item ? `#${item.channel}` : 'a direct message';
              return (
                <Row key={`${kind}-${item.id}`} icon={KIND[kind].icon} label={`${item.from} ${KIND[kind].says} in ${where}: ${quoteOf(item.message, 60)}`}
                  onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: 'channel' in item ? { kind: 'channel', name: item.channel } : { kind: 'dm', name: item.from } })} />
              );
            })}
          </Section>
        </>
      )}
    </Screen>
  );
}

function YourAgents({ team }: { team: string | undefined }) {
  const router = useRouter();
  const members = useMembers(team).data?.members;
  const status = useAgentStatus(team);
  const activity = useAgentActivity(team);
  const items = activity.data?.pages.flatMap((p) => p.items) ?? [];
  if (status.data === null) return <Notice icon="update">This Kolab is older than konnect&apos;s app: it can&apos;t show an agent&apos;s messages to its owner yet.</Notice>;
  const rows = yourAgentsActivity(items, status.data ?? [], members);
  return (
    <Section title="Your agents">
      {(status.error ?? activity.error) && <Problem>{((status.error ?? activity.error) as Error).message}</Problem>}
      {(status.isLoading || activity.isLoading) && <Hint>Reading…</Hint>}
      {!status.isLoading && !activity.isLoading && rows.length === 0 && <Hint>Nothing for your agents needs you.</Hint>}
      {rows.map((r) => {
        const agent = at(r.agent, members);
        if (r.kind === 'stuck') {
          return <Row key={`stuck-${r.agent}`} icon="stateStopped" label={`${agent} isn't running: ${r.unread} waiting`} onPress={() => router.push({ pathname: '/agent/[actor]', params: { actor: r.agent } })} />;
        }
        const i = r.item;
        const says = r.kind === 'dm' ? `to ${agent}` : r.kind === 'mention' ? `mentioned ${agent} in ${whereOf(i, members)}` : `capped in ${whereOf(i, members)}, woke no agent`;
        const to = contextOf(i);
        return (
          <Row key={`${r.kind}-${i.id}`} icon={r.kind === 'dm' ? 'message' : r.kind === 'mention' ? 'mention' : 'capped'} label={`${at(i.from, members)} ${says}: ${quoteOf(i.message, 60)}`}
            onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: to.kind === 'channel' ? { ...to, only: r.agent } : to })} />
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5 },
  chipText: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 14 },
});
