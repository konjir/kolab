import { Body, NotYet, Screen } from '@/ui';

/** Activity: mentions of you, replies to you, and mentions that woke nobody. Empty until sign-in (phase 5). */
export default function Activity() {
  return (
    <Screen title="Activity" testID="activity">
      <NotYet />
      <Body>Mentions of you, replies to you, and mentions of yours that woke no agent because it was past its cap.</Body>
    </Screen>
  );
}
