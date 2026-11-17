/**
 * What konnect does with a team's messages, shared by the commands (konnect.ts) and the tools an
 * agent gets (`konnect mcp`, mcp.ts): where a message goes, sending it with its mentions, and
 * reading what is unread. Each is a few TeamClient calls; neither side formats anything here.
 */
import type { TeamClient } from './client.js';
import { channelName, mentionsIn, storedName, type Channel, type ChannelMessage, type Member, type Message } from './names.js';

/** Where a message goes, or what to read: a channel (`#deploys`, or a bare name) or a member (`@ann`, `@ann/reviewer`). */
export type Target = { kind: 'channel'; channel: string } | { kind: 'direct'; to: string; given: string };

/** A word as a target: `@…` names a member, anything else a channel (its `#` optional). */
export function targetOf(word: string): Target {
  if (word.startsWith('@')) return { kind: 'direct', to: storedName(word), given: word };
  return { kind: 'channel', channel: channelName(word) };
}

/** What was sent: to a member, or to a channel with the members it mentions. */
export type Sent = { kind: 'direct'; sent: Message } | { kind: 'channel'; sent: ChannelMessage; members: Member[] };

/**
 * Sends `message` to `target`. A channel message mentions each member its words name (`@ann`,
 * `@ann/reviewer`), looked up in the team's members first; other `@words` stay plain words.
 */
export async function send(client: TeamClient, target: Target, message: string, replyTo?: string): Promise<Sent> {
  if (target.kind === 'direct') return { kind: 'direct', sent: await client.sendDirect(target.to, message, replyTo) };
  const members = message.includes('@') ? await client.members() : [];
  return { kind: 'channel', sent: await client.sendChannel(target.channel, message, mentionsIn(message, members), replyTo), members };
}

/** Everything unread, read and marked: direct messages first, then each followed channel with any, oldest first. */
export interface ReadAll {
  direct: Message[];
  channels: { channel: string; messages: ChannelMessage[] }[];
  /** The channels as they were listed before reading: what else is unread (a mention where you don't follow). */
  listed: Channel[];
}

/**
 * Reads everything unread: the direct messages, then each channel you follow with anything unread.
 * A channel you don't follow is never read here (a person's unread there is its whole history);
 * one that mentions you is left in `listed` for the caller to say so.
 */
export async function readAll(client: TeamClient): Promise<ReadAll> {
  const direct = await client.readDirect();
  const listed = await client.channels();
  const channels: ReadAll['channels'] = [];
  for (const c of listed.filter((x) => x.following && x.unread > 0)) {
    const messages = await client.readChannel(c.channel);
    if (messages.length) channels.push({ channel: c.channel, messages });
  }
  return { direct, channels, listed };
}

/** Reads one target's unread, marked read: a channel's, or one member's direct messages. */
export function readOne(client: TeamClient, target: Target): Promise<(Message | ChannelMessage)[]> {
  return target.kind === 'channel' ? client.readChannel(target.channel) : client.readDirect(target.to);
}

/** What is still unread after readAll, from what it listed: the channels you don't follow that mention you. */
export function leftAfter(r: ReadAll) {
  return { direct: 0, channels: r.listed.filter((c) => !c.following && c.mentions > 0) };
}
