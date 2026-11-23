import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useAuth } from '@/auth/AuthProvider';
import { useApi, useChannels } from '@/kolab/hooks';
import { FAMILIES, RADII, useAppTheme } from '@/theme';
import { Button, Hint, Problem, Screen, Section, SwitchRow } from '@/ui';

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Every channel of the team, each with a switch to follow it, and making one. Every channel is public. */
export default function Browse() {
  const team = useAuth().current?.team ?? "";
  const { colors } = useAppTheme();
  const router = useRouter();
  const qc = useQueryClient();
  const api = useApi();
  const channels = useChannels(team);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState<string>();
  // Each switch shows what was chosen until Kolab's list says so too.
  const [want, setWant] = useState<Record<string, boolean>>({});

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what); setProblem(undefined);
    try { await f(); await qc.invalidateQueries({ queryKey: [team, 'channels'] }); } catch (e) { setProblem((e as Error).message); } finally { setBusy(undefined); }
  };

  return (
    <Screen title="Browse channels" testID="browse">
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      <View style={styles.create}>
        <TextInput testID="new-channel" value={name} onChangeText={(s) => setName(s.toLowerCase().replace(/^#/, ''))} placeholder="Name a new channel" autoCapitalize="none" autoCorrect={false}
          placeholderTextColor={colors['ink-muted']} style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors['surface-raised'] }]} />
        <Button testID="make-channel" quiet label="Create" busy={busy === 'make'} onPress={() => {
          if (!NAME.test(name)) { setProblem('A channel\'s name is up to 40 lowercase letters, digits and \'-\', starting with a letter or digit.'); return; }
          void run('make', async () => { await (await api(team)).makeChannel(name); setName(''); router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'channel', name } }); });
        }} />
      </View>
      {problem && <Problem>{problem}</Problem>}
      <Section title={`Following · ${channels.data?.channels.length ?? 0} channels`}>
        {channels.isLoading && <Hint>Reading…</Hint>}
        {channels.data?.channels.map((c) => (
          <SwitchRow key={c.channel} testID={`channel-${c.channel}`} icon="channel" label={c.channel} value={want[c.channel] ?? c.following} busy={busy === c.channel}
            onChange={(on) => { setWant((w) => ({ ...w, [c.channel]: on })); void run(c.channel, async () => { const k = await api(team); await (on ? k.follow(c.channel) : k.unfollow(c.channel)); }).finally(() => setWant(({ [c.channel]: _, ...rest }) => rest)); }} />
        ))}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  create: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 12, paddingVertical: 11, fontFamily: FAMILIES.mono, fontSize: 15 },
});
