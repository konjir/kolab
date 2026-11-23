import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { useApi, useChannels, useMembers } from '@/kolab/hooks';
import { handleOf } from '@/kolab/names';
import { ownAgents } from '@/kolab/your-agents';
import { Body, ChoiceRow, Hint, Problem, Row, Screen, Section, SwitchRow } from '@/ui';

/**
 * A channel's details, opened from its title: following it (every channel is public), showing only
 * one of your agents' messages in it, and what notifies you. Choosing a filter goes back to the
 * channel with it on.
 */
export default function ChannelDetails() {
  const { name, only } = useLocalSearchParams<{ name: string; only?: string }>();
  const auth = useAuth();
  const team = auth.current?.team ?? '';
  const router = useRouter();
  const qc = useQueryClient();
  const api = useApi();
  const channels = useChannels(team);
  const channel = channels.data?.channels.find((c) => c.channel === name);
  // The switch shows what was chosen until Kolab's list says so too.
  const [want, setWant] = useState<boolean>();
  const agents = ownAgents(useMembers(team).data?.members, auth.current?.actor ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const back = (agent?: string) => router.dismissTo({ pathname: '/c/[kind]/[name]', params: { kind: 'channel', name, only: agent ?? '', chosen: String(Date.now()) } });

  const follow = async (on: boolean) => {
    setBusy(true); setProblem(undefined); setWant(on);
    try { const k = await api(team); await (on ? k.follow(name) : k.unfollow(name)); await qc.invalidateQueries({ queryKey: [team, 'channels'] }); }
    catch (e) { setProblem((e as Error).message); } finally { setBusy(false); setWant(undefined); }
  };

  return (
    <Screen title={`#${name}`} testID="channel-details">
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      {channel === undefined && <Hint>{channels.isLoading ? 'Reading…' : `${team} has no channel #${name}.`}</Hint>}
      {channel && (
        <Section title="You">
          <SwitchRow testID="follow" icon="channel" label="Following" value={want ?? channel.following} busy={busy} onChange={(on) => void follow(on)} />
          <Row testID="channel-notifications" icon="notifications" label="Notifications" chevron onPress={() => router.push('/notifications')} />
        </Section>
      )}
      {problem && <Problem>{problem}</Problem>}
      {agents.length > 0 && (
        <Section title="Show">
          <ChoiceRow testID="only-none" label="Everything" chosen={!only} onPress={() => back()} />
          {agents.map((a) => <ChoiceRow key={a.actor} testID={`only-${a.actor}`} label={`Only @${handleOf(a)}'s messages`} chosen={only === a.actor} onPress={() => back(a.actor)} />)}
        </Section>
      )}
      {agents.length > 0 && <Body>While the channel shows one agent&apos;s messages, nothing in it is marked read.</Body>}
    </Screen>
  );
}
