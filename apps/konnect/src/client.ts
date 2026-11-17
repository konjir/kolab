/**
 * konnect's client of Kolab: one team's sign-in, and one method per server tool it calls. Each
 * command is built from these, so a new server tool is a new method here and nothing else changes
 * below the command.
 *
 * What the server can't do yet (invitations, removing a member) is here too, as methods that
 * refuse with NotYet: the commands that need them are wired to the method they will call, so the
 * track adding those tools fills in the method alone.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StoredLogin, safeUrl } from '@konjir/login';
import type { Channel, ChannelMessage, Member, Message } from './names.js';

/** What a server that can't do something yet answers, said plainly. */
export class NotYet extends Error {}

/** Kolab's own refusal of a call (a tool error), told apart from a call that never reached it. */
export class Refused extends Error {}

/** Who a session is, as konjir_whoami says. */
export interface Me { actor: string; kind: string; owner: string | null; kolab: string; role: string; subscribe?: string[] }

/** What is unread for the session, from its answers: direct messages, and each channel with any. */
export interface Unread {
  direct: number; directMore: boolean;
  channels: { channel: string; following: boolean; unread: number; unread_more: boolean; mentions: number; mentions_more: boolean }[];
}

/**
 * Who a sign-in must be: the person themselves (konnect's commands), or an agent of theirs by its
 * label (`konnect mcp`, run for an agent).
 */
export type As = { kind: 'person' } | { kind: 'agent'; label: string };

/** The client's name on Kolab's sign-in page. */
export const CLIENT_NAME = 'konnect';

/** At most this many pages, or rounds of unread messages, in one command. */
const MAX_ROUNDS = 50;

export class TeamClient {
  /** Who the sign-in is (checked as it opens). */
  me!: Me;

  private constructor(readonly team: string, readonly url: string, private readonly mcp: Client, private readonly login: StoredLogin) {}

  /**
   * Connects with the team's kept sign-in (`file`), and checks, before anything else is called,
   * that it is `as` in the team's kolab (konjir_whoami): the person's own by default, or with `as`
   * an agent's, by its label. A file holding anyone else's sign-in is refused. Throws when there is
   * none, or it has ended.
   */
  static async open(team: string, url: string, file: string, as: As = { kind: 'person' }): Promise<TeamClient> {
    const c = await TeamClient.connect(team, url, file, as);
    try {
      const me = await c.whoami();
      const ok = !!me && typeof me === 'object' && me.kolab === team && (as.kind === 'person'
        ? me.kind === 'person'
        : me.kind === 'agent' && !!me.owner && me.actor === `${me.owner}-${as.label}`);
      if (!ok) {
        throw new Error(as.kind === 'person'
          ? `the sign-in kept for team ${team} isn't yours in team ${team}, so konnect won't use it: run konnect team ${team} to sign in again`
          : `the sign-in kept for agent ${as.label} isn't that agent's in team ${team}, so konnect won't use it`);
      }
      c.me = me;
      return c;
    } catch (e) {
      await c.close();
      throw e;
    }
  }

  private static async connect(team: string, url: string, file: string, as: As): Promise<TeamClient> {
    const login = new StoredLogin(url, { path: file, clientName: CLIENT_NAME });
    if (!login.signedIn) {
      throw new Error(as.kind === 'person' ? `you aren't signed in to team ${team}: run konnect team ${team}` : `agent ${as.label} isn't signed in to team ${team} (no sign-in in ${file})`);
    }
    const mcp = new Client({ name: 'konnect', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: login, fetch: login.fetch, onInsufficientScope: 'throw' }));
    } catch (e) {
      login.releaseLock();
      throw said(e, team, url);
    }
    mcp.onerror = () => login.releaseIdleLock();
    return new TeamClient(team, url, mcp, login);
  }

  async close() {
    this.login.releaseLock();
    await this.mcp.close().catch(() => undefined);
  }

  /**
   * The MCP client itself, for what outlives one call: `konnect mcp`'s subscription to the
   * session's answers (subscriptions/listen), when it wakes an agent. Nothing here uses it yet.
   */
  get session(): Client { return this.mcp; }

  /** One tool call: its structured result, or Refused with Kolab's words. */
  private async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    let r: Awaited<ReturnType<Client['callTool']>>;
    try {
      r = await this.mcp.callTool({ name: tool, arguments: args });
    } catch (e) {
      throw said(e, this.team, this.url);
    } finally {
      this.login.releaseIdleLock();
    }
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    if (r.isError) throw new Refused(text);
    return (r.structuredContent ?? text) as T;
  }

  /** Every page of a paged list tool, `key` its items. */
  private async all<T>(tool: string, key: string, args: Record<string, unknown> = {}): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const page: Record<string, unknown> & { next: string | null } = await this.call<Record<string, unknown> & { next: string | null }>(tool, { ...args, limit: 200, ...(cursor ? { cursor } : {}) });
      all.push(...((page[key] as T[]) ?? []));
      if (!page.next) break;
      cursor = page.next;
    }
    return all;
  }

  /** Reads a read tool until nothing more is unread: oldest first, each marked read. */
  private async drain<T>(tool: string, args: Record<string, unknown>): Promise<T[]> {
    const all: T[] = [];
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const r = await this.call<{ messages: T[]; more: number }>(tool, args);
      all.push(...r.messages);
      if (!r.more || !r.messages.length) break;
    }
    return all;
  }

  // ---- people and direct messages --------------------------------------------------------------

  /** konjir_whoami. */
  whoami() { return this.call<Me>('konjir_whoami'); }

  /** konjir_list_members, every page. */
  members(): Promise<Member[]> { return this.all<Member>('konjir_list_members', 'members'); }

  /** konjir_send_message: a direct message to a member, by stored name. */
  async sendDirect(to: string, message: string, replyTo?: string): Promise<Message> {
    return (await this.call<{ sent: Message }>('konjir_send_message', { to, message, ...(replyTo ? { reply_to: replyTo } : {}) })).sent;
  }

  /** konjir_read_messages until none are left: oldest first, each marked read; with `from`, only that member's. */
  readDirect(from?: string): Promise<Message[]> {
    return this.drain<Message>('konjir_read_messages', from !== undefined ? { from } : {});
  }

  // ---- channels --------------------------------------------------------------------------------

  /** konjir_list_channels, every page. */
  channels(): Promise<Channel[]> { return this.all<Channel>('konjir_list_channels', 'channels'); }

  /** konjir_make_channel: made, and followed. */
  async makeChannel(channel: string): Promise<Channel> { return (await this.call<{ channel: Channel }>('konjir_make_channel', { channel })).channel; }

  /** konjir_follow_channel. */
  follow(channel: string) { return this.call<{ channel: string; following: boolean }>('konjir_follow_channel', { channel }); }

  /** konjir_unfollow_channel. */
  unfollow(channel: string) { return this.call<{ channel: string; following: boolean }>('konjir_unfollow_channel', { channel }); }

  /** konjir_send_channel_message, with the members it mentions (stored names). */
  async sendChannel(channel: string, message: string, mentions: string[] = [], replyTo?: string): Promise<ChannelMessage> {
    return (await this.call<{ sent: ChannelMessage }>('konjir_send_channel_message', {
      channel, message, ...(mentions.length ? { mentions } : {}), ...(replyTo ? { reply_to: replyTo } : {}),
    })).sent;
  }

  /** konjir_read_channel until nothing more is unread there: oldest first, moving your position. */
  readChannel(channel: string): Promise<ChannelMessage[]> { return this.drain<ChannelMessage>('konjir_read_channel', { channel }); }

  /** konjir_list_channel_messages: the newest `limit` (one page, at most 200), newest first, marking nothing. */
  async channelHistory(channel: string, limit: number): Promise<ChannelMessage[]> {
    return (await this.call<{ messages: ChannelMessage[] }>('konjir_list_channel_messages', { channel, limit })).messages;
  }

  /**
   * What is unread for the session, in one read of its answers (konjir://answers/<kolab>/<actor>):
   * how many direct messages, and per channel followed with any unread, or with an unread mention,
   * the counts. It reads; it marks nothing.
   */
  async unread(): Promise<Unread> {
    const uri = `konjir://answers/${encodeURIComponent(this.me.kolab)}/${encodeURIComponent(this.me.actor)}`;
    let body: { messages?: { unread?: number; unread_more?: boolean }; channels?: Unread['channels'] } = {};
    try {
      const r = await this.mcp.readResource({ uri });
      const c = r.contents[0];
      body = c && 'text' in c ? JSON.parse(c.text) : {};
    } catch (e) {
      throw said(e, this.team, this.url);
    } finally {
      this.login.releaseIdleLock();
    }
    return {
      direct: body.messages?.unread ?? 0, directMore: !!body.messages?.unread_more,
      channels: (body.channels ?? []).map((c) => ({ channel: c.channel, following: !!c.following, unread: c.unread ?? 0, unread_more: !!c.unread_more, mentions: c.mentions ?? 0, mentions_more: !!c.mentions_more })),
    };
  }

  // ---- seams for tools the server doesn't have yet ---------------------------------------------

  /** `konnect recruit <github login>…`: the owner invites by GitHub account (the invitations track). */
  async recruit(_logins: string[]): Promise<unknown> { throw new NotYet('invitations'); }

  /** `konnect remove @name`: the owner removes a member, or a member leaves (the invitations track). */
  async remove(_member: string): Promise<unknown> { throw new NotYet('removing members'); }
}

/** An error from the transport or the sign-in, in konnect's words, with what to do next. */
export function said(e: unknown, team: string, url: string): Error {
  const msg = String((e as Error)?.message ?? e);
  const cause = String((e as { cause?: unknown })?.cause ?? '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(`${msg} ${cause}`)) {
    return new Error(`can't reach Kolab at ${safeUrl(url)}: check your connection and try again${url.includes('127.0.0.1') || url.includes('localhost') ? ', or start the local Kolab' : ''}`);
  }
  if (/401|Unauthorized|has ended or was revoked|run konjir login|invalid Konjir token/i.test(msg)) {
    return new Error(`your sign-in to team ${team} has ended or was revoked: run konnect team ${team} to sign in again`);
  }
  return e instanceof Error ? e : new Error(msg);
}
