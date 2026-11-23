/**
 * What is unread, from the answers resource (konjir://answers/<team>/<actor>): per DM partner and
 * per channel, the Activity tab's items, and how far a conversation is read once messages scroll
 * into view.
 */
import type { Answers, AnswerChannelItem, AnswerMessage } from './api';
import { isGone } from './names';

export interface Unread { count: number; mentions: number }

/** Unread counts per DM partner (from the first unread messages Kolab lists) and per channel. */
export function unreadOf(a: Answers | undefined): { dms: Map<string, Unread>; channels: Map<string, Unread>; total: number } {
  const dms = new Map<string, Unread>();
  for (const m of a?.messages?.items ?? []) {
    const u = dms.get(m.from) ?? { count: 0, mentions: 0 };
    // A direct message is for you alone: each counts as a mention, as Slack badges DMs.
    dms.set(m.from, { count: u.count + 1, mentions: u.mentions + 1 });
  }
  const channels = new Map<string, Unread>();
  for (const c of a?.channels ?? []) {
    const count = c.unread ?? c.items?.length ?? 0;
    if (count > 0) channels.set(c.channel, { count, mentions: (c.items ?? []).filter((i) => i.mentions_you).length });
  }
  const total = (a?.messages?.unread ?? a?.messages?.items?.length ?? 0) + [...channels.values()].reduce((s, u) => s + u.count, 0);
  return { dms, channels, total };
}

/**
 * Where an Activity row opens: a channel message's channel, or a direct message's conversation;
 * nothing for a direct message from a deleted account, with no one to write back to.
 */
export const opensTo = (item: AnswerMessage | AnswerChannelItem): { kind: 'channel' | 'dm'; name: string } | undefined =>
  ('channel' in item ? { kind: 'channel', name: item.channel } : isGone(item.from, item.from_deleted) ? undefined : { kind: 'dm', name: item.from });

export type ActivityItem =
  | { kind: 'mention'; item: AnswerChannelItem }
  | { kind: 'reply'; item: AnswerMessage | AnswerChannelItem }
  | { kind: 'capped'; item: AnswerChannelItem };

/**
 * The Activity tab: mentions of you in channels, replies to you (a message answering one of
 * `mine`, the ids of messages you sent), and channel messages past an agent's cap, which woke no one.
 * Newest first, by id.
 */
export function activityOf(a: Answers | undefined, mine: ReadonlySet<string> = new Set()): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const c of a?.channels ?? []) {
    for (const i of c.items ?? []) {
      if (i.reply_to && mine.has(i.reply_to)) out.push({ kind: 'reply', item: i });
      else if (i.mentions_you) out.push({ kind: 'mention', item: i });
      else if (i.capped) out.push({ kind: 'capped', item: i });
    }
  }
  for (const m of a?.messages?.items ?? []) if (m.reply_to && mine.has(m.reply_to)) out.push({ kind: 'reply', item: m });
  return out.sort((x, y) => (x.item.id < y.item.id ? 1 : x.item.id > y.item.id ? -1 : 0));
}

/**
 * How many of a conversation's unread messages (oldest first) are now read, given the ids on
 * screen: everything up to the newest unread one seen. Kolab marks read oldest first, so this is
 * how many to consume.
 */
export function readThrough(unreadOldestFirst: readonly string[], visible: Iterable<string>): number {
  const seen = new Set(visible);
  let through = 0;
  unreadOldestFirst.forEach((id, i) => { if (seen.has(id)) through = i + 1; });
  return through;
}
