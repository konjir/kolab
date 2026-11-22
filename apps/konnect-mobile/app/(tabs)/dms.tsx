import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthProvider';
import { useAnswers, useMembers } from '@/kolab/hooks';
import { handleOf } from '@/kolab/names';
import { quoteOf } from '@/kolab/thread';
import { unreadOf } from '@/kolab/unread';
import { Hint, Problem, Row, Screen, Section } from '@/ui';

/**
 * DMs: every person and agent to talk with, the ones with unread messages first, each with the
 * first unread message. Once Kolab lists conversations (S3, konjir_list_conversations), each row
 * gets its last message and the list its recency.
 */
export default function DirectMessages() {
  const auth = useAuth();
  const team = auth.current?.team;
  const router = useRouter();
  const members = useMembers(team);
  const answers = useAnswers(team);
  const unread = unreadOf(answers.data);
  const first = new Map<string, string>();
  for (const m of answers.data?.messages?.items ?? []) if (!first.has(m.from)) first.set(m.from, m.message);
  const others = (members.data?.members ?? []).filter((m) => m.actor !== auth.current?.actor)
    .sort((a, b) => (unread.dms.get(b.actor)?.count ?? 0) - (unread.dms.get(a.actor)?.count ?? 0) || a.actor.localeCompare(b.actor));
  return (
    <Screen title="DMs" testID="dms">
      {members.error && <Problem>{(members.error as Error).message}</Problem>}
      <Section title="Conversations">
        {members.isLoading && <Hint>Reading…</Hint>}
        {!members.isLoading && others.length === 0 && <Hint>Nobody else is in this team yet.</Hint>}
        {others.map((m) => {
          const u = unread.dms.get(m.actor);
          return (
            <Row key={m.actor} testID={`dm-${m.actor}`} icon={m.kind === 'agent' ? 'agent' : 'person'} label={u ? `${handleOf(m)}: ${quoteOf(first.get(m.actor) ?? '', 40)}` : handleOf(m)}
              detail={u ? `${u.count} unread` : undefined} onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: m.actor } })} />
          );
        })}
      </Section>
    </Screen>
  );
}
