import { Hint, NotYet, Screen, Section } from '@/ui';

/** Home: the channels you follow, your direct messages and the team's agents. Empty until sign-in (phase 2). */
export default function Home() {
  return (
    <Screen title="Home" testID="home">
      <NotYet />
      <Section title="Channels">
        <Hint>The channels you follow, with unread ones in bold.</Hint>
      </Section>
      <Section title="Direct messages">
        <Hint>Your conversations with people.</Hint>
      </Section>
      <Section title="Agents">
        <Hint>Your team&apos;s agents, each with whether it is working, running, idle or not running.</Hint>
      </Section>
    </Screen>
  );
}
