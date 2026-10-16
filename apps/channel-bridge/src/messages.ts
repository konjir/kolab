/**
 * What the bridge tells Claude: a short channel message when there is something
 * for the session to look at, saying what it is and how to read it. Contents are
 * summarized, not forwarded whole; the resource and the konjir_* tools stay the
 * source.
 *
 * A channel message starts a turn, so the bridge sends one only when there is
 * new work or a new answer. A change that only removes items (usually the
 * session's own answer or clear) sends nothing; the next message carries the
 * current counts.
 */

/** A question or note as Kolab's inbox and answers resources serve it. */
export interface QueryView {
  id: string; kind: string; address: string; question: string; state: string;
  answer: string | null; answered_by: string | null; raised_by: string | null;
}
/** An open mark as Kolab's inbox resource serves it. */
export interface MarkView { mark: string; reason: string; dirty: string; because: string; next?: string }

export type InboxBody = { layer: string; queries: QueryView[]; marks: MarkView[] };
export type AnswersBody = { actor: string; queries: QueryView[] };

/** The params of a notifications/claude/channel notification. Meta keys must be identifiers. */
export interface ChannelMessage { content: string; meta: Record<string, string> }

const QUOTE_MAX = 160;
const LIST_MAX = 3;

/**
 * Text fit for the body of a <channel> tag: `<`, `>` and `&` become JSON escapes,
 * so nothing a collaborator wrote can close the tag or open another.
 */
export function escapeTags(text: string) {
  return text.replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Quote someone's text, on one line and cut short. */
export function quote(text: string) {
  return JSON.stringify(clip(text));
}

function clip(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listed<T>(items: T[], line: (t: T) => string) {
  const shown = items.slice(0, LIST_MAX).map((t) => `- ${line(t)}`);
  if (items.length > LIST_MAX) shown.push(`- and ${items.length - LIST_MAX} more`);
  return shown;
}

const queryLine = (q: QueryView) => `${q.kind} ${q.id} on ${q.address}${q.raised_by ? ` from ${q.raised_by}` : ''}: ${quote(q.question)}`;
const markLine = (m: MarkView) => `mark ${m.mark} on ${m.dirty} (${m.reason}): ${clip(m.because)}.${m.next ? ` Next: ${clip(m.next)}` : ''}`;
const answerLine = (q: QueryView) => `${q.kind} ${q.id} on ${q.address}, ${quote(q.question)}: ${q.answered_by ?? 'someone'} answered ${quote(q.answer ?? '')}`;
const openCounts = (b: InboxBody) =>
  `${plural(b.queries.length, 'open question or note', 'open questions and notes')}, ${plural(b.marks.length, 'open mark')}`;
const readHint = (uri: string, hasQueries: boolean, hasMarks: boolean) => {
  const tools = [hasQueries || !hasMarks ? 'konjir_list_queries' : '', hasMarks ? 'konjir_list_stale' : ''].filter(Boolean);
  return `Read ${uri}, or call ${tools.join(' and ')}, before acting.`;
};

export const isInbox = (b: unknown): b is InboxBody => !!b && typeof b === 'object' && 'layer' in b && Array.isArray((b as InboxBody).queries) && Array.isArray((b as InboxBody).marks);
export const isAnswers = (b: unknown): b is AnswersBody => !!b && typeof b === 'object' && 'actor' in b && Array.isArray((b as AnswersBody).queries);

/** A message ready to send: tag-safe content, and meta values without quotes or brackets. */
function finish(content: string, meta: Record<string, string>): ChannelMessage {
  return {
    content: escapeTags(content),
    meta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.replace(/["<>&]/g, '')])),
  };
}

/**
 * The message for a change to `uri`, from its previous contents to its current
 * ones. Null when there is nothing new to act on.
 */
export function describeChange(uri: string, before: unknown, after: unknown): ChannelMessage | null {
  if (isInbox(after)) return inboxMessage(uri, isInbox(before) ? before : { layer: after.layer, queries: [], marks: [] }, after);
  if (isAnswers(after)) return answersMessage(uri, isAnswers(before) ? before : { actor: after.actor, queries: [] }, after);
  return finish(`Kolab changed ${uri}. Read that resource to see what changed.`, { uri, kind: 'unknown' });
}

function inboxMessage(uri: string, before: InboxBody, after: InboxBody): ChannelMessage | null {
  const seenQ = new Set(before.queries.map((q) => q.id));
  const seenM = new Set(before.marks.map((m) => m.mark));
  const newQ = after.queries.filter((q) => !seenQ.has(q.id));
  const newM = after.marks.filter((m) => !seenM.has(m.mark));
  if (!newQ.length && !newM.length) return null;

  const lines = [`Your ${after.layer} inbox changed: ${openCounts(after)}.`];
  if (newQ.length) lines.push(`New ${newQ.length === 1 ? 'item' : 'items'} for your layer:`, ...listed(newQ, queryLine));
  if (newM.length) lines.push(`New ${newM.length === 1 ? 'mark' : 'marks'} on your work:`, ...listed(newM, markLine));
  lines.push(readHint(uri, newQ.length > 0, newM.length > 0));
  return finish(lines.join('\n'), {
    uri, kind: 'inbox', layer: after.layer,
    open_queries: String(after.queries.length), open_marks: String(after.marks.length),
  });
}

function answersMessage(uri: string, before: AnswersBody, after: AnswersBody): ChannelMessage | null {
  const old = new Map(before.queries.map((q) => [q.id, q]));
  const answered = after.queries.filter((q) => q.answer != null && old.get(q.id)?.answer !== q.answer);
  if (!answered.length) return null;
  const lines = [`${answered.length === 1 ? 'An answer has' : `${answered.length} answers have`} come back to what you raised:`];
  lines.push(...listed(answered, answerLine));
  lines.push(`Read ${uri}, or call konjir_list_queries, for the full replies.`);
  return finish(lines.join('\n'), { uri, kind: 'answers', actor: after.actor, answered: String(answered.length) });
}

/**
 * The one message a session gets when the bridge first reads its resources:
 * the work already waiting in its inbox. Null when the inbox is empty. Answers
 * that came back before the session started are history, so they aren't listed;
 * the answers resource is named so Claude knows where they are.
 */
export function describeStartup(bodies: { uri: string; body: unknown }[]): ChannelMessage | null {
  const inbox = bodies.find((b) => isInbox(b.body)) as { uri: string; body: InboxBody } | undefined;
  const answers = bodies.find((b) => isAnswers(b.body)) as { uri: string; body: AnswersBody } | undefined;
  if (!inbox || (!inbox.body.queries.length && !inbox.body.marks.length)) return null;
  const b = inbox.body;
  const lines = [`Your ${b.layer} inbox already holds ${openCounts(b)}:`];
  lines.push(...listed(b.queries, queryLine), ...listed(b.marks, markLine));
  lines.push(readHint(inbox.uri, b.queries.length > 0, b.marks.length > 0));
  if (answers) lines.push(`Answers to what you raised are at ${answers.uri}.`);
  return finish(lines.join('\n'), {
    uri: inbox.uri, kind: 'inbox', initial: 'true', layer: b.layer,
    open_queries: String(b.queries.length), open_marks: String(b.marks.length),
  });
}
