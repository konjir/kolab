/** A team's data as queries, keyed `[team, …]` so a live update re-reads all of them (live.tsx). */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Member } from '@konjir/types';
import { useAuth } from '@/auth/AuthProvider';
import { kolab, type KolabApi } from './api';
import type { Msg } from './thread';

/** The API for `team`, on its shared connection. */
export function useApi() {
  const auth = useAuth();
  return async (team: string): Promise<KolabApi> => kolab(await auth.client(team));
}

export function useMe(team: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: [team, 'me'], enabled: !!team, staleTime: Infinity, queryFn: async () => (await api(team!)).whoami() });
}

export function useChannels(team: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: [team, 'channels'], enabled: !!team, queryFn: async () => (await api(team!)).channels() });
}

export function useMembers(team: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: [team, 'members'], enabled: !!team, queryFn: async () => (await api(team!)).members() });
}

/** What waits for the person: unread DMs and channel messages (the answers resource). */
export function useAnswers(team: string | undefined) {
  const api = useApi();
  const me = useMe(team);
  const uri = me.data?.subscribe.find((u) => u.startsWith('konjir://answers/'));
  return useQuery({ queryKey: [team, 'answers'], enabled: !!team && !!uri, queryFn: async () => (await api(team!)).answers(uri!) });
}

export type ConversationKind = 'channel' | 'dm';

/** A conversation's messages, newest first, a page of 50 at a time. */
export function useConversation(team: string, kind: ConversationKind, name: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [team, kind, name],
    enabled: !!team,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const k = await api(team);
      const page = kind === 'channel' ? await k.channelMessages(name, pageParam) : await k.directMessages(name, pageParam);
      return { messages: page.messages.map((m): Msg => ({ id: m.id, from: m.from, message: m.message, reply_to: m.reply_to, sent_at: m.sent_at, capped: (m as { capped?: boolean }).capped })), next: page.next ?? undefined };
    },
    getNextPageParam: (last) => last.next,
  });
}

export const isAgent = (members: Member[] | undefined, actor: string) => members?.find((m) => m.actor === actor)?.kind === 'agent';
