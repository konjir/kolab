import type { Member } from '@konjir/types';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { Icon, type IconName } from '@/icons';
import { useAnswers, useChannels, useMembers } from '@/kolab/hooks';
import { handleOf } from '@/kolab/names';
import { unreadOf, type Unread } from '@/kolab/unread';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Hint, Problem, Screen, Section } from '@/ui';

const STATE_ICON: Record<string, IconName> = { working: 'stateWorking', running: 'stateRunning', idle: 'stateIdle' };

/**
 * Home, in Slack's order: the team switcher at top left, "Jump to…" (which filters what's below,
 * on the phone), then Unreads, Channels you follow, Direct messages and Agents. Unread rows are
 * bold, with a badge for mentions. The pencil at bottom right starts a new message.
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
  const [jump, setJump] = useState('');
  const [switching, setSwitching] = useState(false);
  if (!team) return null; // The root layout's gate shows the sign-in screen while no team is signed in.

  const unread = unreadOf(answers.data);
  const q = jump.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const me = auth.current!.actor;
  const followed = (channels.data?.channels ?? []).filter((c) => c.following && match(c.channel));
  const all = members.data?.members ?? [];
  const people = all.filter((m) => m.kind === 'person' && m.actor !== me && match(m.actor));
  const agents = all.filter((m) => m.kind === 'agent' && match(handleOf(m)));
  const unreadRows = [
    ...[...unread.channels].filter(([c]) => match(c)).map(([c, u]) => ({ key: `c-${c}`, label: `#${c}`, href: `/c/channel/${c}`, u, icon: 'channel' as IconName })),
    ...[...unread.dms].filter(([p]) => match(p)).map(([p, u]) => ({ key: `d-${p}`, label: p, href: `/c/dm/${p}`, u, icon: 'person' as IconName })),
  ];
  const problem = [channels, members, answers].find((x) => x.error)?.error as Error | undefined;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Screen title={team} testID="home" refreshControl={<RefreshControl refreshing={channels.isRefetching} onRefresh={() => void qc.invalidateQueries({ queryKey: [team] })} />}>
        <View style={styles.top}>
          <Pressable testID="team-switcher" accessibilityRole="button" accessibilityLabel={`Teams: ${team}`} onPress={() => setSwitching((s) => !s)} style={[styles.switcher, { backgroundColor: colors.accent }]}>
            <Text style={[styles.switcherText, { color: colors['on-accent'] }]}>{team.slice(0, 2).toUpperCase()}</Text>
          </Pressable>
          <TextInput testID="jump" value={jump} onChangeText={setJump} placeholder="Jump to…" placeholderTextColor={colors['ink-muted']} autoCapitalize="none" autoCorrect={false}
            style={[styles.jump, { color: colors.ink, backgroundColor: colors['surface-raised'], borderColor: colors.line }]} />
        </View>
        {switching && (
          <Section title="Teams">
            {auth.teams.map((t) => (
              <Item key={t.team} testID={`switch-${t.team}`} icon={t.team === team ? 'following' : 'team'} label={t.team} detail={t.actor}
                onPress={() => { setSwitching(false); void auth.switchTeam(t.team); }} />
            ))}
            <Item icon="signIn" label="Add a team" onPress={() => { setSwitching(false); router.navigate('/you'); }} />
          </Section>
        )}
        {problem && <Problem>{problem.message}</Problem>}
        {unreadRows.length > 0 && (
          <Section title="Unreads">
            {unreadRows.map((r) => <Item key={r.key} icon={r.icon} label={r.label} unread={r.u} onPress={() => router.push(r.href as Href)} />)}
          </Section>
        )}
        <Section title="Channels">
          {followed.map((c) => <Item key={c.channel} icon="channel" label={c.channel} unread={unread.channels.get(c.channel)} onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'channel', name: c.channel } })} />)}
          {!channels.isLoading && followed.length === 0 && <Hint>{q ? 'No channel matches.' : 'You follow no channel.'}</Hint>}
          <Item icon="browseChannels" label="Browse channels" onPress={() => router.push('/browse')} />
        </Section>
        <Section title="Direct messages">
          {people.map((p) => <PersonItem key={p.actor} m={p} unread={unread.dms.get(p.actor)} onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: p.actor } })} />)}
          {!members.isLoading && people.length === 0 && <Hint>{q ? 'Nobody matches.' : 'Nobody else is in this team yet.'}</Hint>}
        </Section>
        <Section title="Agents">
          {agents.map((a) => <Item key={a.actor} icon={STATE_ICON[a.state ?? ''] ?? 'stateStopped'} label={handleOf(a)} detail={a.state ?? 'not running'} unread={unread.dms.get(a.actor)}
            onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: a.actor } })} />)}
          {!members.isLoading && agents.length === 0 && <Hint>{q ? 'No agent matches.' : 'No agents in this team yet.'}</Hint>}
        </Section>
        <View style={{ height: 72 }} />
      </Screen>
      <Pressable testID="new-message" accessibilityRole="button" accessibilityLabel="New message" onPress={() => router.push('/new')} style={[styles.fab, { backgroundColor: colors.accent }]}>
        <Icon name="newMessage" size={24} tintColor={colors['on-accent']} />
      </Pressable>
    </View>
  );
}

function PersonItem({ m, unread, onPress }: { m: Member; unread?: Unread; onPress: () => void }) {
  return <Item icon="person" label={m.actor} detail={m.here ? 'here' : undefined} unread={unread} onPress={onPress} />;
}

/** A row of Home: bold when unread, with a badge counting mentions. */
function Item({ icon, label, detail, unread, onPress, testID }: { icon: IconName; label: string; detail?: string; unread?: Unread; onPress: () => void; testID?: string }) {
  const { colors } = useAppTheme();
  const bold = !!unread?.count;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${label}${bold ? `, ${unread!.count} unread` : ''}`} onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && { backgroundColor: colors['accent-soft'] }]}>
      <Icon name={icon} size={18} tintColor={bold ? colors.ink : colors['ink-muted']} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text numberOfLines={1} style={[styles.label, { color: bold ? colors.ink : colors['ink-muted'], fontWeight: bold ? '700' : '400' }]}>{label}</Text>
      {detail && <Text style={[styles.detail, { color: colors['ink-muted'] }]}>{detail}</Text>}
      {!!unread?.mentions && <View style={[styles.badge, { backgroundColor: colors.boundary }]}><Text style={[styles.badgeText, { color: colors['on-accent'] }]}>{unread.mentions}</Text></View>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  switcher: { width: 40, height: 40, borderRadius: RADII.md, alignItems: 'center', justifyContent: 'center' },
  switcherText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 15 },
  jump: { flex: 1, height: 40, borderRadius: RADII.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, fontFamily: FAMILIES.sans, fontSize: 15 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  label: { flex: 1, fontFamily: FAMILIES.sans, fontSize: 16 },
  detail: { fontFamily: FAMILIES.mono, fontSize: 12 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 12 },
  fab: { position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
});
