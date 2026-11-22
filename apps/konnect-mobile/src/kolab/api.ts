/**
 * Kolab's tools as the app calls them, typed: every operation is a `tools/call`, and its result is
 * the call's structuredContent. A refused call (isError) throws a KolabRefused with Kolab's words.
 * libs/konnect-client (another PR) will hold the CLI's and the app's shared wrappers; until then
 * these are the app's.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { Channel, ChannelMessage, Conversation, Member, Message } from '@konjir/types';

export class KolabRefused extends Error { name = 'KolabRefused'; }

export async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) {
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim();
    throw new KolabRefused(text || `Kolab refused ${name}`);
  }
  return r.structuredContent as T;
}

export interface Me { actor: string; kolab: string; role: string; kind?: string; owner?: string | null; subscribe: string[] }
export type Page<K extends string, T> = { [k in K]: T[] } & { next?: string | null };

/** What the answers resource says waits for the person: unread messages and channels. */
export interface Answers {
  actor: string;
  messages?: { unread?: number; items?: AnswerMessage[] };
  channels?: { channel: string; unread?: number; items?: AnswerChannelItem[] }[];
}
export interface AnswerMessage { id: string; from: string; message: string; reply_to?: string | null; capped?: boolean; sent_at?: string }
export interface AnswerChannelItem { id: string; channel: string; from: string; message: string; reply_to?: string | null; mentions_you?: boolean; capped?: boolean; sent_at?: string }

/** One message on a conversation's screen: a DM or a channel message, as the list tools give them. */
export type ConversationMessage = (Message | ChannelMessage) & { capped?: boolean };

export const kolab = (client: Client) => ({
  whoami: () => call<Me>(client, 'konjir_whoami'),
  answers: async (uri: string): Promise<Answers> => {
    const r = await client.readResource({ uri }, { cacheMode: 'bypass' });
    const c = r.contents[0];
    return JSON.parse(c && 'text' in c ? c.text : '{}') as Answers;
  },
  channels: () => call<Page<'channels', Channel> & { agent_reply_cap?: number }>(client, 'konjir_list_channels', { limit: 200 }),
  members: () => call<Page<'members', Member>>(client, 'konjir_list_members', { limit: 200 }),
  channelMessages: (channel: string, cursor?: string) => call<Page<'messages', ChannelMessage>>(client, 'konjir_list_channel_messages', { channel, limit: 50, ...(cursor ? { cursor } : {}) }),
  /** Each DM partner's conversation, newest first, with its last message and unread count (S3). */
  conversations: () => callNew<Page<'conversations', Conversation>>(client, 'konjir_list_conversations', { limit: 200 }),
  directMessages: (other: string, cursor?: string) => call<Page<'messages', Message>>(client, 'konjir_list_messages', { with: other, limit: 50, ...(cursor ? { cursor } : {}) }),
  sendMessage: (to: string, message: string, replyTo?: string) => call<{ sent: Message }>(client, 'konjir_send_message', { to, message, ...(replyTo ? { reply_to: replyTo } : {}) }),
  sendChannelMessage: (channel: string, message: string, mentions: string[], replyTo?: string) =>
    call<{ sent: ChannelMessage & { capped?: boolean } }>(client, 'konjir_send_channel_message', { channel, message, ...(mentions.length ? { mentions } : {}), ...(replyTo ? { reply_to: replyTo } : {}) }),
  /** Consumes up to `limit` unread messages of a channel, oldest first, marking them read. */
  readChannel: (channel: string, limit = 20) => call<{ messages?: unknown[]; more?: number }>(client, 'konjir_read_channel', { channel, limit }),
  /** Consumes up to `limit` unread DMs from `from`, oldest first, marking them read. */
  readMessages: (from: string, limit = 20) => call<{ messages?: unknown[]; more?: number }>(client, 'konjir_read_messages', { from, limit }),
  makeChannel: (channel: string) => call(client, 'konjir_make_channel', { channel }),
  follow: (channel: string) => call(client, 'konjir_follow_channel', { channel }),
  unfollow: (channel: string) => call(client, 'konjir_unfollow_channel', { channel }),
  // Team admin (phase 5): people's sessions only, and some the owner's only.
  invite: (accounts: string[]) => call<Record<string, unknown>>(client, 'konjir_invite', { accounts }),
  invitations: () => call<Page<'invitations', Record<string, unknown>>>(client, 'konjir_list_invitations', { limit: 200 }),
  withdrawInvitation: (invitation: string) => call(client, 'konjir_withdraw_invitation', { invitation }),
  removeMember: (member: string) => call(client, 'konjir_remove_member', { member }),
  removeAgent: (agent: string) => call(client, 'konjir_remove_agent', { agent }),
  setReplyCap: (cap: number) => call(client, 'konjir_set_agent_reply_cap', { agent_reply_cap: cap }),
  leave: () => call(client, 'konjir_leave_kolab'),
  archive: (team: string) => call(client, 'konjir_archive_kolab', { kolab: team }),
  erase: (team: string) => call(client, 'konjir_erase_kolab', { kolab: team }),
});
export type KolabApi = ReturnType<typeof kolab>;

const toolNames = new WeakMap<Client, Promise<Set<string>>>();
/** The tools this Kolab has, asked once per connection: an older Kolab lacks the newer ones. */
export function hasTool(client: Client, name: string): Promise<boolean> {
  let names = toolNames.get(client);
  if (!names) { names = client.listTools().then((r) => new Set(r.tools.map((t) => t.name))); toolNames.set(client, names); }
  return names.then((n) => n.has(name));
}

/** A tool this Kolab hasn't: said as what it is, rather than as a failed call. */
export class KolabLacks extends Error { name = 'KolabLacks'; }

/** Calls `name`, or says plainly that this Kolab hasn't it (an older server). */
export async function callNew<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!(await hasTool(client, name))) throw new KolabLacks(`This Kolab is older than konnect's app: it has no ${name}.`);
  return call<T>(client, name, args);
}

/**
 * Marks a conversation read up to `upTo`, the newest message seen (S2): konjir_mark_channel_read
 * or konjir_mark_messages_read, which only move forward.
 */
export async function markReadUpTo(client: Client, kind: 'channel' | 'dm', name: string, upTo: string): Promise<void> {
  if (kind === 'channel') await callNew(client, 'konjir_mark_channel_read', { channel: name, up_to: upTo });
  else await callNew(client, 'konjir_mark_messages_read', { with: name, up_to: upTo });
}
