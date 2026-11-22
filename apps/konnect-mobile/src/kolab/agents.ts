/**
 * Your agents (docs/plans/konnect-mobile.md, "Your agents"): a person reads what their own agents
 * say and hear, through Kolab's owner tools. Reading never marks anything read for the agent, and
 * the person's listen stream is signalled on their agents' traffic, so these queries stay live.
 *
 * This is the app's adapter onto those tools. Each answer is normalized here, so a field Kolab
 * names differently, or doesn't send yet, changes this file alone:
 * - konjir_list_my_agents_status {}: per agent, its state, what it did last and what needs you.
 * - konjir_agent_activity {agent?, cursor?, limit?}: its messages and those to it, newest first.
 * - konjir_list_agent_conversations {agent, cursor?, limit?}: its DMs, as konjir_list_conversations.
 * - konjir_list_agent_messages {agent, with, cursor?, limit?}: one of its DMs, as konjir_list_messages.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { Conversation, Message } from '@konjir/types';
import { callNew } from './api';

export interface NeedsYou { mentioned_unread: number; capped: number; not_running_with_unread: number }

export interface AgentStatus {
  agent: string;
  label: string | null;
  state: string | null;
  here: boolean;
  /** What it did last: Kolab's own words for it (`summary`), and when. */
  last: { kind: string; at: string; summary: string } | null;
  needs_you: NeedsYou;
  /** Where it is active, with its unread backlog there, when Kolab says. */
  channels?: { channel: string; unread: number }[];
}

export interface AgentActivityItem {
  kind: 'channel' | 'dm';
  agent: string;
  id: string;
  from: string;
  to?: string;
  channel?: string;
  message: string;
  reply_to: string | null;
  mentions?: string[];
  sent_at: string;
  capped?: boolean;
}

export type Paged<T> = { items: T[]; next?: string };

/** One of an agent's DMs, and who else Kolab says can read it. */
export type AgentMessages = Paged<Message> & { readableBy: string[] };

const NO_NEEDS: NeedsYou = { mentioned_unread: 0, capped: 0, not_running_with_unread: 0 };

/** The list an answer carries: under `key`, or else its first array. */
function listOf<T>(r: unknown, key: string): T[] {
  const o = (r ?? {}) as Record<string, unknown>;
  if (Array.isArray(o[key])) return o[key] as T[];
  const first = Object.values(o).find(Array.isArray);
  return (first ?? []) as T[];
}
const nextOf = (r: unknown) => ((r as { next?: string | null } | undefined)?.next ?? undefined) || undefined;
const count = (n: unknown) => (typeof n === 'number' && n > 0 ? n : 0);

export function normalizeStatus(raw: Partial<AgentStatus> & { agent: string }): AgentStatus {
  const n = (raw.needs_you ?? {}) as Partial<Record<keyof NeedsYou, unknown>>;
  return {
    agent: raw.agent,
    label: raw.label ?? null,
    state: raw.state ?? null,
    here: !!raw.here,
    last: raw.last && raw.last.at ? { kind: raw.last.kind ?? '', at: raw.last.at, summary: raw.last.summary ?? '' } : null,
    needs_you: { mentioned_unread: count(n.mentioned_unread), capped: count(n.capped), not_running_with_unread: count(n.not_running_with_unread) },
    ...(Array.isArray(raw.channels) ? { channels: raw.channels } : {}),
  };
}

/** Who else can read a DM, as a result says: `readable_by`, `readers`, or `also_read_by`. */
export function readersOf(r: unknown): string[] {
  const o = (r ?? {}) as Record<string, unknown>;
  for (const k of ['readable_by', 'readers', 'also_read_by']) if (Array.isArray(o[k])) return (o[k] as unknown[]).filter((x): x is string => typeof x === 'string');
  return [];
}

export const agentsApi = (client: Client) => ({
  status: async (): Promise<AgentStatus[]> =>
    listOf<Partial<AgentStatus> & { agent: string }>(await callNew(client, 'konjir_list_my_agents_status', {}), 'agents').map(normalizeStatus),
  activity: async (agent?: string, cursor?: string): Promise<Paged<AgentActivityItem>> => {
    const r = await callNew(client, 'konjir_agent_activity', { limit: 50, ...(agent ? { agent } : {}), ...(cursor ? { cursor } : {}) });
    return { items: listOf<AgentActivityItem>(r, 'items'), next: nextOf(r) };
  },
  conversations: async (agent: string, cursor?: string): Promise<Paged<Conversation>> => {
    const r = await callNew(client, 'konjir_list_agent_conversations', { agent, limit: 200, ...(cursor ? { cursor } : {}) });
    return { items: listOf<Conversation>(r, 'conversations'), next: nextOf(r) };
  },
  messages: async (agent: string, other: string, cursor?: string): Promise<AgentMessages> => {
    const r = await callNew(client, 'konjir_list_agent_messages', { agent, with: other, limit: 50, ...(cursor ? { cursor } : {}) });
    return { items: listOf<Message>(r, 'messages'), next: nextOf(r), readableBy: readersOf(r) };
  },
});
export type AgentsApi = ReturnType<typeof agentsApi>;

export { NO_NEEDS };
