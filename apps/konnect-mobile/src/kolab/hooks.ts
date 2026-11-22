/** A team's data as queries, keyed `[team, …]` so a live update re-reads all of them (live.tsx). */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Member } from '@konjir/types';
import { useAuth } from '@/auth/AuthProvider';
import { kolab, KolabLacks, type KolabApi } from './api';
import { agentsApi, readersOf, type AgentsApi } from './agents';
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

/** The person's direct conversations, newest first (S3). */
export function useConversations(team: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: [team, 'conversations'], enabled: !!team, queryFn: async () => (await api(team!)).conversations() });
}

export type ConversationKind = 'channel' | 'dm';

/** A conversation's messages, newest first, a page of 50 at a time. */
export function useConversation(team: string, kind: ConversationKind, name: string, enabled = true) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [team, kind, name],
    enabled: !!team && enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const k = await api(team);
      const page = kind === 'channel' ? await k.channelMessages(name, pageParam) : await k.directMessages(name, pageParam);
      return { messages: page.messages.map(toMsg), next: page.next ?? undefined, readableBy: readersOf(page.messages as { readable_by?: string[] }[]) };
    },
    getNextPageParam: (last) => last.next,
  });
}

export const isAgent = (members: Member[] | undefined, actor: string) => members?.find((m) => m.actor === actor)?.kind === 'agent';

const toMsg = (m: { id: string; from: string; message: string; reply_to: string | null; sent_at: string; mentions?: string[] }): Msg =>
  ({ id: m.id, from: m.from, message: m.message, reply_to: m.reply_to, sent_at: m.sent_at, capped: (m as { capped?: boolean }).capped, ...(m.mentions ? { mentions: m.mentions } : {}) });

/** The owner tools for `team` (agents.ts), on its shared connection. */
export function useAgentsApi() {
  const auth = useAuth();
  return async (team: string): Promise<AgentsApi> => agentsApi(await auth.client(team));
}

/** null from a Kolab without the owner tools: the app shows its agents' state alone. */
const orLacking = async <T,>(f: () => Promise<T>): Promise<T | null> => {
  try { return await f(); } catch (e) { if (e instanceof KolabLacks) return null; throw e; }
};

/** Each of the person's own agents: its state, what it did last, and what needs them. */
export function useAgentStatus(team: string | undefined) {
  const api = useAgentsApi();
  return useQuery({ queryKey: [team, 'agents', 'status'], enabled: !!team, queryFn: () => orLacking(async () => (await api(team!)).status()) });
}

/** An agent's messages and those to it (or all your agents', with no `agent`), newest first. */
export function useAgentActivity(team: string | undefined, agent?: string, enabled = true) {
  const api = useAgentsApi();
  return useInfiniteQuery({
    queryKey: [team, 'agents', 'activity', agent ?? '*'],
    enabled: !!team && enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => (await orLacking(async () => (await api(team!)).activity(agent, pageParam))) ?? { items: [], next: undefined, lacking: true },
    getNextPageParam: (last) => last.next,
  });
}

/** An agent's DMs, newest first. */
export function useAgentConversations(team: string | undefined, agent: string, enabled = true) {
  const api = useAgentsApi();
  return useQuery({ queryKey: [team, 'agents', 'conversations', agent], enabled: !!team && !!agent && enabled, queryFn: () => orLacking(async () => (await api(team!)).conversations(agent)) });
}

/** One of an agent's DMs, read as its owner: newest first, 50 at a time. Reading it marks nothing read. */
export function useAgentConversation(team: string, agent: string | undefined, other: string) {
  const api = useAgentsApi();
  return useInfiniteQuery({
    queryKey: [team, 'agents', 'dm', agent ?? '', other],
    enabled: !!team && !!agent,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await (await api(team)).messages(agent!, other, pageParam);
      return { messages: page.items.map(toMsg), next: page.next, readableBy: page.readableBy };
    },
    getNextPageParam: (last) => last.next,
  });
}
