import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar, presenceOf } from '@/Avatar';
import { useShowUnreads } from '@/device-prefs';
import { Icon } from '@/icons';
import { homeOf, type HomeChannel, type HomeDm } from '@/kolab/home';
import { useAgentStatus, useAnswers, useChannels, useConversations, useMembers } from '@/kolab/hooks';
import { displayName, displayOf } from '@/kolab/names';
import { badgeOf } from '@/kolab/teams';
import { unreadOf } from '@/kolab/unread';
import { lastLine, needsYouCount, needsYouWords } from '@/kolab/your-agents';
import { setBadge } from '@/push';
import { conversationHref, memberHref } from '@/routes';
import { TeamMenu, useMyTeams } from '@/TeamSwitcher';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Badge, Hint, ListRow, Problem, Screen, Section } from '@/ui';

/**
 * Home, in Slack's order: the team (tap it for the team menu: switch, invite, settings) and a new
 * message at the top, "Jump to…" (which filters what's below, on the phone), then Channels you
 * follow, Direct messages and Your agents, each thing once. Unread rows are bold; mentions and
 * direct messages have a badge. Unreads, a section of their own, is a setting under You.
 */
export default function Home() {
  const auth = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const { colors } = useAppTheme();
  const team = auth.current?.team;
  const channels = useChannels(team);
  const members = useMembers(team);
  const answers = useAnswers(team);
  const conversations = useConversations(team);
  const me = auth.current?.actor ?? '';
  const statuses = useAgentStatus(team).data;
  const myTeams = useMyTeams().data?.teams;
  const [showUnreads] = useShowUnreads();
  // The app's badge: what is unread across the person's teams, as a push sets it.
  const unreadTotal = myTeams ? badgeOf(myTeams) : unreadOf(answers.data).total;
  useEffect(() => { void setBadge(unreadTotal); }, [unreadTotal]);
  const [jump, setJump] = useState('');
  const [menu, setMenu] = useState(false);
  // Something unread in a team other than the one shown: a dot on the team's tile.
  const elsewhere = (myTeams ?? []).some((t) => !t.current && t.unread > 0);
  if (!team) return null; // The root layout's gate shows the sign-in screen while no team is signed in.

  const all = members.data?.members ?? [];
  const home = homeOf({
    me, channels: channels.data?.channels ?? [], members: all, conversations: conversations.data?.conversations ?? [],
    unread: unreadOf(answers.data), statuses, query: jump, showUnreads,
  });
  const searching = jump.trim().length > 0;
  const problem = [channels, members, answers].find((x) => x.error)?.error as Error | undefined;
  const open = (r: HomeChannel | HomeDm) => router.push(r.kind === 'channel' ? conversationHref('channel', r.name) : conversationHref('dm', r.with));

  const header = (
    <View style={styles.header}>
      <Pressable testID="team-switcher" accessibilityRole="button" accessibilityLabel={`Teams: ${team}${elsewhere ? ', unread in another team' : ''}`} onPress={() => setMenu(true)} style={styles.team}>
        <View style={[styles.tile, { backgroundColor: colors.accent }]}>
          <Text style={[styles.tileText, { color: colors['on-accent'] }]}>{team.slice(0, 2).toUpperCase()}</Text>
          {elsewhere && <View style={[styles.elsewhere, { backgroundColor: colors.boundary, borderColor: colors.surface }]} />}
        </View>
        <Text numberOfLines={1} accessibilityRole="header" style={[styles.teamName, { color: colors.ink }]}>{team}</Text>
        <Icon name="teamSwitcher" size={16} tintColor={colors['ink-muted']} />
      </Pressable>
      <Pressable testID="new-message" accessibilityRole="button" accessibilityLabel="New message" hitSlop={8} onPress={() => router.push('/new')} style={[styles.compose, { backgroundColor: colors['surface-raised'], borderColor: colors.line }]}>
        <Icon name="newMessage" size={20} tintColor={colors.accent} />
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Screen header={header} testID="home" refreshControl={<RefreshControl refreshing={channels.isRefetching} onRefresh={() => void qc.invalidateQueries({ queryKey: [team] })} />}>
        <TextInput testID="jump" value={jump} onChangeText={setJump} placeholder="Jump to…" placeholderTextColor={colors['ink-muted']} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing"
          style={[styles.jump, { color: colors.ink, backgroundColor: colors['surface-raised'], borderColor: colors.line }]} />
        {problem && <Problem>{problem.message}</Problem>}
        {home.unreads.length > 0 && (
          <Section title="Unreads">
            {home.unreads.map((r) => r.kind === 'channel'
              ? <ChannelRow key={`c-${r.name}`} row={r} onPress={() => open(r)} />
              : <DmRow key={`d-${r.with}`} row={r} name={displayName(r.with, all)} onPress={() => open(r)} />)}
          </Section>
        )}
        <Section title="Channels">
          {home.channels.map((r) => <ChannelRow key={r.name} row={r} onPress={() => open(r)} />)}
          {!channels.isLoading && home.channels.length === 0 && <Hint>{searching ? 'No channel matches.' : showUnreads && home.unreads.some((u) => u.kind === 'channel') ? 'Every channel you follow is under Unreads.' : 'You follow no channel.'}</Hint>}
          {!searching && <ChannelRow row={{ kind: 'channel', name: 'Browse channels' }} browse onPress={() => router.push('/browse')} />}
        </Section>
        <Section title="Direct messages">
          {home.dms.map((r) => <DmRow key={r.with} row={r} name={displayName(r.with, all)} onPress={() => open(r)} />)}
          {!conversations.isLoading && home.dms.length === 0 && <Hint>{searching ? 'Nobody matches.' : 'No direct messages yet: the pencil at the top starts one.'}</Hint>}
        </Section>
        {(home.agents.length > 0 || all.some((m) => m.kind === 'agent' && m.owner === me)) && (
          <Section title="Your agents">
            {home.agents.map((a) => {
              const needs = needsYouCount(a.status?.needs_you);
              const state = a.status?.state ?? a.member.state ?? null;
              return (
                <ListRow key={a.member.actor} testID={`agent-${a.member.actor}`} leading={<Avatar member={a.member} size={32} presence={presenceOf(state)} />}
                  title={displayOf(a.member)} unread={!!a.unread?.count || needs > 0} badge={a.unread?.mentions}
                  subtitle={needs ? `Needs you: ${needsYouWords(a.status?.needs_you).join(', ')}` : lastLine(a.status) ?? state ?? 'not running'} subTone={needs ? 'alert' : undefined}
                  accessibilityLabel={`${displayOf(a.member)}, ${state ?? 'not running'}${a.unread?.count ? `, ${a.unread.count} unread` : ''}${needs ? ', needs you' : ''}`}
                  onPress={() => router.push(memberHref(a.member.actor, 'agent'))} />
              );
            })}
            {home.agents.length === 0 && <Hint>No agent of yours matches.</Hint>}
          </Section>
        )}
      </Screen>
      <TeamMenu open={menu} onClose={() => setMenu(false)} />
    </View>
  );
}

/** A channel's row: bold when unread, with a badge for mentions of you. */
function ChannelRow({ row, browse, onPress }: { row: HomeChannel; browse?: boolean; onPress: () => void }) {
  const { colors } = useAppTheme();
  const bold = !!row.unread?.count;
  return (
    <Pressable testID={browse ? 'browse-channels' : undefined} accessibilityRole="button" accessibilityLabel={browse ? row.name : `#${row.name}${bold ? `, ${row.unread!.count} unread` : ''}`} onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors['accent-soft'] }]}>
      <Icon name={browse ? 'browseChannels' : 'channel'} size={18} tintColor={bold ? colors.ink : colors['ink-muted']} />
      <Text numberOfLines={1} style={[styles.label, { color: bold ? colors.ink : colors['ink-muted'], fontWeight: bold ? '700' : '400' }]}>{row.name}</Text>
      <Badge count={row.unread?.mentions ?? 0} />
    </Pressable>
  );
}

/** A direct message's row: their picture, with a dot when they're here, and a badge for what's unread. */
function DmRow({ row, name, onPress }: { row: HomeDm; name: string; onPress: () => void }) {
  const { colors } = useAppTheme();
  const bold = !!row.unread?.count;
  const m = row.member;
  return (
    <Pressable testID={`dm-row-${row.with}`} accessibilityRole="button" accessibilityLabel={`${name}${bold ? `, ${row.unread!.count} unread` : ''}`} onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors['accent-soft'] }]}>
      {m ? <Avatar member={m} size={22} presence={m.kind === 'agent' ? presenceOf(m.state) : m.here ? 'here' : undefined} /> : <Icon name="person" size={18} tintColor={colors['ink-muted']} />}
      <Text numberOfLines={1} style={[styles.label, { color: bold ? colors.ink : colors['ink-muted'], fontWeight: bold ? '700' : '400' }]}>{name}</Text>
      <Badge count={row.unread?.mentions ?? 0} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  team: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  tile: { width: 36, height: 36, borderRadius: RADII.md, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 14 },
  teamName: { flexShrink: 1, fontFamily: FAMILIES.display, fontWeight: '700', fontSize: 30 },
  elsewhere: { position: 'absolute', right: -3, top: -3, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  compose: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  jump: { height: 40, borderRadius: RADII.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, fontFamily: FAMILIES.sans, fontSize: 15 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  label: { flex: 1, fontFamily: FAMILIES.sans, fontSize: 16 },
});
