/**
 * What Home lists, each thing once: the channels you follow, your direct messages (with people and
 * with others' agents), and your own agents. With Unreads on (You, a setting of this phone), what is
 * unread moves up into Unreads, out of its own section, as Slack's Unreads section does. Your own
 * agents always keep their row, for their state; their DM's unread moves with the rest.
 */
import type { AgentStatus, Conversation, Member } from '@konjir/types';
import { displayName, handleOf } from './names';
import type { Unread } from './unread';

export interface HomeChannel { kind: 'channel'; name: string; unread?: Unread }
export interface HomeDm { kind: 'dm'; with: string; member?: Member; unread?: Unread; last_at?: string }
export interface HomeAgent { kind: 'agent'; member: Member; status?: AgentStatus; unread?: Unread }
export type HomeUnread = HomeChannel | HomeDm;

export interface HomeInput {
  me: string;
  /** Every channel of the team, with whether you follow it. */
  channels: readonly { channel: string; following: boolean }[];
  members: readonly Member[];
  /** Each DM, with its own unread count: Kolab's answers list only the first unread messages, across everyone. */
  conversations: readonly (Pick<Conversation, 'with' | 'last_at'> & Partial<Pick<Conversation, 'unread'>>)[];
  unread: { dms: ReadonlyMap<string, Unread>; channels: ReadonlyMap<string, Unread> };
  statuses?: readonly AgentStatus[] | null;
  /** What "Jump to…" holds: only what matches it is listed. */
  query?: string;
  showUnreads: boolean;
}

export interface HomeModel { unreads: HomeUnread[]; channels: HomeChannel[]; dms: HomeDm[]; agents: HomeAgent[] }

export function homeOf(i: HomeInput): HomeModel {
  const q = (i.query ?? '').trim().toLowerCase().replace(/^[@#]/, '');
  const match = (...names: string[]) => !q || names.some((n) => n.toLowerCase().includes(q));
  const byActor = new Map(i.members.map((m) => [m.actor, m]));
  const mine = (actor: string) => { const m = byActor.get(actor); return m?.kind === 'agent' && m.owner === i.me; };
  const has = (u: Unread | undefined) => !!u?.count;
  // A DM's unread: its conversation's count, which is whole, else what the answers list (a DM is for you alone, so all of it counts as a mention).
  const counted = new Map(i.conversations.filter((c) => c.unread).map((c) => [c.with, { count: c.unread!, mentions: c.unread! }]));
  const dmUnread = (p: string): Unread | undefined => counted.get(p) ?? i.unread.dms.get(p);

  const followed: HomeChannel[] = i.channels.filter((c) => c.following && match(c.channel)).map((c) => ({ kind: 'channel', name: c.channel, unread: i.unread.channels.get(c.channel) }));
  // A channel unread though not followed (a mention there) still shows, so nothing unread hides.
  const elsewhere: HomeChannel[] = [...i.unread.channels].filter(([c]) => !i.channels.some((x) => x.channel === c && x.following) && match(c)).map(([c, u]) => ({ kind: 'channel', name: c, unread: u }));

  // Every DM, newest first; one Kolab hasn't listed yet but which has unread comes first.
  const listed = new Set(i.conversations.map((c) => c.with));
  const dmsAll: HomeDm[] = [
    ...[...i.unread.dms.keys()].filter((p) => !listed.has(p)).map((p) => ({ kind: 'dm' as const, with: p, member: byActor.get(p), unread: dmUnread(p) })),
    ...i.conversations.map((c) => ({ kind: 'dm' as const, with: c.with, member: byActor.get(c.with), unread: dmUnread(c.with), last_at: c.last_at })),
  ].filter((d) => d.with !== i.me && match(d.with, displayName(d.with, i.members), d.member ? handleOf(d.member) : ''));

  const agents: HomeAgent[] = i.members.filter((m) => m.kind === 'agent' && m.owner === i.me && match(m.actor, handleOf(m)))
    .map((m) => ({ kind: 'agent', member: m, status: i.statuses?.find((s) => s.agent === m.actor), unread: dmUnread(m.actor) }));

  if (!i.showUnreads) {
    return {
      unreads: [],
      channels: [...followed, ...elsewhere],
      // Your own agents' DMs are on their rows, under Your agents.
      dms: dmsAll.filter((d) => !mine(d.with)),
      agents,
    };
  }
  const unreads: HomeUnread[] = [...followed.filter((c) => has(c.unread)), ...elsewhere, ...dmsAll.filter((d) => has(d.unread))];
  return {
    unreads,
    channels: followed.filter((c) => !has(c.unread)),
    dms: dmsAll.filter((d) => !has(d.unread) && !mine(d.with)),
    agents: agents.map((a) => ({ ...a, unread: undefined })),
  };
}
