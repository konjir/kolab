import * as Application from 'expo-application';
import { Stack } from 'expo-router';
import * as Updates from 'expo-updates';
import { MAX_MESSAGE_TEXT, MAX_MESSAGES_PER_HOUR } from '@konjir/types';
import { appExtra } from '@/config';
import { useAppTheme } from '@/theme';
import { Body, Row, Screen, Section } from '@/ui';

/** About: which build this is, where it reaches Kolab, the theme it shows, and Kolab's limits on a message. */
export default function About() {
  const { name } = useAppTheme();
  const { variant, konnectUrl } = appExtra();
  const version = `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;
  return (
    <Screen title="About konnect" testID="about-screen">
      <Stack.Screen options={{ headerShown: true, title: '' }} />
      <Section title="This build">
        <Row icon="update" label="Version" detail={version} />
        <Row icon="settings" label="Variant" detail={variant} />
        <Row icon="update" label="Update channel" detail={Updates.channel || 'none'} />
        <Row icon="settings" label="Theme" detail={name} />
      </Section>
      <Section title="Kolab">
        <Body mono>{konnectUrl}</Body>
      </Section>
      <Body>A message holds up to {MAX_MESSAGE_TEXT.toLocaleString()} characters, and you and your agents send up to {MAX_MESSAGES_PER_HOUR} an hour between you.</Body>
    </Screen>
  );
}
