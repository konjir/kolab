import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { useApi, useChannels, useMembers } from '@/kolab/hooks';
import { displayOf } from '@/kolab/names';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Body, Button, Hint, Problem, Row, Screen, Section } from '@/ui';

/**
 * Team settings (phase 5): invite people by their GitHub usernames, see and withdraw the
 * invitations, remove a member or an agent, and leave. The owner's alone: the agent reply cap,
 * archiving and deleting, each of the last two only once the team's name is typed. Kolab decides
 * who may do what, and its refusal is shown as it says it.
 */
export default function TeamSettings() {
  const auth = useAuth();
  const team = auth.current?.team ?? '';
  const me = auth.current?.actor ?? '';
  const { colors } = useAppTheme();
  const qc = useQueryClient();
  const api = useApi();
  const members = useMembers(team).data?.members ?? [];
  const cap = useChannels(team).data?.agent_reply_cap;
  const invitations = useQuery({ queryKey: [team, 'invitations'], enabled: !!team, queryFn: async () => (await api(team)).invitations() });
  const [invite, setInvite] = useState('');
  const [capText, setCapText] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const input = [styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }];

  const run = async (what: string, f: () => Promise<string | void>) => {
    setBusy(what); setProblem(undefined); setSaid(undefined);
    try { const s = await f(); if (s) setSaid(s); await qc.invalidateQueries({ queryKey: [team] }); } catch (e) { setProblem((e as Error).message); } finally { setBusy(undefined); }
  };
  const ask = (title: string, message: string, yes: string, f: () => void) => Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: yes, style: 'destructive', onPress: f }]);
  // Out of this team: on to another of the person's teams, or signed out when there is none.
  const leaveAfter = async (f: () => Promise<unknown>) => {
    await f();
    const mine = await auth.adapter.list(await auth.client(), { team, role: auth.current?.role ?? '' }).catch(() => undefined);
    const next = mine?.switching ? mine.teams.find((t) => t.kolab !== team) : undefined;
    if (next) await auth.switchTeam(next.kolab); else await auth.signOut();
  };

  return (
    <Screen title={team} testID="team">
      <Stack.Screen options={{ headerShown: true, title: 'Team settings', headerBackTitle: 'You', headerStyle: { backgroundColor: colors['surface-raised'] }, headerTintColor: colors.ink }} />
      {problem && <Problem>{problem}</Problem>}
      {said && <Body>{said}</Body>}

      <Section title="Invite">
        <View style={[styles.line, styles.pad, { paddingTop: 12 }]}>
          <TextInput testID="invite" value={invite} onChangeText={setInvite} placeholder="GitHub usernames, comma-separated" autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors['ink-muted']} style={input} />
          <Button testID="send-invite" quiet label="Invite" busy={busy === 'invite'} onPress={() => {
            const accounts = invite.split(/[\s,]+/).map((s) => s.replace(/^@/, '')).filter(Boolean);
            if (!accounts.length) return;
            void run('invite', async () => { await (await api(team)).invite(accounts); setInvite(''); return `Invited ${accounts.join(', ')}: each accepts on Kolab's page when they next sign in.`; });
          }} />
        </View>
      </Section>
      <Section title="Invitations">
        {(invitations.data?.invitations ?? []).length === 0 && <Hint>{invitations.isLoading ? 'Reading…' : invitations.error ? (invitations.error as Error).message : 'None waiting.'}</Hint>}
        {(invitations.data?.invitations ?? []).map((i) => {
          const id = String(i.id ?? i.invitation ?? '');
          const who = String(i.login ?? i.account ?? i.invitee ?? id);
          return <Row key={id} icon="invite" label={who} detail="withdraw" onPress={() => ask(`Withdraw ${who}'s invitation?`, 'They won\'t be able to accept it.', 'Withdraw', () => void run(id, async () => { await (await api(team)).withdrawInvitation(id); return `Withdrew ${who}'s invitation.`; }))} />;
        })}
      </Section>
      <Section title="Members">
        {members.filter((m) => m.actor !== me).map((m) => (
          <Row key={m.actor} icon="remove" label={displayOf(m)} detail="remove" onPress={() => ask(`Remove ${displayOf(m)} from ${team}?`, m.kind === 'agent' ? 'The agent is removed, and its sign-ins end.' : 'They lose the team and its messages.', 'Remove',
            () => void run(m.actor, async () => { const k = await api(team); await (m.kind === 'agent' ? k.removeAgent(m.actor) : k.removeMember(m.actor)); return `Removed ${displayOf(m)}.`; }))} />
        ))}
      </Section>

      <Section title="Owner only">
        <Hint>How many messages one agent may send that could wake an agent, with none from a person in between: now {cap ?? '…'}.</Hint>
        <View style={[styles.line, styles.pad]}>
          <TextInput testID="cap" value={capText} onChangeText={setCapText} keyboardType="number-pad" placeholder={String(cap ?? '')} placeholderTextColor={colors['ink-muted']} style={input} />
          <Button quiet label="Set cap" busy={busy === 'cap'} onPress={() => { const n = Number(capText); if (!Number.isInteger(n) || n < 0) { setProblem('The cap is a whole number.'); return; } void run('cap', async () => { await (await api(team)).setReplyCap(n); setCapText(''); return `The agent reply cap is ${n}.`; }); }} />
        </View>
        <Hint>To archive or delete {team}, type its name.</Hint>
        <View style={styles.pad}><TextInput testID="confirm-name" value={confirm} onChangeText={setConfirm} placeholder={team} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors['ink-muted']} style={input} /></View>
        <View style={[styles.line, styles.pad]}>
          <Button quiet label="Archive" busy={busy === 'archive'} onPress={() => { if (confirm !== team) { setProblem(`Type ${team} to archive it.`); return; } ask(`Archive ${team}?`, 'Nobody can write in it any more; it can still be read.', 'Archive', () => void run('archive', async () => { await (await api(team)).archive(team); return `Archived ${team}.`; })); }} />
          <Button quiet label="Delete" busy={busy === 'erase'} onPress={() => { if (confirm !== team) { setProblem(`Type ${team} to delete it.`); return; } ask(`Delete ${team}?`, 'It and everything in it are gone, for everyone. This can\'t be undone.', 'Delete', () => void run('erase', () => leaveAfter(async () => (await api(team)).erase(team)))); }} />
        </View>
      </Section>

      <Button quiet label={`Leave ${team}`} busy={busy === 'leave'} onPress={() => ask(`Leave ${team}?`, 'You lose the team and its messages until someone invites you back.', 'Leave', () => void run('leave', () => leaveAfter(async () => (await api(team)).leave())))} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  pad: { paddingHorizontal: 14, paddingBottom: 12 },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 11, fontFamily: FAMILIES.sans, fontSize: 15 },
});
