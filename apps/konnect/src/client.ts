/**
 * konnect's client of Kolab: one team's sign-in, and one method per server tool it calls. Each
 * command is built from these, so a new server tool is a new method here and nothing else changes
 * below the command.
 *
 * What the server can't do yet (channels, invitations, removing a member) is here too, as methods
 * that refuse with NotYet: the commands that need them are wired to the method they will call, so
 * the tracks adding those tools fill in the method alone.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StoredLogin, safeUrl } from '@konjir/login';
import type { Member, Message } from './names.js';

/** What a server that can't do something yet answers, said plainly. */
export class NotYet extends Error {}

/** Kolab's own refusal of a call (a tool error), told apart from a call that never reached it. */
export class Refused extends Error {}

/** Who a session is, as konjir_whoami says. */
export interface Me { actor: string; kind: string; owner: string | null; kolab: string; role: string }

/** The client's name on Kolab's sign-in page. */
export const CLIENT_NAME = 'konnect';

/** At most this many pages of members, or rounds of unread messages, in one command. */
const MAX_ROUNDS = 50;

export class TeamClient {
  /** Who the sign-in is: the person, in this team (checked as it opens). */
  me!: Me;

  private constructor(readonly team: string, readonly url: string, private readonly mcp: Client, private readonly login: StoredLogin) {}

  /**
   * Connects with the team's kept sign-in (`file`), and checks it is the person's own session in
   * the team's kolab (konjir_whoami) before anything else is called: a file holding anyone else's
   * sign-in, an agent's or another kolab's, is refused. Throws when there is none, or it has ended.
   */
  static async open(team: string, url: string, file: string): Promise<TeamClient> {
    const c = await TeamClient.connect(team, url, file);
    try {
      const me = await c.whoami();
      if (!me || typeof me !== 'object' || me.kind !== 'person' || me.kolab !== team) {
        throw new Error(`the sign-in kept for team ${team} isn't yours in team ${team}, so konnect won't use it: run konnect team ${team} to sign in again`);
      }
      c.me = me;
      return c;
    } catch (e) {
      await c.close();
      throw e;
    }
  }

  private static async connect(team: string, url: string, file: string): Promise<TeamClient> {
    const login = new StoredLogin(url, { path: file, clientName: CLIENT_NAME });
    if (!login.signedIn) throw new Error(`you aren't signed in to team ${team}: run konnect team ${team}`);
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

  /** One tool call: its structured result, or Refused with Kolab's words. */
  private async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    let r: Awaited<ReturnType<Client['callTool']>>;
    try {
      r = await this.mcp.callTool({ name: tool, arguments: args });
    } catch (e) {
      throw said(e, this.team, this.url);
    }
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    if (r.isError) throw new Refused(text);
    return (r.structuredContent ?? text) as T;
  }

  // ---- today's tools ---------------------------------------------------------------------------

  /** konjir_whoami. */
  whoami() { return this.call<Me>('konjir_whoami'); }

  /** konjir_list_members, every page. */
  async members(): Promise<Member[]> {
    const all: Member[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const page: { members: Member[]; next: string | null } = await this.call('konjir_list_members', cursor ? { cursor, limit: 200 } : { limit: 200 });
      all.push(...page.members);
      if (!page.next) break;
      cursor = page.next;
    }
    return all;
  }

  /** konjir_send_message: a direct message to a member, by stored name. */
  async sendDirect(to: string, message: string): Promise<Message> {
    return (await this.call<{ sent: Message }>('konjir_send_message', { to, message })).sent;
  }

  /** konjir_read_messages, until none are left unread: oldest first, each marked read. */
  async readDirect(): Promise<Message[]> {
    const all: Message[] = [];
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const r = await this.call<{ messages: Message[]; more: number }>('konjir_read_messages');
      all.push(...r.messages);
      if (!r.more || !r.messages.length) break;
    }
    return all;
  }

  /**
   * The unread messages one member sent you, oldest first, from konjir_list_messages (with=<them>),
   * which marks nothing: Kolab reads one person's messages, and marks them read, only all at once
   * (konjir_read_messages). When it can, readDirectFrom is one call of that tool with a `from`.
   */
  async unreadFrom(from: string): Promise<Message[]> {
    const all: Message[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const page: { messages: Message[]; next: string | null } = await this.call('konjir_list_messages', { with: from, sent: false, limit: 200, ...(cursor ? { cursor } : {}) });
      all.push(...page.messages);
      // Newest first: past the oldest unread there is nothing more to find, but a read one may sit between unread ones.
      if (!page.next) break;
      cursor = page.next;
    }
    return all.filter((m) => m.read_at === null && m.from === from).reverse();
  }

  // ---- seams for tools the server doesn't have yet ---------------------------------------------

  /** A channel message (`konnect send '#general' …`): the channels track's tool. */
  async sendChannel(_channel: string, _message: string): Promise<Message> { throw new NotYet('channels'); }

  /** A channel's unread messages, marked read (`konnect read '#general'`): the channels track's tool. */
  async readChannel(_channel: string): Promise<Message[]> { throw new NotYet('channels'); }

  /** `konnect channel new|join|leave|list`: the channels track's tools. */
  async channel(_verb: 'new' | 'join' | 'leave' | 'list', _name?: string): Promise<unknown> { throw new NotYet('channels'); }

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
