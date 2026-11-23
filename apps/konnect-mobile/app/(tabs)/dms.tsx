import { useRouter } from 'expo-router';
import { DELETED_ACCOUNT } from '@konjir/types';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar, presenceOf } from '@/Avatar';
import { Icon } from '@/icons';
import { useConversations, useMembers } from '@/kolab/hooks';
import { displayName, partnerDeleted } from '@/kolab/names';
import { quoteOf } from '@/kolab/thread';
import { conversationHref, shortWhen } from '@/routes';
import { useAppTheme } from '@/theme';
import { Hint, ListRow, Problem, Screen, Section } from '@/ui';

/**
 * DMs: every direct conversation, with people and agents, newest first (konjir_list_conversations),
 * Slack's way: their picture, their name, bold while something is unread, the last thing said, when,
 * and a badge for what is unread.
 */
export default function DirectMessages() {
  const auth = useAuth();
  const team = auth.current?.team;
  const me = auth.current?.actor;
  const router = useRouter();
  const { colors } = useAppTheme();
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
          const name = partnerDeleted(c) ? DELETED_ACCOUNT : displayName(c.with, members);
          return (
            <ListRow key={c.with} testID={`dm-${c.with}`}
              leading={m ? <Avatar member={m} owner={owner} size={40} presence={m.kind === 'agent' ? presenceOf(m.state) : m.here ? 'here' : undefined} /> : <Icon name="person" size={24} tintColor={colors['ink-muted']} />}
              title={name} unread={c.unread > 0} badge={c.unread} badgeMore={c.unread_more}
              subtitle={`${c.last.from === me ? 'You: ' : ''}${quoteOf(c.last.message, 80)}`} time={shortWhen(c.last_at)}
              accessibilityLabel={`${name}${c.unread ? `, ${c.unread}${c.unread_more ? '+' : ''} unread` : ''}`}
              onPress={() => router.push(conversationHref('dm', c.with))} />
          );
        })}
      </Section>
    </Screen>
  );
}
