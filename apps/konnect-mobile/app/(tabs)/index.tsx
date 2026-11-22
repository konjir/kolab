import type { Channel, Member } from '@konjir/types';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { RefreshControl } from 'react-native';
import { useAuth, type Auth } from '@/auth/AuthProvider';
import { SignedOut } from '@/auth/tokens';
import type { IconName } from '@/icons';
import { Button, Hint, Notice, Problem, Row, Screen, Section } from '@/ui';

type TeamView = { team: string; channels: Channel[]; people: Member[]; agents: Member[] } | { team: string; problem: string };

const STATE_ICON: Record<string, IconName> = { working: 'stateWorking', running: 'stateRunning', idle: 'stateIdle' };

/** A team's channels and members, from Kolab (konjir_list_channels, konjir_list_members), or why not. */
async function readTeam(auth: Auth, team: string): Promise<TeamView> {
  try {
    const client = await auth.client(team);
    const [c, m] = await Promise.all([
      client.callTool({ name: 'konjir_list_channels', arguments: {} }),
      client.callTool({ name: 'konjir_list_members', arguments: {} }),
    ]);
    if (c.isError || m.isError) throw new Error('Kolab refused to list the team');
    const channels = (c.structuredContent as { channels: Channel[] }).channels;
    const members = (m.structuredContent as { members: Member[] }).members;
    return { team, channels, people: members.filter((x) => x.kind === 'person'), agents: members.filter((x) => x.kind === 'agent') };
  } catch (e) {
    return { team, problem: e instanceof SignedOut ? `Kolab ended your sign-in to ${team}. Sign in again on the You tab.` : `Couldn't read ${team}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Home: the team shown, with a switcher, and its channels, people and agents, read from Kolab.
 * Read-only: conversations come in phase 3.
 */
export default function Home() {
  const auth = useAuth();
  const router = useRouter();
  const [view, setView] = useState<TeamView>();
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const team = auth.current?.team;

  useEffect(() => {
    if (!team) return;
    let live = true;
    void readTeam(auth, team).then((v) => { if (live) setView(v); });
    return () => { live = false; };
    // auth.client is the same for a team for as long as the provider lives.
  }, [team]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    if (!team) return;
    setRefreshing(true);
    setView(await readTeam(auth, team));
    setRefreshing(false);
  };

  if (!auth.ready) return <Screen title="Home" testID="home"><Hint>…</Hint></Screen>;
  if (!team) {
    return (
      <Screen title="Home" testID="home">
        <Notice>You aren&apos;t signed in to a team. Sign in to see its channels, people and agents.</Notice>
        <Button testID="home-sign-in" label="Sign in on the You tab" onPress={() => router.navigate('/you')} />
      </Screen>
    );
  }
  const shown = view?.team === team ? view : undefined;

  return (
    <Screen title="Home" testID="home" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}>
      <Section title="Team">
        <Row testID="team-switcher" icon="teamSwitcher" label={team} detail={auth.teams.length > 1 ? `${auth.teams.length} teams` : auth.current?.actor}
          onPress={auth.teams.length > 1 ? () => setSwitching((s) => !s) : undefined} />
        {switching && auth.teams.filter((t) => t.team !== team).map((t) => (
          <Row key={t.team} testID={`switch-${t.team}`} icon="team" label={t.team} detail={t.actor} onPress={() => { setSwitching(false); void auth.switchTeam(t.team); }} />
        ))}
      </Section>
      <Notice icon="update">Read-only for now: opening a channel or a conversation comes next.</Notice>
      {!shown && <Hint>Reading {team}…</Hint>}
      {shown && 'problem' in shown && <Problem>{shown.problem}</Problem>}
      {shown && 'channels' in shown && (
        <>
          <Section title="Channels">
            {shown.channels.map((ch) => <Row key={ch.channel} icon="channel" label={ch.channel} detail={ch.unread ? `${ch.unread}${ch.unread_more ? '+' : ''} unread` : ch.following ? undefined : 'not following'} />)}
          </Section>
          <Section title="People">
            {shown.people.map((p) => <Row key={p.actor} icon="person" label={p.actor} detail={p.you ? 'you' : p.here ? 'here' : undefined} />)}
          </Section>
          <Section title="Agents">
            {shown.agents.length === 0 && <Hint>No agents in {team} yet.</Hint>}
            {shown.agents.map((a) => <Row key={a.actor} icon={STATE_ICON[a.state ?? ''] ?? 'stateStopped'} label={a.owner && a.label ? `${a.owner}/${a.label}` : a.actor} detail={a.state ?? 'not running'} />)}
          </Section>
        </>
      )}
    </Screen>
  );
}
