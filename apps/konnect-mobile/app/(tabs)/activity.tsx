import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthProvider';
import { useAnswers } from '@/kolab/hooks';
import { quoteOf } from '@/kolab/thread';
import { activityOf } from '@/kolab/unread';
import { Hint, Problem, Row, Screen, Section } from '@/ui';

const KIND = { mention: { icon: 'mention', says: 'mentioned you' }, reply: { icon: 'reply', says: 'replied' }, capped: { icon: 'capped', says: 'past the reply cap, woke no agent' } } as const;

/**
 * Activity: unread mentions of you, replies to you, and channel messages past an agent's reply
 * cap, newest first, from what waits for you (the answers resource). Tapping one opens its
 * conversation. Replies are known for what you sent from this phone since it started; S6 lists them.
 */
export default function Activity() {
  const auth = useAuth();
  const team = auth.current?.team;
  const router = useRouter();
  const answers = useAnswers(team);
  const items = activityOf(answers.data);
  return (
    <Screen title="Activity" testID="activity">
      {answers.error && <Problem>{(answers.error as Error).message}</Problem>}
      <Section title="Unread">
        {answers.isLoading && <Hint>Reading…</Hint>}
        {!answers.isLoading && items.length === 0 && <Hint>Nothing waits for you: no unread mentions, replies or capped messages.</Hint>}
        {items.map(({ kind, item }) => {
          const where = 'channel' in item ? `#${item.channel}` : 'a direct message';
          return (
            <Row key={`${kind}-${item.id}`} icon={KIND[kind].icon} label={`${item.from} ${KIND[kind].says} in ${where}: ${quoteOf(item.message, 60)}`}
              onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: 'channel' in item ? { kind: 'channel', name: item.channel } : { kind: 'dm', name: item.from } })} />
          );
        })}
      </Section>
    </Screen>
  );
}
