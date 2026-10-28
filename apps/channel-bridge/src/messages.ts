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

/** A review request for this session, as Kolab's inbox resource serves it. */
export interface ReviewView { request: string; subject: string; author: string; next?: string }
/** A version this session submitted, with its verdicts, as Kolab's answers resource serves it. */
export interface SubmissionView { subject: string; state: string; note: string | null; next?: string }

/** A case file, as Kolab's inbox and answers resources serve it (CASE1, CASE2). */
export interface CaseView {
  case: string; on: string; question: string | null; state: string; positions: { actor: string }[];
  ruling: { text: string; effect: string | null; ruled_by: string } | null; next?: string;
}

/** Each body names its kolab since D50; a Kolab from before that leaves it out. */
export type InboxBody = { kolab?: string; layer: string; queries: QueryView[]; marks: MarkView[]; reviews?: ReviewView[]; cases?: CaseView[] };
/** A change others made to this session's work, as Kolab's answers resource serves it (W5.1b, W5.1c). */
export interface WorkNoticeView { id: string; work: string; kind: string; actor: string; note: string | null }
export type AnswersBody = {
  kolab?: string; actor: string; queries: QueryView[]; submissions?: SubmissionView[]; cases?: CaseView[];
  work?: { events?: WorkNoticeView[] };
};

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
const reviewLine = (r: ReviewView) => `review ${r.subject}, by ${r.author}.${r.next ? ` Next: ${clip(r.next)}` : ''}`;
const verdictLine = (v: SubmissionView) => `${v.subject} is ${v.state.replace('_', ' ')}${v.note ? `: ${quote(v.note)}` : ''}`;
const caseLine = (c: CaseView) => `case ${c.case} on ${c.on}${c.question ? `: ${quote(c.question)}` : ''} (${plural(c.positions.length, 'position')}).${c.next ? ` Next: ${clip(c.next)}` : ''}`;
/** What happened to a work package, in words: approved, changes requested, lapsed… */
const WORK_WORDS: Record<string, string> = {
  approved: 'was approved: it is Done',
  changes_requested: 'came back with changes requested: it is In progress for you again, with a fresh lease',
  lapsed: 'lapsed: no call of yours renewed its lease, so it is To do again',
  reassigned: 'was reassigned', released: 'was given back by Kolab', removed: 'was removed from its plan',
  reopened: 'was reopened: it is To do again', confirmed: 'was confirmed: its work holds',
};
const workLine = (e: WorkNoticeView) => `${e.work} ${WORK_WORDS[e.kind] ?? e.kind.replace(/_/g, ' ')}, by ${e.actor}${e.note ? `: ${quote(e.note)}` : ''}`;
const workOf = (b: AnswersBody) => b.work?.events ?? [];
const rulingLine =(c: CaseView) => `case ${c.case} on ${c.on}: ${c.ruling?.ruled_by ?? 'someone'} ruled ${quote(c.ruling?.text ?? '')}${c.ruling?.effect ? ` (${c.ruling.effect === 'change_intent' ? 'the intent changes' : 'the intent stands; find another way'})` : ''}`;
const reviewsOf = (b: InboxBody) => b.reviews ?? [];
/** Where an inbox is, in a message: its layer, and its kolab when Kolab names it. */
const inboxName = (b: InboxBody) => `${b.layer} inbox${b.kolab ? ` in ${b.kolab}` : ''}`;
const kolabMeta = (b: { kolab?: string }): Record<string, string> => (typeof b.kolab === 'string' ? { kolab: b.kolab } : {});
const casesOf = (b: { cases?: CaseView[] }) => b.cases ?? [];
const openCounts = (b: InboxBody) =>
  `${plural(b.queries.length, 'open question or note', 'open questions and notes')}, ${plural(b.marks.length, 'open mark')}`
  + (reviewsOf(b).length ? `, ${plural(reviewsOf(b).length, 'review request')} for you` : '')
  + (casesOf(b).length ? `, ${plural(casesOf(b).length, 'open case file')}` : '');
const readHint = (uri: string, hasQueries: boolean, hasMarks: boolean, hasReviews = false, hasCases = false) => {
  const tools = [hasQueries || (!hasMarks && !hasReviews && !hasCases) ? 'konjir_list_queries' : '', hasMarks ? 'konjir_list_stale' : '', hasReviews ? 'konjir_list_reviews' : '', hasCases ? 'konjir_list_cases' : ''].filter(Boolean);
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
  const seenR = new Set(reviewsOf(before).map((r) => r.request));
  // A case file is new to the inbox when it first appears, and again when it gains its second position: then it waits for a ruling.
  const seenC = new Map(casesOf(before).map((c) => [c.case, c.positions.length]));
  const newQ = after.queries.filter((q) => !seenQ.has(q.id));
  const newM = after.marks.filter((m) => !seenM.has(m.mark));
  const newR = reviewsOf(after).filter((r) => !seenR.has(r.request));
  const newC = casesOf(after).filter((c) => seenC.get(c.case) !== c.positions.length);
  if (!newQ.length && !newM.length && !newR.length && !newC.length) return null;

  const lines = [`Your ${inboxName(after)} changed: ${openCounts(after)}.`];
  if (newR.length) lines.push(`New ${newR.length === 1 ? 'review request' : 'review requests'} for you:`, ...listed(newR, reviewLine));
  if (newC.length) lines.push(`${newC.length === 1 ? 'A case file' : 'Case files'} on your layer, new or argued:`, ...listed(newC, caseLine));
  if (newQ.length) lines.push(`New ${newQ.length === 1 ? 'item' : 'items'} for your layer:`, ...listed(newQ, queryLine));
  if (newM.length) lines.push(`New ${newM.length === 1 ? 'mark' : 'marks'} on your work:`, ...listed(newM, markLine));
  lines.push(readHint(uri, newQ.length > 0, newM.length > 0, newR.length > 0, newC.length > 0));
  return finish(lines.join('\n'), {
    uri, kind: 'inbox', ...kolabMeta(after), layer: after.layer,
    open_queries: String(after.queries.length), open_marks: String(after.marks.length),
    ...(reviewsOf(after).length ? { review_requests: String(reviewsOf(after).length) } : {}),
    ...(casesOf(after).length ? { open_cases: String(casesOf(after).length) } : {}),
  });
}

function answersMessage(uri: string, before: AnswersBody, after: AnswersBody): ChannelMessage | null {
  const old = new Map(before.queries.map((q) => [q.id, q]));
  const answered = after.queries.filter((q) => q.answer != null && old.get(q.id)?.answer !== q.answer);
  // A submission's verdict: it left review (committed, back to drafted, or rejected).
  const was = new Map((before.submissions ?? []).map((v) => [v.subject, v.state]));
  const decided = (after.submissions ?? []).filter((v) => v.state !== 'in_review' && was.has(v.subject) && was.get(v.subject) !== v.state);
  // A case file of yours: ruled on, or answered by the other side's position.
  const wasCase = new Map(casesOf(before).map((c) => [c.case, c]));
  const ruled = casesOf(after).filter((c) => c.ruling && !wasCase.get(c.case)?.ruling);
  const argued = casesOf(after).filter((c) => !c.ruling && wasCase.has(c.case) && wasCase.get(c.case)!.positions.length < c.positions.length);
  // A change others made to your work (W5.1c): a verdict on a package you submitted, a lapse, a reassignment.
  const seenW = new Set(workOf(before).map((e) => e.id));
  const worked = before.work ? workOf(after).filter((e) => !seenW.has(e.id)) : [];
  if (!answered.length && !decided.length && !ruled.length && !argued.length && !worked.length) return null;
  const lines: string[] = [];
  if (answered.length) {
    lines.push(`${answered.length === 1 ? 'An answer has' : `${answered.length} answers have`} come back to what you raised:`, ...listed(answered, answerLine));
    lines.push(`Read ${uri}, or call konjir_list_queries, for the full replies.`);
  }
  if (decided.length) {
    lines.push(`${decided.length === 1 ? 'A version you submitted has' : `${decided.length} versions you submitted have`} been reviewed:`, ...listed(decided, verdictLine));
    lines.push(`Read ${uri}, or call konjir_list_reviews, for the verdicts and what to do next.`);
  }
  if (ruled.length) {
    lines.push(`${ruled.length === 1 ? 'A case file of yours has' : `${ruled.length} case files of yours have`} been ruled on. A ruling is precedent: follow it, and don't argue it again.`, ...listed(ruled, rulingLine));
    lines.push(`Read ${uri}, or call konjir_read_case, for the verdict on each position.`);
  }
  if (argued.length) {
    lines.push(`The other side took a position on ${argued.length === 1 ? 'a case file' : `${argued.length} case files`} of yours; ${argued.length === 1 ? 'it waits' : 'they wait'} for a ruling:`, ...listed(argued, caseLine));
  }
  if (worked.length) {
    lines.push(`${worked.length === 1 ? 'A work package of yours has changed' : `${worked.length} changes to your work packages`}:`, ...listed(worked, workLine));
    lines.push(`Read ${uri}, or call konjir_read_work, for where it stands and what to do next.`);
  }
  return finish(lines.join('\n'), {
    uri, kind: 'answers', ...kolabMeta(after), actor: after.actor, answered: String(answered.length), ...(decided.length ? { reviewed: String(decided.length) } : {}),
    ...(ruled.length ? { ruled: String(ruled.length) } : {}), ...(worked.length ? { work: String(worked.length) } : {}),
  });
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
  if (!inbox || (!inbox.body.queries.length && !inbox.body.marks.length && !reviewsOf(inbox.body).length && !casesOf(inbox.body).length)) return null;
  const b = inbox.body;
  const lines = [`Your ${inboxName(b)} already holds ${openCounts(b)}:`];
  lines.push(...listed(reviewsOf(b), reviewLine), ...listed(casesOf(b), caseLine), ...listed(b.queries, queryLine), ...listed(b.marks, markLine));
  lines.push(readHint(inbox.uri, b.queries.length > 0, b.marks.length > 0, reviewsOf(b).length > 0, casesOf(b).length > 0));
  if (answers) lines.push(`Answers to what you raised are at ${answers.uri}.`);
  return finish(lines.join('\n'), {
    uri: inbox.uri, kind: 'inbox', initial: 'true', ...kolabMeta(b), layer: b.layer,
    open_queries: String(b.queries.length), open_marks: String(b.marks.length),
    ...(reviewsOf(b).length ? { review_requests: String(reviewsOf(b).length) } : {}),
    ...(casesOf(b).length ? { open_cases: String(casesOf(b).length) } : {}),
  });
}
