/**
 * Your agents (docs/plans/konnect-mobile.md, "Your agents"): a person reads what their own agents
 * say and hear, through Kolab's owner tools. Reading never marks anything read for the agent, and
 * the person's listen stream is signalled on their agents' traffic, so these queries stay live.
 *
 * - konjir_list_my_agents_status {}: { kolab, agents: AgentStatus[] }, per agent its state, what it
 *   did last, its channels with their unread, and what needs you (each a count).
 * - konjir_agent_activity {agent?, cursor?, limit?}: { items: AgentActivityItem[], next }, newest first.
 * - konjir_list_agent_conversations {agent, cursor?, limit?}: { agent, conversations, next }.
 * - konjir_list_agent_messages {agent, with, cursor?, limit?}: { agent, with, messages, next }.
 *
 * Each direct message, and each conversation row, says who else can read it (`readable_by`, an
 * agent's owner), left out when nobody does.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { AgentActivityItem, AgentStatus, Conversation, Message } from '@konjir/types';
import { callNew } from './api';

export type { AgentActivityItem, AgentStatus };
export type NeedsYou = AgentStatus['needs_you'];

export type Paged<T> = { items: T[]; next?: string };

/** One of an agent's DMs, and who else can read it. */
export type AgentMessages = Paged<Message> & { readableBy: string[] };

/** Who else can read a conversation: everyone its messages' (or rows') `readable_by` name, once each. */
export function readersOf(withReaders: readonly { readable_by?: string[] }[]): string[] {
  return [...new Set(withReaders.flatMap((m) => m.readable_by ?? []))];
}

export const agentsApi = (client: Client) => ({
  status: async (): Promise<AgentStatus[]> =>
    (await callNew<{ kolab: string; agents: AgentStatus[] }>(client, 'konjir_list_my_agents_status', {})).agents,
  activity: async (agent?: string, cursor?: string): Promise<Paged<AgentActivityItem>> => {
    const r = await callNew<{ items: AgentActivityItem[]; next?: string | null }>(client, 'konjir_agent_activity', { limit: 50, ...(agent ? { agent } : {}), ...(cursor ? { cursor } : {}) });
    return { items: r.items, next: r.next ?? undefined };
  },
  conversations: async (agent: string, cursor?: string): Promise<Paged<Conversation>> => {
    const r = await callNew<{ agent: string; conversations: Conversation[]; next?: string | null }>(client, 'konjir_list_agent_conversations', { agent, limit: 200, ...(cursor ? { cursor } : {}) });
    return { items: r.conversations, next: r.next ?? undefined };
  },
  messages: async (agent: string, other: string, cursor?: string): Promise<AgentMessages> => {
    const r = await callNew<{ agent: string; with: string; messages: Message[]; next?: string | null }>(client, 'konjir_list_agent_messages', { agent, with: other, limit: 50, ...(cursor ? { cursor } : {}) });
    return { items: r.messages, next: r.next ?? undefined, readableBy: readersOf(r.messages) };
  },
});
export type AgentsApi = ReturnType<typeof agentsApi>;
