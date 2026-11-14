import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WebCase, WebCasesView, WebMarksView, WebMe, WebOverview, WebPaged, WebQueriesView, WebQuery, WebReviewsView, WebRulingsView, WebWorkView, WorkDate } from '@konjir/types';
import { api, pushed } from '../api.js';
import { addr, ago, parseKj, routeOf } from '../util.js';
import { Pill, useHref } from './bits.js';
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
  return parts.map((p, i) => (i % 2 ? <RulingLink key={i} name={p} /> : <Fragment key={i}>{p}</Fragment>));
}
function RulingLink({ name }: { name: string }) {
  return <a className="ref" href={useHref()(`rulings/${name}`)}>{name}</a>;
}

/**
 * The items of a list that `keep` keeps, read page after page until there are `want` of them or
 * the list ends, at most `cap` pages: a section filtered in the page shows what its count counts,
 * not just what the first page held. Re-read whenever `tick` moves.
 */
function useKept<T extends WebPaged, I>(path: string, tick: number, items: (p: T) => I[], keep: (i: I) => boolean, want: number, cap = 20) {
  const [out, setOut] = useState<{ items: I[]; error?: string }>();
  const last = useRef<{ key: string; tick: number }>(undefined);
  useEffect(() => {
    let live = true;
    const push = pushed(last, path, tick);
    (async () => {
      const kept: I[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < cap; n++) {
        const p: T = await api<T>(cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path, undefined, undefined, { push });
        kept.push(...items(p).filter(keep));
        cursor = p.next;
        if (!cursor || kept.length >= want) break;
      }
      return kept;
    })().then((k) => { if (live) setOut({ items: k }); }, (e: Error) => { if (live) setOut({ items: [], error: e.message }); });
    return () => { live = false; };
    // `items` and `keep` are fixed per call site; the list is read again when its path, the tick or the count moves.
  }, [path, tick, want]);
  return out;
}

/**
 * A work package's start or finish (WRK9), on the reader's own calendar: an actual date plainly; a
 * forecast muted, with the word "forecast" and what it rests on written after it, for a phone and a
 * screen reader too; no forecast, with the reason.
 */
function DateOf({ label, d }: { label: string; d: WorkDate }) {
  if (d.kind === 'no_forecast') return <span className="date none">{label}: no forecast ({d.reason})</span>;
  const t = new Date(d.at);
  const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (d.kind === 'actual') return <span className="date actual">{label} {day}</span>;
  const b = d.basis;
  const why = 'size' in b ? `median of ${b.durations} finished ${b.size} in the ${b.from}${b.via ? `, after ${b.via}` : ''}` : `after ${b.via}`;
  return <span className="date forecast">{label} {day} <em>forecast</em> <span className="basis">({why})</span></span>;
}

/** Where an address opens in the page, or undefined for text that isn't one. */
const routeTo = (address: string, here: string) => { const a = parseKj(address); return a ? routeOf(a, here) : undefined; };

/** One item of the inbox: what it is, where, and a line of why; the whole row opens it. */
function Item({ pill, where, text, at, href }: { pill: ReactNode; where: string; text: string; at?: string; href?: string }) {
  const link = useHref();
  return (
    <li className="inbox-item">
      {pill}
      {href ? <a href={link(href)} className="addr">{where}</a> : <span className="addr">{where}</span>}
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
  const c = overview.counts;
  const belongs = me.access.layers.length > 0;
  // Each list holds every layer's: kept to the person's own, read until it holds what the count counts.
  const onMyLayer = (x: { layer: string }) => x.layer === me.layer;
  const queries = useKept<WebQueriesView, WebQuery>('queries?state=open', tick, (p) => p.queries, onMyLayer, c.waiting);
  const marks = useKept<WebMarksView, WebMarksView['marks'][number]>('marks', tick, (p) => p.marks, onMyLayer, c.stale);
  const cases = useKept<WebCasesView, WebCase>('cases?state=open', tick, (p) => p.cases, onMyLayer, belongs ? c.cases : 0);
  const forMe = reviews.pages?.flatMap((p) => p.for_me) ?? [];
  const waiting = queries?.items ?? [];
  const myMarks = marks?.items ?? [];
  const open = cases?.items ?? [];
  const total = c.reviews + c.waiting + c.stale + c.cases;
  const section = (id: string, title: string, count: number, empty: string, body: ReactNode[], more?: () => void, busy?: boolean, error?: string, reading = false) => (
    <section aria-labelledby={id} className="inbox-section">
      <h2 className="section-title" id={id}>{title} <span className="count-word">{count}</span></h2>
      {error ? <p className="empty" role="alert">{error}</p> : body.length === 0 ? <p className="empty">{reading ? 'Reading…' : count === 0 ? empty : `${empty} It was settled since the count was taken.`}</p> : <ul className="inbox">{body}</ul>}
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
          ? <Item key={r.subject} pill={<span className="kind">review</span>} where={r.subject} text={`submitted by ${r.author}${r.product_review ? ', for a product review' : ''}`} at={r.at} href={`node/${r.node}@${r.seq}`} />
          : <Item key={r.subject} pill={<span className="kind">work</span>} where={r.subject} text={`${r.title ?? ''} · by ${r.assignee}`} at={r.at} href="reviews" />),
        reviews.more, reviews.busy, reviews.error, !reviews.pages)}
      {section('in-questions', `Questions ${me.role} answers`, c.waiting, 'No question waits on your layer.',
        waiting.map((q) => <Item key={q.id} pill={<span className="kind">{q.kind}</span>} where={q.address} text={q.question} at={q.at} href={routeTo(q.address, me.kolab)} />),
        undefined, false, queries?.error, !queries)}
      {section('in-marks', 'Marks on your layer', c.stale, 'Nothing on your layer is marked: everything it relies on still holds.',
        myMarks.map((m) => <Item key={m.id} pill={<Pill tone="stale">{m.reason.replace(/_/g, ' ')}</Pill>} where={addr(m.node, m.seq, m.element)} text={m.because} at={m.at} href={`node/${m.node}${m.element ? `#${m.element}` : ''}`} />),
        undefined, false, marks?.error, !marks)}
      {belongs && section('in-cases', 'Case files on your layer', c.cases, 'No case file is open on your layer.',
        open.map((x) => <Item key={x.case} pill={<span className="kind">case file</span>} where={x.on} text={x.question ?? 'a case file'} at={x.opened_at ?? undefined} href="cases" />),
        undefined, false, cases?.error, !cases)}
      <p className="why-not">The spec and each binding are in the rail. <button type="button" className="btn quiet" onClick={() => go('work')}>See the work board</button></p>
    </>
  );
}

const STATES: { state: WorkItem['state']; label: string }[] = [
  { state: 'todo', label: 'To do' }, { state: 'in_progress', label: 'In progress' }, { state: 'in_review', label: 'In review' }, { state: 'done', label: 'Done' },
];
type WorkFilter = 'all' | 'ready' | 'blocked' | 'at_risk' | 'mine';
type WorkItem = WebWorkView['work'][number];
const FILTERS: { key: WorkFilter; label: string; test(w: WorkItem): boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'ready', label: 'Ready', test: (w) => w.ready },
  { key: 'blocked', label: 'Blocked', test: (w) => w.blocked.length > 0 && !w.milestone && w.state !== 'done' },
  { key: 'at_risk', label: 'At risk', test: (w) => !!w.at_risk },
  { key: 'mine', label: 'Held by me or my agents', test: (w) => w.yours },
];

/** Why a package is blocked, in words (PLN19). */
const blockWord = (w: WorkItem) => w.blocked.map((b) => (b.reason === 'depends_on' ? `${b.work.split('#')[1]} isn’t done` : b.reason === 'question' ? `a question on ${b.on}` : `a case file on ${b.on}`)).join(', ');

/**
 * The work board (PLN12, PLN19): each binding's work packages by state, as on an agile board, with
 * which are blocked and why, which are at risk, and who holds each. Agents pull work through MCP or
 * konjir work; the board only shows it.
 */
export function WorkView({ me, tick, go }: { me: WebMe; tick: number; go(r: string): void }) {
  const href = useHref();
  const read = usePaged<WebWorkView>('work?limit=200', tick);
  const [filter, setFilter] = useState<WorkFilter>('all');
  if (read.error) return <p className="empty" role="alert">{read.error}</p>;
  if (!read.pages) return <p className="empty">Reading the work…</p>;
  const all = read.pages.flatMap((p) => p.work).filter((w) => !w.removed_in);
  const test = FILTERS.find((f) => f.key === filter)!.test;
  const shown = all.filter(test);
  const bindings = [...new Set(all.map((w) => w.binding))];
  const done = all.filter((w) => w.state === 'done' && !w.milestone).length;
  const real = all.filter((w) => !w.milestone).length;
  return (
    <>
      <section className="summary" aria-label="Summary">
        <h1>Work</h1>
        <span className="fact"><b>{done}</b> of {real} work package{real === 1 ? '' : 's'} done</span>
        <span className="fact"><b>{all.filter((w) => w.ready).length}</b> ready</span>
        <span className="fact"><b>{all.filter(FILTERS[2].test).length}</b> blocked</span>
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
            <h2 className="section-title" id={`wb-${b}`}><a href={href(`node/${b}`)}>{addr(b)}</a></h2>
            <div className="board">
              {STATES.map((s) => {
                const col = mine.filter((w) => w.state === s.state);
                return (
                  <section key={s.state} className="column" aria-label={`${s.label}, ${col.length}`}>
                    <h3>{s.label} <span className="count-word">{col.length}</span></h3>
                    <ul>
                      {col.map((w) => (
                        <li key={w.work} className={`card${w.at_risk ? ' risk' : ''}`}>
                          <a href={href(`node/${w.binding}#${w.id}`)} className="card-id">{w.id}</a>
                          <span className="card-text">{w.text.split('\n')[0]}</span>
                          <span className="card-facts">
                            {w.milestone && <span className="kind">milestone</span>}
                            {w.ready && <Pill tone="clean">ready</Pill>}
                            {w.at_risk && <Pill tone="stale">at risk</Pill>}
                            {w.approved && <Pill tone="clean">approved, to release</Pill>}
                            {w.found_built && <Pill tone="clean">found built</Pill>}
                            {w.size && <span>{w.size}</span>}
                            {w.assignee && <span>{w.assignee}</span>}
                          </span>
                          {w.blocked.length > 0 && !w.milestone && w.state !== 'done' && <span className="blocked">Blocked: {blockWord(w)}</span>}
                          {w.start && w.finish && <span className="card-dates"><DateOf label="start" d={w.start} /> <DateOf label="finish" d={w.finish} /></span>}
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
  // A ruling named in the address is read by its name, however old; otherwise the newest, to search.
  // Rulings are named in capitals (D104): a hand-typed #/rulings/d104 finds the same one.
  const ref = focus && /^d\d+$/i.test(focus) ? focus.toUpperCase() : focus;
  const read = usePaged<WebRulingsView>(ref ? `rulings?ref=${encodeURIComponent(ref)}` : 'rulings?limit=200', tick);
  const [q, setQ] = useState(focus ?? '');
  // The search shows the ruling the address names; leaving it clears the search, unless the person is typing one of their own.
  const shownRef = useRef(ref);
  useEffect(() => { setQ((was) => (ref ? ref : was === shownRef.current ? '' : was)); shownRef.current = ref; }, [ref]);
  const belongs = me.access.layers.length > 0;
  useEffect(() => {
    if (focus && read.pages) // The route takes only a name of letters, digits, '.', '_' and '-', so it is safe in a selector.
      document.querySelector(`[data-ref="${focus}"]`)?.scrollIntoView?.({ block: 'start' });
  }, [focus, read.pages]);
  // Rulings belong to the kolab's work (D49): a reader who holds only Read sees none, and is told why.
  if (!belongs) return <p className="empty">Rulings belong to this kolab’s work: only those with Write on a layer of it see them (D49). You hold {me.access.level ?? 'no access'} here.</p>;
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
      <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (/^d\d+$/i.test(q.trim())) go(`rulings/${q.trim().toUpperCase()}`); else if (focus) go('rulings'); }}>
        <label htmlFor="r-search">Search the rulings</label>
        <input id="r-search" type="search" value={q} onChange={(e) => { setQ(e.target.value); if (ref && e.target.value !== ref) go('rulings'); }} autoComplete="off" aria-describedby="r-count" />
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
