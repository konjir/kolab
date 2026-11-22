/**
 * Names in what a person writes, as konnect's CLI reads them: `@member`, `@owner/label` for an
 * agent, and `#channel`. The composer completes the one being typed, and a channel message names
 * the members it mentions (konjir_send_channel_message's `mentions`, at most MAX_MENTIONS).
 */
import type { Member } from '@konjir/types';

export const MAX_MENTIONS = 20;
const NAME = '[a-z0-9][a-z0-9-]*';
const MENTION = new RegExp(`(^|[^\\w@/])@(${NAME}(?:/${NAME})?)`, 'gi');

/** How a member is written in a message: a person by name, an agent as `owner/label` when it has both. */
export const handleOf = (m: Pick<Member, 'actor' | 'owner' | 'label'>) => (m.owner && m.label ? `${m.owner}/${m.label}` : m.actor);

/**
 * The members `text` mentions, each once, in the order first written, as Kolab names them: only
 * those who are members, and at most MAX_MENTIONS.
 */
export function mentionsIn(text: string, members: Pick<Member, 'actor' | 'owner' | 'label'>[]): string[] {
  const byHandle = new Map<string, string>();
  for (const m of members) { byHandle.set(handleOf(m).toLowerCase(), handleOf(m)); byHandle.set(m.actor.toLowerCase(), handleOf(m)); }
  const out: string[] = [];
  for (const [, , name] of text.matchAll(MENTION)) {
    const found = byHandle.get(name!.toLowerCase());
    if (found && !out.includes(found)) out.push(found);
    if (out.length === MAX_MENTIONS) break;
  }
  return out;
}

/** The `@` or `#` word the cursor is in, if any: what to complete, and where it starts. */
export function completing(text: string, cursor: number): { kind: '@' | '#'; query: string; start: number } | undefined {
  const before = text.slice(0, cursor);
  const m = /(^|\s)([@#])([a-z0-9/-]*)$/i.exec(before);
  if (!m) return undefined;
  return { kind: m[2] as '@' | '#', query: m[3]!.toLowerCase(), start: before.length - m[3]!.length - 1 };
}

/** Candidates for the word being completed: names that start with it first, then those that contain it. */
export function suggestions(query: string, names: string[], limit = 6): string[] {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/** `text` with the word being completed replaced by `name` and a space; and where the cursor goes. */
export function complete(text: string, at: { kind: '@' | '#'; start: number }, cursor: number, name: string): { text: string; cursor: number } {
  const inserted = `${at.kind}${name} `;
  const next = text.slice(0, at.start) + inserted + text.slice(cursor);
  return { text: next, cursor: at.start + inserted.length };
}
