import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar } from '@/Avatar';
import { useConversations, useMembers } from '@/kolab/hooks';
import { quoteOf } from '@/kolab/thread';
import { Hint, Problem, Row, Screen, Section } from '@/ui';
import { View } from 'react-native';

const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** DMs: every direct conversation, newest first, each with its last message and what is unread (konjir_list_conversations). */
export default function DirectMessages() {
  const auth = useAuth();
  const team = auth.current?.team;
  const me = auth.current?.actor;
  const router = useRouter();
  const conversations = useConversations(team);
  const members = useMembers(team).data?.members ?? [];
  const list = conversations.data?.conversations ?? [];
  return (
    <Screen title="DMs" testID="dms">
      {conversations.error && <Problem>{(conversations.error as Error).message}</Problem>}
      <Section title="Conversations">
        {conversations.isLoading && <Hint>Reading…</Hint>}
        {!conversations.isLoading && list.length === 0 && <Hint>No direct messages yet. Start one with the pencil on Home.</Hint>}
        {list.map((c) => {
          const m = members.find((x) => x.actor === c.with);
          const owner = m?.owner ? members.find((x) => x.actor === m.owner) : undefined;
          const unread = c.unread ? `${c.unread}${c.unread_more ? '+' : ''} unread · ` : '';
          return (
            <View key={c.with} style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 14 }}>
              {m && <Avatar member={m} owner={owner} size={32} />}
              <View style={{ flex: 1 }}>
                <Row testID={`dm-${c.with}`} icon={m?.kind === 'agent' ? 'agent' : 'person'} label={`${c.with}: ${c.last.from === me ? 'you: ' : ''}${quoteOf(c.last.message, 40)}`}
                  detail={`${unread}${when(c.last_at)}`} onPress={() => router.push({ pathname: '/c/[kind]/[name]', params: { kind: 'dm', name: c.with } })} />
              </View>
            </View>
          );
        })}
      </Section>
    </Screen>
  );
}
