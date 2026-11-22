import { Stack } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { useChannels } from '@/kolab/hooks';
import { DEFAULT_PREFS, kolabHasPush, PUSH_STATUS_KEY, setPrefs, type NotifyLevel, type NotifyPrefs } from '@/push';
import { useAppTheme } from '@/theme';
import { Body, Button, Hint, Problem, Row, Screen, Section } from '@/ui';

const LEVELS: { level: NotifyLevel; label: string }[] = [
  { level: 'all', label: 'Every message' },
  { level: 'mentions_and_dms', label: 'Mentions and direct messages' },
  { level: 'none', label: 'Nothing' },
];

/**
 * Notifications, per team: what reaches the phone, which channels are muted, and whether a
 * notification shows the message's first words. The text passes through Expo's push service and
 * Apple's or Google's; hiding it keeps it to the sender and the conversation.
 */
export default function NotificationSettings() {
  const auth = useAuth();
  const team = auth.current?.team ?? '';
  const { colors } = useAppTheme();
  const channels = useChannels(team).data?.channels ?? [];
  const key = `konnect.notify.${team}`;
  const [prefs, setLocal] = useState<NotifyPrefs>(DEFAULT_PREFS);
  const [status, setStatus] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [said, setSaid] = useState<string>();

  useEffect(() => {
    let live = true;
    void Promise.all([Storage.getItem(key), Storage.getItem(PUSH_STATUS_KEY)]).then(([p, s]) => {
      if (!live) return;
      if (p) setLocal({ ...DEFAULT_PREFS, ...(JSON.parse(p) as Partial<NotifyPrefs>) });
      setStatus(s ?? 'Not asked yet.');
    });
    return () => { live = false; };
  }, [key]);

  const save = async (next: NotifyPrefs) => {
    setLocal(next); setProblem(undefined); setSaid(undefined);
    await Storage.setItem(key, JSON.stringify(next));
    try {
      const client = await auth.client(team);
      if (!(await kolabHasPush(client))) { setSaid('Kept on this phone. This Kolab has no push yet, so it takes effect once it has.'); return; }
      await setPrefs(client, next);
      setSaid('Saved.');
    } catch (e) { setProblem((e as Error).message); }
  };

  return (
    <Screen title="Notifications" testID="notifications">
      <Stack.Screen options={{ headerShown: true, title: team, headerBackTitle: 'You', headerStyle: { backgroundColor: colors['surface-raised'] }, headerTintColor: colors.ink }} />
      <Section title="Push on this phone">
        <Hint>{status ?? '…'}</Hint>
      </Section>
      <Section title={`What reaches you from ${team}`}>
        {LEVELS.map((l) => <Row key={l.level} testID={`level-${l.level}`} icon={prefs.level === l.level ? 'following' : 'follow'} label={l.label} onPress={() => void save({ ...prefs, level: l.level })} />)}
      </Section>
      {prefs.level !== 'none' && (
        <Section title="Muted channels">
          {channels.map((c) => {
            const muted = prefs.muted.includes(c.channel);
            return <Row key={c.channel} icon={muted ? 'capped' : 'channel'} label={c.channel} detail={muted ? 'muted' : undefined}
              onPress={() => void save({ ...prefs, muted: muted ? prefs.muted.filter((m) => m !== c.channel) : [...prefs.muted, c.channel] })} />;
          })}
        </Section>
      )}
      <Section title="Privacy">
        <Row testID="hide-preview" icon={prefs.hidePreview ? 'following' : 'follow'} label="Hide the message's words" detail={prefs.hidePreview ? 'on' : 'off'} onPress={() => void save({ ...prefs, hidePreview: !prefs.hidePreview })} />
        <Hint>Shown, a notification has the sender, the conversation and the first 100 characters, which pass through Expo&apos;s push service and Apple or Google.</Hint>
      </Section>
      {problem && <Problem>{problem}</Problem>}
      {said && <Body>{said}</Body>}
      <Button quiet label="Done" onPress={() => void save(prefs)} />
    </Screen>
  );
}
