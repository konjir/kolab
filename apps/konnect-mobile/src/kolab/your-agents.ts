/**
 * What the app shows of a person's own agents: Home's line and "needs you" badge, where each of
 * an agent's messages was, the Activity tab's "Your agents" filter, a channel's "Only @you/bot"
 * filter, and the line in a DM with an agent that says its owner can read it. Pure, so tested.
 */
import type { Member } from '@konjir/types';
import type { AgentActivityItem, AgentStatus, NeedsYou } from './agents';
import { handleOf } from './names';

type Named = Pick<Member, 'actor' | 'owner' | 'label'>;

/** `@handle` for an actor: an agent as `@owner/label` when the members list knows it. */
export function at(actor: string, members: readonly Named[] | undefined): string {
  const m = members?.find((x) => x.actor === actor);
  return `@${m ? handleOf(m) : actor}`;
}

/** The person's own agents among the members. */
export const ownAgents = <M extends Pick<Member, 'kind' | 'owner'>>(members: readonly M[] | undefined, me: string): M[] =>
  (members ?? []).filter((m) => m.kind === 'agent' && !!me && m.owner === me);

/** How long ago `iso` was, as Home says it: now, 5m, 3h, 2d. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Home's line for one of your agents: what it did last, and when ("replied to @bo in #general · 2m"). */
export function lastLine(status: Pick<AgentStatus, 'last' | 'state'> | undefined, now = Date.now()): string | undefined {
  if (!status?.last) return undefined;
  const when = ago(status.last.at, now);
  return [status.last.summary.trim(), when].filter(Boolean).join(' · ') || undefined;
}

/** How many things wait on you for an agent. */
export const needsYouCount = (n: NeedsYou | undefined) => (n ? n.mentioned_unread + n.capped + n.not_running_with_unread : 0);

/** What needs you, said in words, for the agent screen and the Activity tab. */
export function needsYouWords(n: NeedsYou | undefined): string[] {
  if (!n) return [];
  const out: string[] = [];
  if (n.mentioned_unread) out.push(`${n.mentioned_unread} unread ${n.mentioned_unread === 1 ? 'mention' : 'mentions'}`);
  if (n.capped) out.push(`${n.capped} capped`);
  if (n.not_running_with_unread) out.push(`not running, ${n.not_running_with_unread} unread`);
  return out;
}

/** The other side of one of the agent's DMs. */
export const otherOf = (item: Pick<AgentActivityItem, 'from' | 'to'>, agent: string) => (item.from === agent ? item.to ?? '' : item.from);

/** Where an activity row was: `#general`, or `DM with @bo`. */
export function whereOf(item: AgentActivityItem, members?: readonly Named[]): string {
  if (item.kind === 'channel') return `#${item.channel ?? ''}`;
  return `DM with ${at(otherOf(item, item.agent), members)}`;
}

/** Where tapping an activity row goes: the channel, or the agent's DM, read-only. */
export function contextOf(item: AgentActivityItem): { kind: 'channel' | 'dm'; name: string; as?: string } {
  if (item.kind === 'channel') return { kind: 'channel', name: item.channel ?? '' };
  return { kind: 'dm', name: otherOf(item, item.agent), as: item.agent };
}

/** The channels an agent is active in: Kolab's list with its backlog when it sends one, else those its activity names. */
export function agentChannels(status: Pick<AgentStatus, 'channels'> | undefined, items: readonly AgentActivityItem[]): { channel: string; unread?: number; last?: string }[] {
  if (status?.channels) return [...status.channels].sort((a, b) => b.unread - a.unread || a.channel.localeCompare(b.channel));
  const seen = new Map<string, string>();
  for (const i of items) if (i.kind === 'channel' && i.channel && !seen.has(i.channel)) seen.set(i.channel, i.sent_at);
  return [...seen].map(([channel, last]) => ({ channel, last }));
}

export type YourAgentsRow =
  | { kind: 'dm' | 'mention' | 'capped'; agent: string; item: AgentActivityItem }
  | { kind: 'stuck'; agent: string; unread: number };

/**
 * The Activity tab's "Your agents": DMs to your agents, channel messages that mention them, capped
 * ones, newest first; and first, each agent that isn't running with messages waiting for it.
 */
export function yourAgentsActivity(items: readonly AgentActivityItem[], statuses: readonly AgentStatus[], members?: readonly Named[]): YourAgentsRow[] {
  const mine = new Set(statuses.map((s) => s.agent));
  const handles = new Map(statuses.map((s) => [s.agent, at(s.agent, members).slice(1)]));
  const rows: YourAgentsRow[] = [];
  for (const i of items) {
    if (!mine.has(i.agent) || i.from === i.agent) continue;
    if (i.capped) rows.push({ kind: 'capped', agent: i.agent, item: i });
    else if (i.kind === 'dm') rows.push({ kind: 'dm', agent: i.agent, item: i });
    else if (i.mentions?.some((m) => m === i.agent || m === handles.get(i.agent))) rows.push({ kind: 'mention', agent: i.agent, item: i });
  }
  rows.sort((a, b) => ('item' in b ? b.item.sent_at : '').localeCompare('item' in a ? a.item.sent_at : ''));
  const stuck: YourAgentsRow[] = statuses.filter((s) => s.needs_you.not_running_with_unread > 0)
    .map((s) => ({ kind: 'stuck', agent: s.agent, unread: s.needs_you.not_running_with_unread }));
  return [...stuck, ...rows];
}

/** A channel's "Only @you/bot": the messages your agent sent there, or that mention it. */
export function onlyAgent<M extends { from: string; message: string; mentions?: string[] | null }>(messages: readonly M[], agent: Named): M[] {
  const handle = handleOf(agent);
  return messages.filter((m) => m.from === agent.actor || (m.mentions ?? []).some((x) => x === handle || x === agent.actor));
}

/** Your agents that have spoken in what is loaded of a channel: the ones its filter can show. */
export function agentsIn<A extends Named>(messages: readonly { from: string }[], mine: readonly A[]): A[] {
  const from = new Set(messages.map((m) => m.from));
  return mine.filter((a) => from.has(a.actor));
}

/**
 * The permanent line under a DM's header with an agent: who, besides the two of you, can read it.
 * From Kolab's fields alone: the agent's `owner_reads`, and the readers a DM's result names. Not
 * said to the owner, who is the one reading.
 */
export function disclosureOf(agent: (Named & { kind?: string; owner_reads?: boolean }) | undefined, me: string, readableBy: readonly string[] = []): string | undefined {
  if (!agent || agent.kind !== 'agent') return undefined;
  const readers = new Set(readableBy);
  if (agent.owner_reads && agent.owner) readers.add(agent.owner);
  readers.delete(me);
  readers.delete(agent.actor);
  if (readers.size === 0) return undefined;
  const names = [...readers];
  if (names.length === 1 && names[0] === agent.owner) return `@${agent.owner}, its owner, can read this conversation`;
  return `${names.map((n) => `@${n}`).join(', ')} can read this conversation`;
}

/** The banner over one of your agent's DMs. */
export const readOnlyBanner = (agentHandle: string, otherHandle: string) => `${agentHandle}'s conversation with ${otherHandle} · read-only`;

/** When an agent's messages notify you: never, when it is stuck or capped (the default), or every message to it. */
export type AgentNotify = 'never' | 'stuck' | 'all';
export const AGENT_NOTIFY_DEFAULT: AgentNotify = 'stuck';
export const AGENT_NOTIFY: { level: AgentNotify; label: string }[] = [
  { level: 'never', label: 'Never' },
  { level: 'stuck', label: 'When it is stuck or capped' },
  { level: 'all', label: 'Every message to it' },
];
export const agentNotifyKey = (team: string) => `konnect.agent-notify.${team}`;

/** Each agent's setting, from what the phone kept: anything unknown is the default. */
export function agentNotifyOf(kept: string | null | undefined, agent: string): AgentNotify {
  try {
    const v = (JSON.parse(kept ?? '{}') as Record<string, unknown>)[agent];
    return v === 'never' || v === 'stuck' || v === 'all' ? v : AGENT_NOTIFY_DEFAULT;
  } catch { return AGENT_NOTIFY_DEFAULT; }
}

/** What the phone keeps after setting `agent`: only those not at the default. */
export function withAgentNotify(kept: string | null | undefined, agent: string, level: AgentNotify): string {
  let all: Record<string, unknown> = {};
  try { all = JSON.parse(kept ?? '{}') as Record<string, unknown>; } catch { /* a fresh start */ }
  if (level === AGENT_NOTIFY_DEFAULT) delete all[agent]; else all[agent] = level;
  return JSON.stringify(all);
}
