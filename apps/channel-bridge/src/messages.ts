/**
 * What the bridge tells Claude: a short channel message for each change to an
 * inbox, saying what changed and how to read it. Contents are summarized, not
 * forwarded whole; the resource and the konjir_* tools stay the source.
 */

/** A question or note as Kolab's inbox and answers resources serve it. */
export interface QueryView {
  id: string; kind: string; address: string; question: string; state: string;
  answer: string | null; answered_by: string | null; raised_by: string | null;
}
/** An open mark as Kolab's inbox resource serves it. */
export interface MarkView { mark: string; reason: string; dirty: string; because: string }

export type InboxBody = { layer: string; queries: QueryView[]; marks: MarkView[] };
export type AnswersBody = { actor: string; queries: QueryView[] };

/** The params of a notifications/claude/channel notification. Meta keys must be identifiers. */
export interface ChannelMessage { content: string; meta: Record<string, string> }

const QUOTE_MAX = 160;
const LIST_MAX = 3;

/** Quote someone's text, on one line and cut short. */
export function quote(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listed<T>(items: T[], line: (t: T) => string) {
  const shown = items.slice(0, LIST_MAX).map((t) => `- ${line(t)}`);
  if (items.length > LIST_MAX) shown.push(`- and ${items.length - LIST_MAX} more`);
  return shown;
}

const isInbox = (b: unknown): b is InboxBody => !!b && typeof b === 'object' && 'layer' in b && Array.isArray((b as InboxBody).queries);
const isAnswers = (b: unknown): b is AnswersBody => !!b && typeof b === 'object' && 'actor' in b && Array.isArray((b as AnswersBody).queries);

/**
 * The message for a change to `uri`, from its previous contents (if the bridge
 * has seen them) to its current ones. Null when nothing visible changed.
 */
export function describeChange(uri: string, before: unknown, after: unknown): ChannelMessage | null {
  if (isInbox(after)) return inboxMessage(uri, isInbox(before) ? before : undefined, after);
  if (isAnswers(after)) return answersMessage(uri, isAnswers(before) ? before : undefined, after);
  return { content: `Kolab changed ${uri}. Read that resource to see what changed.`, meta: { uri, kind: 'unknown' } };
}

function inboxMessage(uri: string, before: InboxBody | undefined, after: InboxBody): ChannelMessage | null {
  const seenQ = new Set(before?.queries.map((q) => q.id) ?? []);
  const seenM = new Set(before?.marks.map((m) => m.mark) ?? []);
  const nowQ = new Set(after.queries.map((q) => q.id));
  const nowM = new Set(after.marks.map((m) => m.mark));
  const newQ = after.queries.filter((q) => !seenQ.has(q.id));
  const newM = after.marks.filter((m) => !seenM.has(m.mark));
  const goneQ = before ? before.queries.filter((q) => !nowQ.has(q.id)).length : 0;
  const goneM = before ? before.marks.filter((m) => !nowM.has(m.mark)).length : 0;
  if (before && !newQ.length && !newM.length && !goneQ && !goneM) return null;

  const lines = [`Your ${after.layer} inbox changed: ${plural(after.queries.length, 'open question or note', 'open questions and notes')}, ${plural(after.marks.length, 'open mark')}.`];
  if (newQ.length) {
    lines.push(`New ${newQ.length === 1 ? 'item' : 'items'} for your layer:`);
    lines.push(...listed(newQ, (q) => `${q.kind} ${q.id} on ${q.address}${q.raised_by ? ` from ${q.raised_by}` : ''}: ${quote(q.question)}`));
  }
  if (newM.length) {
    lines.push(`New ${newM.length === 1 ? 'mark' : 'marks'} on your work:`);
    lines.push(...listed(newM, (m) => `${m.dirty} (${m.reason}): ${quote(m.because)}`));
  }
  if (goneQ || goneM) lines.push(`Settled since the last change: ${[goneQ && plural(goneQ, 'question or note', 'questions and notes'), goneM && plural(goneM, 'mark')].filter(Boolean).join(', ')}.`);
  const tools = [newQ.length || !newM.length ? 'konjir_list_queries' : '', newM.length || !newQ.length ? 'konjir_list_stale' : ''].filter(Boolean);
  lines.push(`Read ${uri}, or call ${tools.join(' and ')}, before acting.`);
  return {
    content: lines.join('\n'),
    meta: {
      uri, kind: 'inbox', layer: after.layer,
      open_queries: String(after.queries.length), open_marks: String(after.marks.length),
    },
  };
}

function answersMessage(uri: string, before: AnswersBody | undefined, after: AnswersBody): ChannelMessage | null {
  const old = new Map(before?.queries.map((q) => [q.id, q]) ?? []);
  const answered = after.queries.filter((q) => q.answer != null && (!before || old.get(q.id)?.answer !== q.answer));
  if (!answered.length) return null;
  const lines = [`${answered.length === 1 ? 'An answer has' : `${answered.length} answers have`} come back to what you raised:`];
  lines.push(...listed(answered, (q) => `${q.kind} ${q.id} on ${q.address}, ${quote(q.question)}: ${q.answered_by ?? 'someone'} answered ${quote(q.answer!)}`));
  lines.push(`Read ${uri}, or call konjir_list_queries, for the full replies.`);
  return {
    content: lines.join('\n'),
    meta: { uri, kind: 'answers', actor: after.actor, answered: String(answered.length) },
  };
}
