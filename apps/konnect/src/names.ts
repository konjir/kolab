/**
 * How konnect names the members of a team. A person is their name (`ann`). An agent is stored in
 * Kolab as `<owner>-<label>` (a slash can't be in an actor's id), and konnect shows and takes it as
 * `<owner>/<label>`, from the label Kolab's member list gives; where it gives none (an older Kolab),
 * from what follows `<owner>-` in the stored name.
 */

/** A member as konjir_list_members gives one: an agent with its `label` (null when it has none). */
export interface Member { actor: string; kind: string; owner: string | null; here: boolean; you?: true; label?: string | null }

/** A direct message as Kolab's message tools give one. */
export interface Message { id: string; from: string; to: string; message: string; reply_to: string | null; sent_at: string; read_at: string | null }

/** A channel message as Kolab's channel tools give one. */
export interface ChannelMessage { id: string; channel: string; from: string; message: string; reply_to: string | null; mentions: string[]; sent_at: string }

/** A channel as konjir_list_channels gives one, for the caller. */
export interface Channel { channel: string; following: boolean; unread: number; unread_more: boolean; mentions: number; mentions_more: boolean; made_by: string | null; made_at: string }

/** A channel's name, as Kolab allows one; a `#` before it is dropped. */
export const CHANNEL = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A channel's name from `#name` or `name`, checked. */
export function channelName(given: string): string {
  const name = given.startsWith('#') ? given.slice(1) : given;
  if (!CHANNEL.test(name)) throw new Error(`${printable(given)} isn't a channel's name: 1 to 40 lowercase letters, digits and -, such as #general`);
  return name;
}

/** The most members one channel message may mention (Kolab's MAX_MENTIONS). */
export const MAX_MENTIONS = 20;

/**
 * The members a message's words mention, as stored names: each `@name` or `@owner/label` that names
 * a member of `members`, in the order written, each once, at most MAX_MENTIONS; `beyond` counts the
 * members named past those, which stay plain words. Names match whatever their case (`@Ann` is
 * `ann`). `@owner/label` mentions that agent or no one: never the owner. Anything else that looks
 * like a mention (an email address, `@everyone`, someone not in the team) is left as plain words.
 */
export function mentionsIn(text: string, members: Member[]): { mentions: string[]; beyond: number } {
  const found: string[] = [];
  const past = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.@/-])@([A-Za-z0-9][A-Za-z0-9._@-]*(?:\/[A-Za-z0-9._-]*)?)/g)) {
    // A sentence's full stop, or a trailing hyphen, isn't part of the name.
    const word = m[1].replace(/[.@/-]+$/, '').toLowerCase();
    const member = members.find((x) => (word.includes('/')
      ? x.kind === 'agent' && shownName(x).toLowerCase() === word
      : x.actor.toLowerCase() === word));
    if (!member || found.includes(member.actor)) continue;
    if (found.length === MAX_MENTIONS) past.add(member.actor);
    else found.push(member.actor);
  }
  return { mentions: found, beyond: past.size };
}

/** A count, with `+` when Kolab counted no further. */
export const counted = (n: number, more: boolean) => `${n}${more ? '+' : ''}`;

/** konnect channel list's lines: each channel, whether you follow it, and its unread and mentions. */
export function formatChannels(channels: Channel[]): string {
  const width = Math.max(0, ...channels.map((c) => c.channel.length + 1)) + 2;
  return channels.map((c) => [
    `#${printable(c.channel)}`.padEnd(width),
    (c.following ? 'following' : '').padEnd(11),
    c.unread ? `${counted(c.unread, c.unread_more)} unread` : '',
    c.mentions ? `${c.unread ? ', ' : ''}${counted(c.mentions, c.mentions_more)} mentioning you` : '',
  ].join('').trimEnd()).join('\n');
}

/**
 * The one line that says what is unread elsewhere, such as `2 unread in #deploys, 1 direct
 * message`, or '' when nothing is: each channel you follow with unread, each other channel that
 * mentions you, then direct messages.
 */
export function unreadLine(u: { direct: number; directMore?: boolean; channels: { channel: string; following: boolean; unread: number; unread_more: boolean; mentions: number; mentions_more: boolean }[] }): string {
  const parts: string[] = [];
  for (const c of u.channels) {
    if (c.following && c.unread) parts.push(`${counted(c.unread, c.unread_more)} unread in #${printable(c.channel)}`);
    else if (c.mentions) parts.push(`${counted(c.mentions, c.mentions_more)} mentioning you in #${printable(c.channel)}`);
  }
  if (u.direct) parts.push(`${counted(u.direct, !!u.directMore)} direct message${u.direct === 1 && !u.directMore ? '' : 's'}`);
  return parts.join(', ');
}

/** A team's name: a kolab's (lowercase letters, digits and -, at most 40 characters). */
export const TEAM = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A member's stored name, as Kolab allows an actor's id. */
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
/** An agent's label, as Kolab allows one. */
const LABEL = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** The name konnect shows for a member: `owner/label` for an agent whose owner is known, else the stored name. */
export function shownName(m: Pick<Member, 'actor' | 'kind' | 'owner' | 'label'>): string {
  if (m.kind !== 'agent' || !m.owner) return m.actor;
  if (m.label) return `${m.owner}/${m.label}`;
  return m.actor.startsWith(`${m.owner}-`) && m.actor.length > m.owner.length + 1 ? `${m.owner}/${m.actor.slice(m.owner.length + 1)}` : m.actor;
}

/** The name konnect shows for a stored name, from the members it knows; the stored name when it knows none. */
export function shownActor(actor: string, members: Member[]): string {
  const m = members.find((x) => x.actor === actor);
  return m ? shownName(m) : actor;
}

/**
 * A direct message's recipient, as Kolab stores the name: `@ann` is `ann`, `@ann/reviewer` is
 * `ann-reviewer`. The `@` may be left out. A channel (`#general`) is not a member: the caller
 * tells it apart first.
 */
export function storedName(given: string): string {
  const name = given.startsWith('@') ? given.slice(1) : given;
  const slash = name.indexOf('/');
  if (slash >= 0) {
    const owner = name.slice(0, slash), label = name.slice(slash + 1);
    if (!ACTOR.test(owner) || !LABEL.test(label)) throw new Error(`${given} isn't a member's name: an agent is @<owner>/<name>, such as @ann/reviewer. konnect team list shows your team`);
    return `${owner}-${label}`;
  }
  if (!ACTOR.test(name)) throw new Error(`${given} isn't a member's name: give @<name>, or @<owner>/<name> for an agent. konnect team list shows your team`);
  return name;
}

/**
 * Text fit to print to a terminal: every control character but a line break, and every format
 * character (bidirectional overrides such as U+202E, zero-width ones such as U+200B), shown as
 * `?`, so text from Kolab or a file can't move the cursor, reorder or hide what konnect printed.
 */
export const printable = (text: string): string => String(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? '\n' : '?'));

/** One line per member: name, kind, connected or not. */
export function formatMembers(members: Member[]): string {
  const rows = members.map((m) => [
    `${printable(shownName(m))}${m.you ? ' (you)' : ''}`,
    printable(m.kind),
    m.here ? 'connected' : '',
  ]);
  const width = Math.max(0, ...rows.map((r) => r[0].length)) + 2;
  return rows.map((r) => `${r[0].padEnd(width)}${r[1].padEnd(8)}${r[2]}`.trimEnd()).join('\n');
}

/** A member as `--json` gives one: always by the name konnect shows. */
export function memberJson(m: Member): { name: string; kind: string; owner: string | null; connected: boolean; you?: true } {
  return { name: shownName(m), kind: m.kind, owner: m.owner, connected: m.here, ...(m.you ? { you: true as const } : {}) };
}

/**
 * konnect team list's lines: each person, their agents under them, then whoever is invited and
 * hasn't answered. Connected is said of agents alone: a person holds no session between commands.
 */
export function formatTeam(members: Member[], invited: { account: string; created_at: string }[]): string {
  const people = members.filter((m) => m.kind !== 'agent');
  const agents = members.filter((m) => m.kind === 'agent');
  const ordered = [...people.flatMap((p) => [p, ...agents.filter((a) => a.owner === p.actor)]), ...agents.filter((a) => !people.some((p) => p.actor === a.owner))];
  const rows = [
    ...ordered.map((m) => [`@${printable(shownName(m))}${m.you ? ' (you)' : ''}`, printable(m.kind), m.kind === 'agent' && m.here ? 'connected' : '']),
    ...invited.map((i) => [`@${printable(i.account)}`, 'person', `invited ${printable(i.created_at.slice(0, 10))}`]),
  ];
  const width = Math.max(0, ...rows.map((r) => r[0].length)) + 2;
  return rows.map((r) => `${r[0].padEnd(width)}${r[1].padEnd(8)}${r[2]}`.trimEnd()).join('\n');
}

/** A message as a block of lines: when and who, then the words, indented. */
export function formatMessage(m: Pick<Message, 'from' | 'message' | 'sent_at'>, members: Member[]): string {
  const when = printable(String(m.sent_at).replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, '')).replace(/\n/g, '?');
  const words = printable(m.message).split('\n').map((l) => `  ${l}`).join('\n');
  return `${when}  @${printable(shownActor(m.from, members))}\n${words}`;
}
