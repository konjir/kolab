/**
 * What konnect does with a team's messages, shared by the commands (konnect.ts) and the tools an
 * agent gets (`konnect mcp`, mcp.ts): where a message goes, sending it with its mentions, and
 * reading what is unread. Each is a few TeamClient calls; neither side formats anything here.
 *
 * Reading marks as it goes (each call of Kolab's read tools moves the reader's position), so what is
 * read is handed to the caller block by block, as soon as each is read, and a failure partway
 * still hands over what was read before it: nothing marked read is ever lost unshown.
 */
import { Refused, type Drained, type TeamClient } from './client.js';
import { channelName, mentionsIn, storedName, type Channel, type ChannelMessage, type Member, type Message } from './names.js';

/** Where a message goes, or what to read: a channel (`#deploys`) or a member (`@ann`, `@ann/reviewer`). */
export type Target = { kind: 'channel'; channel: string } | { kind: 'direct'; to: string; given: string };

/**
 * A word as a target: `@…` names a member, `#…` a channel. A bare word is refused, never guessed:
 * `ann` could be a person or a channel any member could have made, and a private message must
 * never land in a channel. `example(word)` shows the person both forms.
 */
export function targetOf(word: string, example: (name: string) => string): Target {
  if (word.startsWith('@')) return { kind: 'direct', to: storedName(word), given: word };
  if (word.startsWith('#')) return { kind: 'channel', channel: channelName(word) };
  throw new Error(`say whether ${word} is a member or a channel: ${example(word)}`);
}

/** What was sent: to a member, or to a channel with the members it mentions. */
export type Sent = { kind: 'direct'; sent: Message } | { kind: 'channel'; sent: ChannelMessage; members: Member[] };

/** Why a send might be refused for a mention: Kolab names the member who isn't one. */
const NOT_A_MEMBER = /(\S+) is not a member of kolab \S+, so a message can't mention them/;

/**
 * Sends `message` to `target`. A channel message mentions each member its words name (`@ann`,
 * `@ann/reviewer`), looked up in the team's members first; other `@words` stay words. A mention
 * never stops the message: if the members can't be listed it goes with none, past the 20 Kolab
 * takes the rest are words, and one Kolab refuses (they left the team meanwhile) is dropped and the
 * message sent again, once. `warn` says each of these.
 */
export async function send(client: TeamClient, target: Target, message: string, opts: { replyTo?: string; warn?: (line: string) => void } = {}): Promise<Sent> {
  const warn = opts.warn ?? (() => undefined);
  if (target.kind === 'direct') return { kind: 'direct', sent: await client.sendDirect(target.to, message, opts.replyTo) };
  let members: Member[] = [];
  if (message.includes('@')) {
    try { members = await client.members(); } catch (e) {
      warn(`konnect couldn't list the team's members (${(e as Error)?.message ?? e}), so this message mentions no one.`);
    }
  }
  const { mentions, beyond } = mentionsIn(message, members);
  if (beyond) warn(`A message mentions at most 20 members: ${beyond} more ${beyond === 1 ? 'was' : 'were'} sent as plain words.`);
  try {
    return { kind: 'channel', sent: await client.sendChannel(target.channel, message, mentions, opts.replyTo), members };
  } catch (e) {
    const gone = e instanceof Refused ? NOT_A_MEMBER.exec(e.message)?.[1] : undefined;
    if (gone === undefined) throw e;
    const kept = mentions.filter((m) => m !== gone);
    if (kept.length === mentions.length) throw e;
    warn(`@${gone} isn't in the team any more, so the message went without mentioning them.`);
    return { kind: 'channel', sent: await client.sendChannel(target.channel, message, kept, opts.replyTo), members };
  }
}

/** One block of what is read: the direct messages, or one channel's. */
export type Block =
  | ({ kind: 'direct' } & Drained<Message>)
  | ({ kind: 'channel'; channel: string } & Drained<ChannelMessage>);

/**
 * Reads everything unread: the direct messages, then each channel you follow with anything unread,
 * at most `limit` messages in all (each block bounded as TeamClient.drain is, when none is given).
 * Each block goes to `onBlock` as soon as it is read, failed partway or not; a failure is thrown
 * after its block was handed over. A channel you don't follow is never read here (a person's unread
 * there is its whole history); the channels as listed come back for the caller to say what else
 * waits. With a `limit` that runs out, the channels not reached come back with their unread as
 * `more` and nothing read.
 */
export async function readAll(client: TeamClient, onBlock: (b: Block) => void, opts: { limit?: number } = {}): Promise<{ listed: Channel[] }> {
  let left = opts.limit;
  const deliver = (b: Block) => {
    onBlock(b);
    if (left !== undefined) left -= b.messages.length;
    if (b.error) throw b.error;
  };
  deliver({ kind: 'direct', ...await client.readDirect(undefined, left) });
  const listed = await client.channels();
  for (const c of listed.filter((x) => x.following && x.unread > 0)) {
    if (left !== undefined && left <= 0) { onBlock({ kind: 'channel', channel: c.channel, messages: [], more: c.unread }); continue; }
    deliver({ kind: 'channel', channel: c.channel, ...await client.readChannel(c.channel, left) });
  }
  return { listed };
}

/** Reads one target's unread, marked read, at most `limit`: a channel's, or one member's direct messages. */
export async function readOne(client: TeamClient, target: Target, limit?: number): Promise<Block> {
  return target.kind === 'channel'
    ? { kind: 'channel', channel: target.channel, ...await client.readChannel(target.channel, limit) }
    : { kind: 'direct', ...await client.readDirect(target.to, limit) };
}

/** What is still unread after readAll, from what it listed: the channels you don't follow that mention you. */
export function leftAfter(listed: Channel[]) {
  return { direct: 0, channels: listed.filter((c) => !c.following && c.mentions > 0) };
}
