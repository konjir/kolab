import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { MAX_MESSAGE_TEXT, MAX_MESSAGES_PER_HOUR } from '@konjir/types';
import { appExtra } from '@/config';
import { useAppTheme } from '@/theme';
import { Body, Hint, NotYet, Row, Screen, Section } from '@/ui';

/** You: your teams and sign-ins and notification settings (not yet), and this build, which is real. */
export default function You() {
  const { name } = useAppTheme();
  const { variant, konnectUrl } = appExtra();
  const version = `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;
  return (
    <Screen title="You" testID="you">
      <NotYet />
      <Section title="Teams and notifications">
        <Hint>Your teams and their sign-ins, and which messages notify you. Neither exists yet.</Hint>
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
