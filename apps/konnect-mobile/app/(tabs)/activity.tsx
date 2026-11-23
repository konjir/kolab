import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { useAgentActivity, useAgentStatus, useAnswers, useMembers } from '@/kolab/hooks';
import { senderName } from '@/kolab/names';
import { quoteOf } from '@/kolab/thread';
import { activityOf, opensTo } from '@/kolab/unread';
import { at, contextOf, ownAgents, whereOf, yourAgentsActivity } from '@/kolab/your-agents';
import type { Member } from '@konjir/types';
import { Avatar, presenceOf } from '@/Avatar';
import { Icon, type IconName } from '@/icons';
import { conversationHref, memberHref, shortWhen } from '@/routes';
import { buttonCorners, FAMILIES, useAppTheme } from '@/theme';
import { Hint, ListRow, Notice, Problem, Screen, Section } from '@/ui';

/** Who a row is from, as their picture with what happened as a small mark; their name's initials before members are read. */
function Who({ actor, members, mark }: { actor: string; members: Member[] | undefined; mark: IconName }) {
  const { colors } = useAppTheme();
  const m = members?.find((x) => x.actor === actor);
  const owner = m?.owner ? members?.find((x) => x.actor === m.owner) : undefined;
  return (
    <View style={{ width: 40, height: 40 }}>
      {m ? <Avatar member={m} owner={owner} size={40} /> : <Icon name="person" size={24} tintColor={colors['ink-muted']} />}
      <View style={[styles.mark, { backgroundColor: colors.accent, borderColor: colors.surface }]}><Icon name={mark} size={10} tintColor={colors['on-accent']} /></View>
    </View>
  );
}

const KIND = { mention: { icon: 'mention', says: 'mentioned you' }, reply: { icon: 'reply', says: 'replied' }, capped: { icon: 'capped', says: 'went past the reply cap' } } as const;

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
              const name = senderName(item, members);
              // A direct message from a deleted account opens nothing: there is no one to write back to.
              const to = opensTo(item);
              const open = to ? () => router.push(conversationHref(to.kind, to.name)) : undefined;
              return (
                <ListRow key={`${kind}-${item.id}`} testID={`activity-${item.id}`} leading={<Who actor={item.from} members={members} mark={KIND[kind].icon} />}
                  title={`${name} ${KIND[kind].says} in ${where}`} unread subtitle={quoteOf(item.message, 100)} time={shortWhen(item.sent_at)}
                  onPress={open} />
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
  const { colors } = useAppTheme();
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
          const m = members?.find((x) => x.actor === r.agent);
          const title = r.reason === 'capped' ? `${agent} is at the reply cap` : `${agent} isn't running`;
          const sub = r.reason === 'capped' ? `${r.count} past the cap woke no agent` : `${r.count} waiting for it`;
          return <ListRow key={`stuck-${r.reason}-${r.agent}`} leading={m ? <Avatar member={m} size={40} presence={presenceOf(m.state)} /> : <Icon name="agent" size={24} tintColor={colors.accent} />}
            title={title} unread subtitle={sub} subTone="alert" onPress={() => router.push(memberHref(r.agent, 'agent'))} />;
        }
        const i = r.item;
        const says = r.kind === 'dm' ? `to ${agent}` : r.kind === 'mention' ? `mentioned ${agent} in ${whereOf(i, members)}` : `capped in ${whereOf(i, members)}`;
        const to = contextOf(i);
        return (
          <ListRow key={`${r.kind}-${i.id}`} leading={<Who actor={i.from} members={members} mark={r.kind === 'dm' ? 'message' : r.kind === 'mention' ? 'mention' : 'capped'} />}
            title={`${at(i.from, members)} ${says}`} unread subtitle={quoteOf(i.message, 100)} time={shortWhen(i.sent_at)}
            onPress={() => router.push(to.kind === 'channel' ? conversationHref('channel', to.name, { only: r.agent }) : conversationHref('dm', to.name, to.as ? { as: to.as } : undefined))} />
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 8 },
  chip: { borderWidth: 1, height: 32, ...buttonCorners(32), paddingHorizontal: 14, justifyContent: 'center' },
  chipText: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 14 },
  mark: { position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
