import * as Application from 'expo-application';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { useState } from 'react';
import { MAX_MESSAGE_TEXT, MAX_MESSAGES_PER_HOUR } from '@konjir/types';
import { useAuth } from '@/auth/AuthProvider';
import { appExtra } from '@/config';
import { useAppTheme } from '@/theme';
import { Body, Button, Hint, Problem, Row, Screen, Section } from '@/ui';

/** You: the GitHub account signed in, the team shown, its settings and notifications, this build, and signing this phone out. */
export default function You() {
  const auth = useAuth();
  const router = useRouter();
  const { name } = useAppTheme();
  const { variant, konnectUrl } = appExtra();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const version = `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;
  const me = auth.current;

  const signOut = async () => {
    setBusy(true); setProblem(undefined);
    try {
      const { revoked } = await auth.signOut();
      if (!revoked) setProblem('Signed out on this phone, but Kolab couldn\'t be reached to end the sign-in; it lapses after 30 days unused.');
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Screen title="You" testID="you">
      <Section title="Signed in">
        {me ? <Row testID="account" icon="person" label={me.actor} detail="GitHub" /> : <Hint>Not signed in.</Hint>}
        {me && <Row testID="current-team" icon="team" label={me.team} detail={me.role} />}
        {me && <Row testID="team-settings" icon="settings" label={`${me.team} settings`} detail="invite, remove, leave" onPress={() => router.push('/team')} />}
      </Section>
      {me && <Button testID="sign-out" quiet label="Sign out" busy={busy} onPress={() => void signOut()} />}
      {problem && <Problem>{problem}</Problem>}
      <Section title="Notifications">
        {me ? <Row testID="notification-settings" icon="notifications" label={`What notifies you from ${me.team}`} onPress={() => router.push('/notifications')} /> : <Hint>Sign in first.</Hint>}
      </Section>
      <Section title="This app">
        <Row icon="update" label="Version" detail={version} />
        <Row icon="settings" label="Variant" detail={variant} />
        <Row icon="update" label="Update channel" detail={Updates.channel || 'none'} />
        <Row icon="settings" label="Theme" detail={name} />
      </Section>
      <Body mono>{konnectUrl}</Body>
      <Body>A message holds up to {MAX_MESSAGE_TEXT.toLocaleString()} characters, and you and your agents send up to {MAX_MESSAGES_PER_HOUR} an hour between you.</Body>
    </Screen>
  );
}
