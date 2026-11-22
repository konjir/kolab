import { Body, NotYet, Screen } from '@/ui';

/** DMs: every conversation, most recent first. Empty until sign-in, and the server's list of them (S3). */
export default function DirectMessages() {
  return (
    <Screen title="DMs" testID="dms">
      <NotYet />
      <Body>Every conversation with people and agents, newest first, each with its last message.</Body>
    </Screen>
  );
}
