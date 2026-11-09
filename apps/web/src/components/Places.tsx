import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { WebCasesView, WebMarksView, WebMe, WebOverview, WebQueriesView, WebReviewsView, WebRulingsView, WorkItemView, WebWorkView } from '@konjir/types';
import { addr, ago, parseKj, routeOf } from '../util.js';
import { Pill } from './bits.js';
import { RulingBox } from './Cases.js';
import { PolicySettings } from './Onboarding.js';
import { More, usePaged } from './Pages.js';
import type { Act } from './Marks.js';

/**
 * The places the web page's audit of 2026-11-08 asked for: the person's inbox as home, the work
 * board, the rulings as precedent to search, and the kolab's settings apart from its people.
 */

/** A ruling's own name, as elements cite it in their text ("Source: D12, D47"). */
const RULING_REF = /\b(D\d{1,4})\b/g;

/** Element text with each ruling it cites made a link to that ruling. */
export function withRulingLinks(text: string): ReactNode {
  const parts = text.split(RULING_REF);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 ? <a key={i} className="ref" href={`#/rulings/${p}`}>{p}</a> : <Fragment key={i}>{p}</Fragment>));
}

/** Where an address opens in the page, or undefined for text that isn't one. */
const routeTo = (address: string, here: string) => { const a = parseKj(address); return a ? routeOf(a, here) : undefined; };

/** One item of the inbox: what it is, where, and a line of why; the whole row opens it. */
function Item({ pill, where, text, at, href }: { pill: ReactNode; where: string; text: string; at?: string; href?: string }) {
  return (
    <li className="inbox-item">
      {pill}
      {href ? <a href={`#/${href}`} className="addr">{where}</a> : <span className="addr">{where}</span>}
      <span className="inbox-text">{text}</span>
      {at && <time dateTime={at}>{ago(at)}</time>}
    </li>
  );
}

/**
 * Home: what waits on the person, in the kolab and role they work in (Q6, AUT6). Reviews for their
 * verdict, questions their layer owns, marks on their layer, and case files open on it, each with
 * its count, and each opening where it can be acted on.
 */
export function InboxView({ me, overview, tick, go }: { me: WebMe; overview: WebOverview; tick: number; go(r: string): void }) {
  const reviews = usePaged<WebReviewsView>('reviews', tick);
  const queries = usePaged<WebQueriesView>('queries?state=open', tick);
  const marks = usePaged<WebMarksView>('marks', tick);
  const belongs = me.access.layers.length > 0;
  const cases = usePaged<WebCasesView>(belongs ? 'cases?state=open' : 'cases?state=open&mine=true', tick);
  const forMe = reviews.pages?.flatMap((p) => p.for_me) ?? [];
  const waiting = (queries.pages?.flatMap((p) => p.queries) ?? []).filter((q) => q.layer === me.layer);
  const myMarks = marks.pages?.flatMap((p) => p.marks) ?? [];
  const open = (cases.pages?.flatMap((p) => p.cases) ?? []).filter((c) => c.layer === me.layer);
  const c = overview.counts;
  const total = c.reviews + c.waiting + c.stale + c.cases;
  const section = (id: string, title: string, count: number, empty: string, body: ReactNode, more?: () => void, busy?: boolean, error?: string) => (
    <section aria-labelledby={id} className="inbox-section">
      <h2 className="section-title" id={id}>{title} <span className="count-word">{count}</span></h2>
      {error ? <p className="empty" role="alert">{error}</p> : count === 0 ? <p className="empty">{empty}</p> : <ul className="inbox">{body}</ul>}
      <More more={more} busy={!!busy} what={title.toLowerCase()} />
    </section>
  );
  return (
    <>
      <section className="summary" aria-label="Summary">
        <h1>{total ? `${total} thing${total === 1 ? '' : 's'} wait${total === 1 ? 's' : ''} on you` : 'Nothing waits on you'}</h1>
        <span className="fact">In {overview.kolab.title || me.kolab}, working as {me.role}: what only your layer can settle. Agents do the rest.</span>
      </section>
      {section('in-reviews', 'Reviews for you', c.reviews, 'No version or work package waits for your verdict.',
        forMe.map((r) => r.kind === 'version'
          ? <Item key={r.subject} pill={<Pill tone="question">review</Pill>} where={r.subject} text={`submitted by ${r.author}${r.product_review ? ', for a product review' : ''}`} at={r.at} href={`node/${r.node}@${r.seq}`} />
          : <Item key={r.subject} pill={<Pill tone="question">work</Pill>} where={r.subject} text={`${r.title ?? ''} · by ${r.assignee}`} at={r.at} href="reviews" />),
        reviews.more, reviews.busy, reviews.error)}
      {section('in-questions', `Questions ${me.role} answers`, c.waiting, 'No question waits on your layer.',
        waiting.map((q) => <Item key={q.id} pill={<Pill tone="question">{q.kind}</Pill>} where={q.address} text={q.question} at={q.at} href={routeTo(q.address, me.kolab)} />),
        queries.more, queries.busy, queries.error)}
      {section('in-marks', 'Marks on your layer', c.stale, 'Nothing on your layer is marked: everything it relies on still holds.',
        myMarks.map((m) => <Item key={m.id} pill={<Pill tone="stale">{m.reason.replace(/_/g, ' ')}</Pill>} where={addr(m.node, m.seq, m.element)} text={m.because} at={m.at} href={`node/${m.node}${m.element ? `#${m.element}` : ''}`} />),
        marks.more, marks.busy, marks.error)}
      {belongs && section('in-cases', 'Case files on your layer', c.cases, 'No case file is open on your layer.',
        open.map((x) => <Item key={x.case} pill={<Pill tone="boundary">case file</Pill>} where={x.on} text={x.question ?? 'a case file'} at={x.opened_at ?? undefined} href="cases" />),
        cases.more, cases.busy, cases.error)}
      <p className="why-not">The spec and each binding are in the rail. <button type="button" className="btn quiet" onClick={() => go('work')}>See the work board</button></p>
    </>
  );
}

const STATES: { state: WorkItemView['state']; label: string }[] = [
  { state: 'todo', label: 'To do' }, { state: 'in_progress', label: 'In progress' }, { state: 'in_review', label: 'In review' }, { state: 'done', label: 'Done' },
];
type WorkFilter = 'all' | 'ready' | 'blocked' | 'at_risk' | 'mine';
const FILTERS: { key: WorkFilter; label: string; test(w: WorkItemView, me: WebMe): boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'ready', label: 'Ready', test: (w) => w.ready },
  { key: 'blocked', label: 'Blocked', test: (w) => w.blocked.length > 0 && !w.milestone && w.state !== 'done' },
  { key: 'at_risk', label: 'At risk', test: (w) => !!w.at_risk },
  { key: 'mine', label: 'Held by me or my agents', test: (w, me) => !!w.assignee && (w.assignee === me.actor || w.assignee.startsWith(`${me.actor}-`)) },
];

/** Why a package is blocked, in words (PLN19). */
const blockWord = (w: WorkItemView) => w.blocked.map((b) => (b.reason === 'depends_on' ? `${b.work.split('#')[1]} isn’t done` : b.reason === 'question' ? `a question on ${b.on}` : `a case file on ${b.on}`)).join(', ');

/**
 * The work board (PLN12, PLN19): each binding's work packages by state, as on an agile board, with
 * which are blocked and why, which are at risk, and who holds each. Agents pull work through MCP or
 * konjir work; the board only shows it.
 */
export function WorkView({ me, tick, go }: { me: WebMe; tick: number; go(r: string): void }) {
  const read = usePaged<WebWorkView>('work?limit=200', tick);
  const [filter, setFilter] = useState<WorkFilter>('all');
  if (read.error) return <p className="empty" role="alert">{read.error}</p>;
  if (!read.pages) return <p className="empty">Reading the work…</p>;
  const all = read.pages.flatMap((p) => p.work).filter((w) => !w.removed_in);
  const test = FILTERS.find((f) => f.key === filter)!.test;
  const shown = all.filter((w) => test(w, me));
  const bindings = [...new Set(all.map((w) => w.binding))];
  const done = all.filter((w) => w.state === 'done' && !w.milestone).length;
  const real = all.filter((w) => !w.milestone).length;
  return (
    <>
      <section className="summary" aria-label="Summary">
        <h1>Work</h1>
        <span className="fact"><b>{done}</b> of {real} work package{real === 1 ? '' : 's'} done</span>
        <span className="fact"><b>{all.filter((w) => w.ready).length}</b> ready</span>
        <span className="fact"><b>{all.filter((w) => FILTERS[2].test(w, me)).length}</b> blocked</span>
        <span className="fact"><b>{all.filter((w) => w.at_risk).length}</b> at risk</span>
      </section>
      <div className="seg filters" role="radiogroup" aria-label="Show">
        {FILTERS.map((f) => <button key={f.key} type="button" role="radio" aria-checked={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>)}
      </div>
      {!all.length && <p className="empty">No work is planned yet. A work package is a binding element with a work field: plan it in the binding.</p>}
      {bindings.map((b) => {
        const mine = shown.filter((w) => w.binding === b);
        return (
          <section key={b} aria-labelledby={`wb-${b}`}>
            <h2 className="section-title" id={`wb-${b}`}><a href={`#/node/${b}`}>{addr(b)}</a></h2>
            <div className="board">
              {STATES.map((s) => {
                const col = mine.filter((w) => w.state === s.state);
                return (
                  <section key={s.state} className="column" aria-label={`${s.label}, ${col.length}`}>
                    <h3>{s.label} <span className="count-word">{col.length}</span></h3>
                    <ul>
                      {col.map((w) => (
                        <li key={w.work} className={`card${w.at_risk ? ' risk' : ''}`}>
                          <a href={`#/node/${w.binding}#${w.id}`} className="card-id">{w.id}</a>
                          <span className="card-text">{w.text.split('\n')[0]}</span>
                          <span className="card-facts">
                            {w.milestone && <Pill tone="clean">milestone</Pill>}
                            {w.ready && <Pill tone="clean">ready</Pill>}
                            {w.at_risk && <Pill tone="stale">at risk</Pill>}
                            {w.approved && <Pill tone="clean">approved, to release</Pill>}
                            {w.size && <span>{w.size}</span>}
                            {w.assignee && <span>{w.assignee}</span>}
                          </span>
                          {w.blocked.length > 0 && !w.milestone && w.state !== 'done' && <span className="blocked">Blocked: {blockWord(w)}</span>}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </section>
        );
      })}
      <More more={read.more} busy={read.busy} what="work packages" />
      <p className="why-not">Progress and forecasts per spec element come with W8.7 and W8.8. <button type="button" className="btn quiet" onClick={() => go('connect')}>Put a machine to work</button></p>
    </>
  );
}

/**
 * The rulings: precedent in this kolab (CASE4), newest first, searchable by their name and their
 * words. `focus` is a ruling's name from the address (#/rulings/D104), shown and scrolled to.
 */
export function RulingsView({ me, tick, go, focus }: { me: WebMe; tick: number; go(r: string): void; focus?: string }) {
  const read = usePaged<WebRulingsView>('rulings?limit=200', tick);
  const [q, setQ] = useState(focus ?? '');
  useEffect(() => { if (focus) setQ(focus); }, [focus]);
  useEffect(() => {
    if (focus && read.pages) // The route takes only a name of letters, digits, '.', '_' and '-', so it is safe in a selector.
      document.querySelector(`[data-ref="${focus}"]`)?.scrollIntoView?.({ block: 'start' });
  }, [focus, read.pages]);
  if (read.error) return <p className="empty" role="alert">{read.error}</p>;
  if (!read.pages) return <p className="empty">Reading the rulings…</p>;
  const all = read.pages.flatMap((p) => p.rulings);
  const words = q.trim().toLowerCase();
  const exact = /^d\d+$/i.test(words);
  const shown = !words ? all : all.filter((r) => exact ? r.ref?.toLowerCase() === words : `${r.ref ?? ''} ${r.text} ${r.on}`.toLowerCase().includes(words));
  return (
    <>
      <section className="summary" aria-label="Summary">
        <h1>Rulings</h1>
        <span className="fact">Precedent in {me.kolab}, newest first: agents are served it, so a settled question isn’t argued again.</span>
      </section>
      <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (/^d\d+$/i.test(q.trim())) go(`rulings/${q.trim().toUpperCase()}`); }}>
        <label htmlFor="r-search">Search the rulings</label>
        <input id="r-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" aria-describedby="r-count" />
        <span id="r-count" className="hint" role="status">{words ? `${shown.length} of ${all.length}${read.more ? '+' : ''} match` : `${all.length}${read.more ? '+' : ''} rulings`}. A name such as D104 finds that ruling.</span>
      </form>
      {shown.length ? <ul className="qlist">{shown.map((r) => <li key={r.ruling} className="qitem" data-ref={r.ref ?? undefined}><RulingBox ruling={r} me={me} go={go} /></li>)}</ul>
        : <p className="empty">{words ? `No ruling ${exact ? 'is called' : 'mentions'} “${q.trim()}”${read.more ? ' among those read: read more below' : ''}.` : 'No rulings yet.'}</p>}
      <More more={read.more} busy={read.busy} what="rulings" />
    </>
  );
}

/** The kolab's settings, apart from its people: how far agents act without a person (AUT1). */
export function SettingsView({ me, tick, act }: { me: WebMe; tick: number; act: Act }) {
  return (
    <>
      <section className="summary" aria-label="Summary"><h1>Settings</h1>
        <span className="fact">{me.access.level === 'admin' ? `The policy of ${me.kolab}: only its Admins change it.` : `Only ${me.kolab}’s Admins read and change its policy; you hold ${me.access.level ?? 'no access'}.`}</span></section>
      {me.access.level === 'admin' && <PolicySettings me={me} tick={tick} act={act} />}
    </>
  );
}
