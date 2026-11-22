/**
 * The team switcher, as Slack's workspace switcher: the person's teams (konjir_list_my_teams), each
 * with an unread dot and a mention badge, the one shown ticked; their invitations, each accepted on
 * Kolab's page; and making a team. Tapping a team moves the sign-in there and lands on its Home.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from './auth/AuthProvider';
import { SignInStopped } from './auth/sign-in';
import { Icon } from './icons';
import { switcherOrder, type MyTeams } from './kolab/teams';
import { FAMILIES, RADII, useAppTheme } from './theme';
import { Button, Hint, Problem, Section } from './ui';

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The person's teams and invitations, read again whenever the app comes to the foreground. */
export function useMyTeams() {
  const auth = useAuth();
  const me = auth.current;
  const q = useQuery<MyTeams>({
    queryKey: ['account', me?.actor, 'teams'],
    enabled: !!me,
    queryFn: async () => auth.adapter.list(await auth.client(), { team: me!.team, role: me!.role }),
  });
  const { refetch } = q;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void refetch(); });
    return () => sub.remove();
  }, [refetch]);
  return q;
}

export function TeamSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const auth = useAuth();
  const router = useRouter();
  const { colors } = useAppTheme();
  const mine = useMyTeams();
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [name, setName] = useState('');

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what); setProblem(undefined);
    try { await f(); onClose(); router.navigate('/'); void mine.refetch(); }
    catch (e) { setProblem(e instanceof SignInStopped ? `Not done: ${e.message}.` : (e as Error).message); }
    finally { setBusy(undefined); }
  };
  const teams = switcherOrder(mine.data?.teams ?? []);

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView testID="team-switcher-sheet" style={{ backgroundColor: colors.surface }} contentContainerStyle={styles.sheet}>
        <View style={styles.head}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>Teams</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}><Text style={{ color: colors.accent, fontFamily: FAMILIES.sans, fontSize: 16 }}>Done</Text></Pressable>
        </View>
        {problem && <Problem>{problem}</Problem>}
        <Section title={auth.current ? `${auth.current.actor} on GitHub` : 'Your teams'}>
          {mine.isLoading && <Hint>Reading…</Hint>}
          {mine.error && <Hint>{(mine.error as Error).message}</Hint>}
          {teams.map((t) => (
            <Pressable key={t.kolab} testID={`team-${t.kolab}`} accessibilityRole="button"
              accessibilityLabel={`${t.kolab}${t.current ? ', current' : ''}${t.unread ? `, ${t.unread}${t.unread_more ? '+' : ''} unread` : ''}${t.mentions ? `, ${t.mentions} mentions` : ''}`}
              disabled={t.current || !!busy} onPress={() => void run(t.kolab, () => auth.switchTeam(t.kolab))}
              style={({ pressed }) => [styles.team, pressed && { backgroundColor: colors['accent-soft'] }]}>
              <View style={[styles.tile, { backgroundColor: t.current ? colors.accent : colors['surface-sunken'] }]}>
                <Text style={[styles.tileText, { color: t.current ? colors['on-accent'] : colors.ink }]}>{t.kolab.slice(0, 2).toUpperCase()}</Text>
                {!t.current && t.unread > 0 && !t.mentions && <View style={[styles.dot, { backgroundColor: colors.ink, borderColor: colors.surface }]} />}
              </View>
              <Text style={[styles.name, { color: colors.ink, fontWeight: t.unread ? '700' : '500' }]}>{t.kolab}</Text>
              {busy === t.kolab && <Text style={{ color: colors['ink-muted'] }}>…</Text>}
              {t.mentions > 0 && !t.current && <View style={[styles.badge, { backgroundColor: colors.boundary }]}><Text style={[styles.badgeText, { color: colors['on-accent'] }]}>{t.mentions}{t.mentions_more ? '+' : ''}</Text></View>}
              {t.current && <Icon name="following" size={20} tintColor={colors.accent} />}
            </Pressable>
          ))}
          {mine.data && !mine.data.switching && <Hint>This Kolab can&apos;t list or switch your teams yet.</Hint>}
        </Section>
        {(mine.data?.invitations.length ?? 0) > 0 && (
          <Section title="Invitations">
            {mine.data!.invitations.map((i) => (
              <View key={i.kolab} style={styles.team}>
                <Icon name="invite" size={20} tintColor={colors.accent} />
                <Text style={[styles.name, { color: colors.ink }]}>{i.kolab}<Text style={{ color: colors['ink-muted'] }}>{`  from ${i.invited_by}`}</Text></Text>
                <Button testID={`accept-${i.kolab}`} quiet label="Accept" busy={busy === `accept-${i.kolab}`} onPress={() => void run(`accept-${i.kolab}`, () => auth.signIn({ kind: 'choose' }))} />
              </View>
            ))}
            <Hint>Accepting opens Kolab&apos;s page, where you accept it.</Hint>
          </Section>
        )}
        <Section title="Make a team">
          <View style={[styles.team, { gap: 8 }]}>
            <TextInput testID="new-team" value={name} onChangeText={(s) => setName(s.toLowerCase())} placeholder="new-team-name" autoCapitalize="none" autoCorrect={false}
              placeholderTextColor={colors['ink-muted']} style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }]} />
            <Button testID="create-team" quiet label="Make" busy={busy === 'create'} onPress={() => {
              if (!NAME.test(name)) { setProblem('A team\'s name is up to 40 lowercase letters, digits and \'-\', starting with a letter or digit.'); return; }
              void run('create', async () => { await auth.signIn({ kind: 'create', team: name }); setName(''); });
            }} />
          </View>
        </Section>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 16, gap: 18 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontFamily: FAMILIES.display, fontWeight: '600', fontSize: 28 },
  team: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  tile: { width: 36, height: 36, borderRadius: RADII.md, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 13 },
  dot: { position: 'absolute', right: -3, top: -3, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  name: { flex: 1, fontFamily: FAMILIES.sans, fontSize: 16 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 12 },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 10, fontFamily: FAMILIES.mono, fontSize: 15 },
});
