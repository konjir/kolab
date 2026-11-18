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

/**
 * A sign-in that can't be used: none kept, ended or revoked, or someone else's. Trying again
 * changes nothing until it is renewed, so `konnect mcp` doesn't retry it.
 */
export class SignInError extends Error {}

/** What a drain of a read tool read: oldest first, how many are still unread, and what stopped it, if anything did. */
export interface Drained<T> { messages: T[]; more: number; error?: Error }

/** How long the unread line may wait for Kolab: a command that has done its work never stalls on it. */
export const UNREAD_WAIT_MS = 2_000;

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
export type As = { kind: 'person' } | { kind: 'agent'; label: string; owner?: string };

/** The service's tools for direct-message history and for removing one's own agent. */
export const DIRECT_HISTORY_TOOL = 'konjir_list_messages';
export const REMOVE_AGENT_TOOL = 'konjir_remove_agent';

/** The client's name on Kolab's sign-in page. */
export const CLIENT_NAME = 'konnect';

/** At most this many pages, or rounds of unread messages, in one command. */
const MAX_ROUNDS = 50;
/** Kolab's read tools read at most this many at a time (MESSAGES_AT_ONCE). */
const AT_ONCE = 20;
/** The most messages one drain reads, when no limit is given. */
export const DRAIN_MAX = MAX_ROUNDS * AT_ONCE;

/** What to tell whoever runs into a sign-in that has to be renewed: a person, or an agent's owner. */
export function renewAdvice(team: string, as: As): string {
  return as.kind === 'person'
    ? `run konnect login ${team}`
    : `its owner should run konnect agent add ${as.label} again to renew it`;
}

export class TeamClient {
  /** Who the sign-in is (checked as it opens). */
  me!: Me;

  private constructor(readonly team: string, readonly url: string, private readonly mcp: Client, private readonly login: StoredLogin, readonly as: As) {}

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
        : me.kind === 'agent' && !!me.owner && me.actor === `${me.owner}-${as.label}` && (as.owner === undefined || me.owner === as.owner));
      if (!ok) {
        throw new SignInError(as.kind === 'person'
          ? `the login kept for team ${team} isn't yours in team ${team}, so konnect won't use it: run konnect login ${team}`
          : `the login kept for agent ${as.label} isn't that agent's in team ${team}, so konnect won't use it: ${renewAdvice(team, as)}`);
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
      throw new SignInError(as.kind === 'person' ? `you aren't logged in to team ${team}: run konnect login ${team}` : `agent ${as.label} has no login to team ${team} on this machine: ${renewAdvice(team, as)}`);
    }
    const mcp = new Client({ name: 'konnect', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: login, fetch: login.fetch, onInsufficientScope: 'throw' }));
    } catch (e) {
      login.releaseLock();
      throw said(e, team, url, as);
    }
    mcp.onerror = () => login.releaseIdleLock();
    return new TeamClient(team, url, mcp, login, as);
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
      throw said(e, this.team, this.url, this.as);
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

  /**
   * Reads a read tool until nothing more is unread, or `max` are read (DRAIN_MAX by default):
   * oldest first, each marked read as it is read. A failure partway is returned with what was read
   * before it, never thrown, so the caller still shows what is now marked read. `more` is how many
   * Kolab says are still unread after the last round.
   */
  private async drain<T>(tool: string, args: Record<string, unknown>, max = DRAIN_MAX): Promise<Drained<T>> {
    const messages: T[] = [];
    let more = 0;
    for (let i = 0; i < MAX_ROUNDS && messages.length < max; i++) {
      let r: { messages: T[]; more: number };
      try {
        r = await this.call<{ messages: T[]; more: number }>(tool, { ...args, limit: Math.min(AT_ONCE, max - messages.length) });
      } catch (e) {
        return { messages, more, error: e instanceof Error ? e : new Error(String(e)) };
      }
      messages.push(...r.messages);
      more = r.more ?? 0;
      if (!more || !r.messages.length) break;
    }
    return { messages, more };
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

  /** konjir_read_messages until none are left, or `max` are read: oldest first, each marked read; with `from`, only that member's. */
  readDirect(from?: string, max?: number): Promise<Drained<Message>> {
    return this.drain<Message>('konjir_read_messages', from !== undefined ? { from } : {}, max);
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

  /** konjir_read_channel until nothing more is unread there, or `max` are read: oldest first, moving your position. */
  readChannel(channel: string, max?: number): Promise<Drained<ChannelMessage>> { return this.drain<ChannelMessage>('konjir_read_channel', { channel }, max); }

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        this.mcp.readResource({ uri }),
        new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('the service took too long to say what is unread')), UNREAD_WAIT_MS); }),
      ]);
      const c = r.contents[0];
      body = c && 'text' in c ? JSON.parse(c.text) : {};
    } catch (e) {
      throw said(e, this.team, this.url, this.as);
    } finally {
      clearTimeout(timer);
      this.login.releaseIdleLock();
    }
    return {
      direct: body.messages?.unread ?? 0, directMore: !!body.messages?.unread_more,
      channels: (body.channels ?? []).map((c) => ({ channel: c.channel, following: !!c.following, unread: c.unread ?? 0, unread_more: !!c.unread_more, mentions: c.mentions ?? 0, mentions_more: !!c.mentions_more })),
    };
  }

  // ---- who belongs: the owner's invitations and removals, and leaving ---------------------------

  /** konjir_invite: the owner invites people by their GitHub usernames (at most 10 a call). */
  invite(accounts: string[]) {
    return this.call<{ kolab: string; invited: Invitation[]; already_invited: Invitation[]; already_members: string[]; declined_recently: string[] }>('konjir_invite', { accounts });
  }

  /** konjir_list_invitations, every page: the owner's invitations still waiting for an answer. */
  invitations(): Promise<Invitation[]> { return this.all<Invitation>('konjir_list_invitations', 'invitations'); }

  /** konjir_withdraw_invitation, by its id. */
  async withdraw(invitation: string): Promise<Invitation> { return (await this.call<{ withdrawn: Invitation }>('konjir_withdraw_invitation', { invitation })).withdrawn; }

  /** konjir_remove_member: the owner removes a person, and their agents go with them. */
  removeMember(member: string) { return this.call<{ kolab: string; removed: string; agents: string[]; ended: number }>('konjir_remove_member', { member }); }

  /** A tool this service may not have yet (an older one): NotYet says so plainly, where a refusal would mislead. */
  private async newer<T>(tool: string, args: Record<string, unknown>, what: string): Promise<T> {
    try { return await this.call<T>(tool, args); } catch (e) {
      if (/unknown tool|tool .* not found|-32602|-32601/i.test(String((e as Error)?.message ?? e))) throw new NotYet(`the service at ${safeUrl(this.url)} can't ${what} yet`);
      throw e;
    }
  }

  /** DIRECT_HISTORY_TOOL: the newest `limit` direct messages between the session and `member` (stored name), newest first, marking nothing. */
  async directHistory(member: string, limit: number): Promise<Message[]> {
    return (await this.newer<{ messages: Message[] }>(DIRECT_HISTORY_TOOL, { with: member, limit }, 'show the history of direct messages')).messages;
  }

  /** konjir_list_messages with no member: the newest `limit` direct messages the session received or sent, newest first, marking nothing. */
  async directRecent(limit: number): Promise<Message[]> {
    return (await this.call<{ messages: Message[] }>(DIRECT_HISTORY_TOOL, { limit })).messages;
  }

  /** REMOVE_AGENT_TOOL: a person removes an agent of their own, by its name. */
  removeAgent(label: string) {
    return this.newer<{ kolab: string; removed: string; label: string; revoked: number; ended: number }>(REMOVE_AGENT_TOOL, { agent: label }, 'remove an agent');
  }

  // ---- leases: a named thing one member holds at a time, for a while --------------------------------

  /** konjir_claim_lease: holds the lease, or renews one the session holds; `claimed` false with the holder's lease when someone else holds it. */
  claimLease(name: string, seconds?: number, note?: string) {
    return this.newer<{ claimed: boolean; renewed?: boolean; lease: Lease }>('konjir_claim_lease', { name, ...(seconds !== undefined ? { seconds } : {}), ...(note ? { note } : {}) }, 'hold leases');
  }

  /** konjir_release_lease: the holder gives it up; `released` false when nothing was held. */
  releaseLease(name: string) { return this.newer<{ released: boolean; name: string }>('konjir_release_lease', { name }, 'hold leases'); }

  /** konjir_break_lease: a person ends anyone's lease. */
  breakLease(name: string) { return this.newer<{ broken: boolean; lease?: Lease; name?: string }>('konjir_break_lease', { name }, 'hold leases'); }

  /** konjir_list_leases: every lease held in the team now, soonest to expire first. */
  async leases(): Promise<Lease[]> { return (await this.newer<{ leases: Lease[] }>('konjir_list_leases', {}, 'hold leases')).leases; }

  // ---- hosts: the person's own machines that start their agents when asked ---------------------------

  /** konjir_list_hosts: the person's own machines that host, or did, in the team. */
  async hosts(): Promise<Host[]> { return (await this.newer<{ hosts: Host[] }>('konjir_list_hosts', {}, 'start agents on another machine')).hosts; }

  /** konjir_serve_host: this machine says it is hosting, and takes the requests waiting for it; each is given out once. */
  serveHost(h: { name: string; instance: string; public_key: string; folder?: string; agents?: string[]; running?: string[] }) {
    return this.newer<{ host: Host; requests: HostRequest[] }>('konjir_serve_host', h, 'start agents on another machine');
  }

  /** konjir_ask_host: asks a machine of the person's own that is hosting; `body` is between the two konnects, and the service never reads it. */
  askHost(host: string, kind: HostRequest['kind'], body: string) {
    return this.newer<{ request: string; expires_at: string }>('konjir_ask_host', { host, kind, body }, 'start agents on another machine');
  }

  /** konjir_answer_host: the hosting machine's answer to a request it took. */
  answerHost(request: string, ok: boolean, result: string) { return this.call<{ answered: boolean }>('konjir_answer_host', { request, ok, result }); }

  /** konjir_read_host_request: where a request the person made stands, and its answer once it has one. */
  async hostRequest(request: string) {
    return (await this.call<{ request: { id: string; host: string; kind: string; state: 'waiting' | 'taken' | 'done' | 'expired'; ok?: boolean | null; result?: string | null } }>('konjir_read_host_request', { request })).request;
  }

  /** konjir_end_host: forgets a machine of the person's; with `instance`, only while it is still that one. */
  endHost(name: string, instance?: string) { return this.newer<{ ended: boolean }>('konjir_end_host', { name, ...(instance ? { instance } : {}) }, 'start agents on another machine'); }

  /** konjir_leave_kolab: the person leaves the team, and their agents with them. */
  leave() { return this.call<{ left: string; agents: string[]; ended: number }>('konjir_leave_kolab'); }
}

/** A machine of the person's that hosts, as Kolab's host tools give one: `serving` while it has said so in the last half minute. */
export interface Host { name: string; folder: string | null; serving: boolean; started_at: string; seen_at: string; agents: string[]; running: string[]; public_key: string }

/** A request a hosting machine took: `from` is who asked, always the machine's own person. */
export interface HostRequest { id: string; kind: 'start' | 'stop' | 'end'; body: string; from: string; requested_at: string; expires_at: string }

/** A lease, as Kolab's lease tools give one: `holder` a stored name. */
export interface Lease { name: string; holder: string; claimed_at: string; expires_at: string; note: string | null }

/** An invitation, as Kolab's invitation tools give one. */
export interface Invitation { id: string; kolab: string; account: string; state: string; invited_by: string; created_at: string }

/** An error from the transport or the sign-in, in konnect's words, with what to do next. */
export function said(e: unknown, team: string, url: string, as: As = { kind: 'person' }): Error {
  const msg = String((e as Error)?.message ?? e);
  const cause = String((e as { cause?: unknown })?.cause ?? '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(`${msg} ${cause}`)) {
    return new Error(`can't reach the service at ${safeUrl(url)}: check your connection and try again${url.includes('127.0.0.1') || url.includes('localhost') ? ', or start the local one' : ''}`);
  }
  if (e instanceof SignInError || e instanceof Refused) return e;
  if (/401|Unauthorized|has ended or was revoked|run konjir login|invalid Konjir token/i.test(msg)) {
    return new SignInError(as.kind === 'person'
      ? `your login to team ${team} has ended or was revoked: ${renewAdvice(team, as)}`
      : `agent ${as.label}'s login to team ${team} has ended or was revoked: ${renewAdvice(team, as)}`);
  }
  return e instanceof Error ? e : new Error(msg);
}
