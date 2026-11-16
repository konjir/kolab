/**
 * How konnect names the members of a team. A person is their name (`ann`). An agent is stored in
 * Kolab as `<owner>-<label>` (a slash can't be in an actor's id), and konnect shows and takes it as
 * `<owner>/<label>`. Until Kolab's member list gives an agent's label as a field of its own, the
 * label is what follows `<owner>-` in the stored name.
 */

/** A member as konjir_list_members gives one; `label` is the field the server is to add. */
export interface Member { actor: string; kind: string; owner: string | null; here: boolean; you?: true; label?: string }

/** A direct message as Kolab's message tools give one. */
export interface Message { id: string; from: string; to: string; message: string; reply_to: string | null; sent_at: string; read_at: string | null }

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
    if (!ACTOR.test(owner) || !LABEL.test(label)) throw new Error(`${given} isn't a member's name: an agent is @<owner>/<label>, such as @ann/reviewer. konnect who lists your team`);
    return `${owner}-${label}`;
  }
  if (!ACTOR.test(name)) throw new Error(`${given} isn't a member's name: give @<name>, or @<owner>/<label> for an agent. konnect who lists your team`);
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

/** A message as a block of lines: when and who, then the words, indented. */
export function formatMessage(m: Message, members: Member[]): string {
  const when = printable(String(m.sent_at).replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, '')).replace(/\n/g, '?');
  const words = printable(m.message).split('\n').map((l) => `  ${l}`).join('\n');
  return `${when}  @${printable(shownActor(m.from, members))}\n${words}`;
}
