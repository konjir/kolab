import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  KINDS, LAYER_OF_KIND,
  type Kind, type WebActivityView, type WebForeignKolab, type WebLineageView, type WebMe, type WebOverview, type WebPaged, type WebQueriesView, type WebQuery, type WebReviewsView, type WebSignInMethods,
} from '@konjir/types';
import { api } from '../api.js';
import { addr, ago } from '../util.js';
import { Addr, Pill } from './bits.js';
import { QueryBox, type Act } from './Marks.js';

/** Re-reads `path` whenever `tick` moves. */
export function useRead<T>(path: string, tick: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api<T>(path).then((d) => { if (live) { setData(d); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [path, tick]);
  return { data, error };
}

/**
 * Reads a list a page at a time (W2.21): the first page, then each page `more` asks for, in order.
 * When `tick` moves, it reads again as many pages as were shown, following each page's next.
 */
export function usePaged<T extends WebPaged>(path: string, tick: number) {
  const [pages, setPages] = useState<{ path: string; pages: T[] }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const shown = useRef({ path, count: 1 });
  if (shown.current.path !== path) shown.current = { path, count: 1 };
  const url = (cursor: string | null) => (cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path);
  useEffect(() => {
    let live = true;
    (async () => {
      const out: T[] = [];
      let cursor: string | null = null;
      do {
        const p: T = await api<T>(url(cursor));
        out.push(p);
        cursor = p.next;
      } while (cursor && out.length < shown.current.count);
      return out;
    })().then((d) => { if (live) { setPages({ path, pages: d }); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [path, tick]);
  const current = pages?.path === path ? pages.pages : undefined;
  const next = current?.at(-1)?.next ?? null;
  const more = async () => {
    if (!current || !next || busy) return;
    setBusy(true);
    try {
      const p = await api<T>(url(next));
      shown.current.count = current.length + 1;
      setPages({ path, pages: [...current, p] });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { pages: current, error, more: next ? more : undefined, busy };
}

/**
 * The pages of a list after one already shown (W2.21): a node's older versions, or an element's
 * older questions, whose first page comes with the node. `first` is that page's next. `more` reads
 * the page after the last; when `tick` moves, it reads again as many pages as were shown.
 */
export function useMore<T extends WebPaged>(path: string, first: string | null | undefined, tick: number) {
  const [pages, setPages] = useState<{ key: string; pages: T[] }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const shown = useRef({ path, count: 0 });
  if (shown.current.path !== path) shown.current = { path, count: 0 };
  const key = `${path} ${first ?? ''}`;
  const url = (cursor: string) => `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
  useEffect(() => {
    if (!first || !shown.current.count) return undefined;
    let live = true;
    (async () => {
      const out: T[] = [];
      let cursor: string | null = first;
      while (cursor && out.length < shown.current.count) {
        const p: T = await api<T>(url(cursor));
        out.push(p);
        cursor = p.next;
      }
      return out;
    })().then((d) => { if (live) { setPages({ key, pages: d }); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [key, tick]);
  const current = pages?.key === key ? pages.pages : [];
  const next = current.length ? current[current.length - 1].next : first ?? null;
  const more = async () => {
    if (!next || busy) return;
    setBusy(true);
    try {
      const p = await api<T>(url(next));
      shown.current.count = current.length + 1;
      setPages({ key, pages: [...current, p] });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { pages: current, error, more: next ? more : undefined, busy };
}

/** The button that reads a list's next page, while it has one. */
export function More({ more, busy, what }: { more?: () => void; busy: boolean; what: string }) {
  if (!more) return null;
  return <div className="edit-row"><button type="button" className="btn" disabled={busy} onClick={more}>{busy ? 'Reading…' : `More ${what}`}</button></div>;
}

export function QuestionsView({ me, tick, act, go }: { me: WebMe; tick: number; act: Act; go(r: string): void }) {
  const openRead = usePaged<WebQueriesView>('queries?state=open', tick);
  const doneRead = usePaged<WebQueriesView>('queries?state=settled', tick);
  const error = openRead.error ?? doneRead.error;
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!openRead.pages || !doneRead.pages) return <p className="empty">Reading the questions…</p>;
  const open = openRead.pages.flatMap((p) => p.queries);
  const done = doneRead.pages.flatMap((p) => p.queries);
  const item = (q: WebQuery) => (
    <li key={q.id} className="qitem">
      <div className="row">
        <button type="button" className="chip" onClick={() => go(`node/${q.node}${q.element ? `#${q.element}` : ''}`)}>{q.address}</button>
        {q.state === 'open' && <span>{q.layer === me.layer ? 'Waiting on you' : `Waiting on the ${q.layer} layer`}</span>}
      </div>
      <QueryBox query={q} me={me} act={act} />
    </li>
  );
  return (
    <>
      <section aria-labelledby="q-open"><h2 className="section-title" id="q-open">Open</h2>
        {open.length ? <ul className="qlist">{open.map(item)}</ul> : <p className="empty">No open questions. When an agent can’t tell what you meant, its question lands here.</p>}
        <More more={openRead.more} busy={openRead.busy} what="open questions" />
      </section>
      <section aria-labelledby="q-done"><h2 className="section-title" id="q-done">Answered</h2>
        <p className="why-not" style={{ margin: '-6px 0 12px', maxWidth: '68ch' }}>Answers are served to every agent as precedent, so a settled question isn’t asked again.</p>
        {done.length ? <ul className="qlist">{done.map(item)}</ul> : <p className="empty">Nothing answered yet.</p>}
        <More more={doneRead.more} busy={doneRead.busy} what="answered questions" />
      </section>
    </>
  );
}

export function ReviewsView({ tick, go }: { tick: number; go(r: string): void }) {
  const { pages, error, more, busy } = usePaged<WebReviewsView>('reviews', tick);
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!pages) return <p className="empty">Reading the reviews…</p>;
  const data = { for_me: pages.flatMap((p) => p.for_me), mine: pages.flatMap((p) => p.mine) };
  return (
    <>
      <section aria-labelledby="r-mine"><h2 className="section-title" id="r-mine">Waiting for your review</h2>
        {data.for_me.length ? <ul className="qlist">{data.for_me.map((r) => (
          <li key={r.subject} className="qitem"><div className="row"><Pill tone="question">in review</Pill>
            <button type="button" className="chip" onClick={() => go(`node/${r.node}@${r.seq}`)}>{r.subject}</button>
            <span>by {r.author} · {ago(r.at)}</span></div></li>
        ))}</ul> : <p className="empty">Nothing waits for your review.</p>}
      </section>
      <section aria-labelledby="r-yours"><h2 className="section-title" id="r-yours">What you submitted</h2>
        {data.mine.length ? <ul className="qlist">{data.mine.map((r) => (
          <li key={r.subject} className="qitem">
            <div className="row"><Pill tone={r.state === 'committed' ? 'clean' : r.state === 'in_review' ? 'question' : 'boundary'}>{r.state.replace('_', ' ')}</Pill>
              <button type="button" className="chip" onClick={() => go(`node/${r.node}@${r.seq}`)}>{r.subject}</button></div>
            {r.verdicts.filter((v) => v.state !== 'open' && v.state !== 'withdrawn').map((v) => (
              <div key={v.reviewer} className="a"><span className="why-not">{v.reviewer} {v.state === 'approved' ? 'approved' : 'requested changes'}</span>{v.note ? <><br />{v.note}</> : null}</div>
            ))}
          </li>
        ))}</ul> : <p className="empty">You haven’t submitted anything for review in this kolab.</p>}
      </section>
      <More more={more} busy={busy} what="reviews" />
    </>
  );
}

export function ActivityView({ tick }: { tick: number }) {
  const { pages, error, more, busy } = usePaged<WebActivityView>('activity', tick);
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!pages) return <p className="empty">Reading the activity…</p>;
  const data = { items: pages.flatMap((p) => p.items) };
  return (
    <section aria-labelledby="act-title"><h2 className="section-title" id="act-title">Activity</h2>
      <p className="why-not" style={{ margin: '-6px 0 12px', maxWidth: '68ch' }}>From what Kolab records: nodes as they were made, versions as they were written, verdicts, questions and marks, each with who made it.</p>
      <ol className="log">{data.items.map((l, i) => (
        <li key={i}><time dateTime={l.at}>{ago(l.at)}</time><span><span className="actor">{l.actor}</span> {l.text.split(/(kj:[^\s·:]+)/).map((part, j) => part.startsWith('kj:') ? <Addr key={j}>{part}</Addr> : part)}</span></li>
      ))}</ol>
      <More more={more} busy={busy} what="activity" />
    </section>
  );
}

/** What depends on what: each wire a link from an element to what it relies on, pinned to the version it was checked against. */
export function LineageView({ tick, go }: { tick: number; go(r: string): void }) {
  const read = usePaged<WebLineageView>('lineage', tick);
  const { error } = read;
  const data = read.pages && { nodes: read.pages.flatMap((p) => p.nodes), links: read.pages.flatMap((p) => p.links) };
  const [focus, setFocus] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; cls: string }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const layers = data ? [data.nodes.filter((n) => n.layer === 'functional'), data.nodes.filter((n) => n.layer === 'technical')] : [[], []];
  const key = (node: string, el: string | null) => `${node}#${el ?? ''}`;
  const related = new Set<string>();
  if (focus && data) {
    related.add(focus);
    for (const l of data.links) {
      const s = key(l.source.node, l.source.element), t = key(l.target.node, l.target.element);
      if (s === focus) related.add(t);
      if (t === focus) related.add(s);
    }
  }
  useLayoutEffect(() => {
    const draw = () => {
      const el = box.current;
      if (!el || !data) return;
      const b = el.getBoundingClientRect();
      setSize({ w: b.width, h: b.height });
      const out: { d: string; cls: string }[] = [];
      for (const l of data.links) {
        const s = el.querySelector<HTMLElement>(`[data-lin="${CSS.escape(key(l.source.node, l.source.element))}"]`);
        const t = el.querySelector<HTMLElement>(`[data-lin="${CSS.escape(key(l.target.node, l.target.element))}"]`);
        if (!s || !t) continue;
        const sr = s.getBoundingClientRect(), tr = t.getBoundingClientRect();
        const leftToRight = tr.left < sr.left;
        const x1 = (leftToRight ? tr.right : tr.left) - b.left, y1 = tr.top + tr.height / 2 - b.top;
        const x2 = (leftToRight ? sr.left : sr.right) - b.left, y2 = sr.top + sr.height / 2 - b.top;
        const mid = (x1 + x2) / 2;
        const on = focus && (related.has(key(l.source.node, l.source.element)) && related.has(key(l.target.node, l.target.element)));
        out.push({ d: `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`, cls: ['wire', l.mark ? 'stale' : '', on ? 'on' : '', focus && !on ? 'dim' : ''].join(' ') });
      }
      setPaths(out);
    };
    draw();
    if (typeof ResizeObserver === 'undefined' || !box.current) return;
    const ro = new ResizeObserver(draw);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [read.pages, focus]);
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!data) return <p className="empty">Reading the lineage…</p>;
  const stale = new Set(data.links.filter((l) => l.mark).map((l) => key(l.source.node, l.source.element)));
  const column = (nodes: WebLineageView['nodes'], label: string) => (
    <div className="lin-col">
      {nodes.length ? nodes.map((n) => (
        <div key={n.name} style={{ display: 'grid', gap: 6 }}>
          <h3>{label} · <button type="button" className="chip" onClick={() => go(`node/${n.name}`)}>{addr(n.name, n.seq)}</button></h3>
          {n.elements.map((e) => {
            const k = key(n.name, e.id);
            return (
              <button key={k} type="button" data-lin={k} aria-pressed={focus === k} onClick={() => setFocus(focus === k ? undefined : k)}
                className={`node${focus ? (related.has(k) ? ' on' : ' dim') : ''}${stale.has(k) ? ' is-stale' : ''}`}>
                <span className="nid">{e.id}{stale.has(k) && <Pill tone="stale">stale</Pill>}</span><span className="ntext">{e.text}</span>
              </button>
            );
          })}
        </div>
      )) : <p className="why-not">Nothing committed in this layer yet.</p>}
    </div>
  );
  return (
    <section aria-labelledby="lin-title">
      <h2 className="section-title" id="lin-title">What depends on what</h2>
      <p className="why-not" style={{ maxWidth: '68ch', margin: '0 0 18px' }}>Each wire is a link from an element to what it relies on, pinned to the version it was checked against. Select an element to see its wires.</p>
      <div className="lineage" ref={box}>
        {column(layers[0], 'Spec')}
        <div className="gutter" aria-hidden="true" />
        {column(layers[1], 'Binding')}
        <svg className="wires" aria-hidden="true" viewBox={`0 0 ${size.w || 1} ${size.h || 1}`}>{paths.map((p, i) => <path key={i} className={p.cls} d={p.d} />)}</svg>
      </div>
      <div className="lin-legend"><span><i className="swatch" />holds</span><span><i className="swatch stale" />stale: what it relies on changed since this link was checked</span></div>
      {read.more && <p className="why-not">A few documents at a time: a wire to one not shown yet appears once it is.</p>}
      <More more={read.more} busy={read.busy} what="documents" />
    </section>
  );
}

/** All kolabs the signed-in actor can reach. A session works in one; the others need a session of their own. */
export function KolabsView({ overview, act, onCreated, onOpen, onRead, onCreateKolab, start }: {
  /** An empty kolab's first page: only the form for its first document. */
  start?: boolean;
  overview: WebOverview; act: Act; onCreated(name: string): void; onOpen(kolab: string): void; onCreateKolab(name: string, title: string): Promise<boolean>;
  /** Reads another kolab's committed work in place, without leaving this session's kolab (D49). */
  onRead?(kolab: string): void;
}) {
  const [kTitle, setKTitle] = useState('');
  const [kName, setKName] = useState('');
  const [kTouched, setKTouched] = useState(false);
  const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const [kind, setKind] = useState<Kind>(overview.me.layer === 'functional' ? 'functional_spec' : 'technical_binding');
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const kinds = KINDS.filter((k) => LAYER_OF_KIND[k] === overview.me.layer);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run(() => api('nodes', { kind, title, name }), `Created ${addr(name)}`)) { onCreated(name); setTitle(''); setName(''); }
  };
  return (
    <>
      {!start && <>
      <section className="summary" aria-label="Kolabs">
        <h1>Kolabs</h1>
        <span className="fact">A kolab is one project with a hard edge. Its one spec, the bindings built on it, their links and questions stay inside it.</span>
      </section>
      <section aria-label="Your kolabs"><div className="kgrid">
        {overview.kolabs.map((k) => (
          <article key={k.id} className={`kcard${k.current ? ' current' : ''}`} aria-labelledby={`k-${k.id}`}>
            <div className="khead"><h3 id={`k-${k.id}`}>{k.title || k.id}</h3><span className="slug">{k.id}</span>{k.current && <span className="kind">Open now</span>}</div>
            <p>{k.visibility} · owned by {k.owner}</p>
            <div className="kfoot"><span className="why-not">{k.current ? `You work here as ${overview.me.name} (${overview.me.role}).` : `You hold ${k.access.level ?? 'no access'} here.`}</span>
              {k.current ? null : <span className="edit-row" style={{ marginTop: 0 }}>
                {onRead && <button type="button" className="btn" onClick={() => onRead(k.id)} title="Its committed work, read only, without leaving this kolab">Read here</button>}
                <button type="button" className="btn primary" onClick={() => onOpen(k.id)} title="This session ends, and one opens there">Open</button></span>}</div>
          </article>
        ))}
      </div></section>
      <section className="newk" aria-labelledby="k-new">
        <h2 className="section-title" id="k-new">New kolab</h2>
        <p className="why-not">A kolab of your own, private until you share it. You’ll work in it as {overview.me.name} ({overview.me.role}); this session ends and one opens there.</p>
        <form onSubmit={async (e) => { e.preventDefault(); if (await onCreateKolab(kName, kTitle)) { setKTitle(''); setKName(''); setKTouched(false); } }}>
          <div className="field"><label htmlFor="kTitle">Name</label>
            <input id="kTitle" value={kTitle} maxLength={60} autoComplete="off" placeholder="Billing" onChange={(e) => { setKTitle(e.target.value); if (!kTouched) setKName(slug(e.target.value)); }} /></div>
          <div className="field"><label htmlFor="kName">Short name</label>
            <input id="kName" value={kName} maxLength={40} autoComplete="off" spellCheck={false} placeholder="billing" onChange={(e) => { setKName(e.target.value); setKTouched(true); }} />
            <span className="hint">Lowercase letters, digits and hyphens, unique across all of Konjir so the kolab can move to another owner. Its addresses are <span className="addr">kj:{kName || 'billing'}/…</span>, or just <span className="addr">kj:…</span> inside it.</span></div>
          <div className="edit-row"><button type="submit" className="btn primary" disabled={!kTitle.trim() || !kName.trim()}>Create kolab</button></div>
        </form>
      </section>
      </>}
      {overview.me.access.layers.includes(overview.me.layer) && (
        <section className="newk" aria-labelledby="n-new">
          <h2 className="section-title" id="n-new">New document in {overview.kolab.id}</h2>
          <p className="why-not">Your role writes the {overview.me.layer} layer. Its name is its address: <span className="addr">kj:{name || 'name'}</span>.</p>
          <form onSubmit={create}>
            <div className="field"><label htmlFor="nKind">Kind</label>
              <select id="nKind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{kinds.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}</select></div>
            <div className="field"><label htmlFor="nTitle">Title</label><input id="nTitle" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Checkout" /></div>
            <div className="field"><label htmlFor="nName">Name</label><input id="nName" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} placeholder="checkout" />
              <span className="hint">No spaces, and no “/”, “@”, “#” or “~”. Unique in this kolab.</span></div>
            <div className="edit-row"><button type="submit" className="btn primary" disabled={!title.trim() || !name.trim()}>Create</button></div>
          </form>
        </section>
      )}
    </>
  );
}

/**
 * Another kolab, read in place (D49): its nodes at their latest committed version, read only. Its
 * drafts, reviews, links, marks, case files and rulings stay private to its work.
 */
export function ForeignKolabView({ kolab, tick, go, onOpen }: { kolab: string; tick: number; go(r: string): void; onOpen(kolab: string): void }) {
  const { pages, error, more, busy } = usePaged<WebForeignKolab>(`kolabs/${encodeURIComponent(kolab)}/nodes`, tick);
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!pages) return <p className="empty">Reading {kolab}…</p>;
  const k = pages[0].kolab;
  const committed = pages.flatMap((p) => p.nodes).filter((n) => n.latest !== null);
  return (
    <>
      <section className="summary" aria-label={`Kolab ${k.id}`}>
        <h1>{k.title || k.id}</h1>
        <span className="fact"><span className="addr">kj:{k.id}/…</span> · {k.visibility} · owned by {k.owner} · you hold {k.access.level}</span>
      </section>
      <div className="foreign" role="note">
        <span>Read in place, from your session in another kolab: its committed work only. Its drafts, reviews, links, marks, case files and rulings stay with those who work in it.</span>
        {k.access.layers.length > 0 && <button type="button" className="btn" onClick={() => onOpen(k.id)}>Work in {k.id}</button>}
      </div>
      <section aria-labelledby="fk-nodes"><h2 className="section-title" id="fk-nodes">Documents</h2>
        {committed.length ? <ul className="qlist">{committed.map((n) => (
          <li key={n.name} className="qitem"><div className="row">
            <button type="button" className="chip" onClick={() => go(`read/${k.id}/${n.name}`)}>kj:{k.id}/{n.name}@{n.latest}</button>
            <span>{n.title} · {n.kind.replace(/_/g, ' ')}</span></div></li>
        ))}</ul> : <p className="empty">Nothing committed there yet.</p>}
        <More more={more} busy={busy} what="documents" />
      </section>
    </>
  );
}

/**
 * Signing in (D55): with the identity provider (GitHub), through Kolab's own OAuth server, or, where
 * token sign-in is on (development), by pasting a session token of one's own.
 */
export function SignIn({ onSignedIn, error: initial, methods }: { onSignedIn(token: string): Promise<string | undefined>; error?: string; methods?: WebSignInMethods }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState(initial);
  const [busy, setBusy] = useState(false);
  const provider = methods?.provider;
  const tokens = methods ? methods.token : false;
  return (
    <main className="signin">
      <section className="newk" aria-labelledby="si-title">
        <h1 className="section-title" id="si-title">Sign in to Kolab</h1>
        {error && !tokens && <p className="err" role="alert">{error}</p>}
        {provider && (
          <>
            <p className="why-not">Sign in, or sign up, with {provider}. You choose the kolab and role to work in. Kolab keeps your session in this browser’s cookies, out of the page’s reach; it renews itself until you sign out.</p>
            <div className="edit-row"><a className="btn primary" href="/api/session/oauth/start">Sign in with {provider}</a></div>
          </>
        )}
        {!methods && <p className="why-not">Connecting to Kolab…</p>}
        {methods && !provider && !tokens && <p className="why-not">This Kolab has no way to sign in from the web set up yet. Ask whoever runs it.</p>}
        {tokens && (
          <>
            <p className="why-not">{provider ? 'Or, for development, paste' : 'Paste'} the session token you were given: your own, as a person, not an agent’s. It names you, your kolab and your role. Kolab keeps it in this browser’s cookie, out of the page’s reach, until the browser closes; signing out ends the session.</p>
            <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(await onSignedIn(token.trim())); setBusy(false); }}>
              <div className="field"><label htmlFor="token">Session token</label>
                <input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} aria-invalid={!!error} aria-describedby={error ? 'token-err' : undefined} />
                {error && <span className="err" id="token-err" role="alert">{error}</span>}
                <span className="hint">An admin opens one for you: <span className="addr">konjir admin_open_session actor=you role=product kolab=…</span></span></div>
              <div className="edit-row"><button type="submit" className="btn" disabled={!token.trim() || busy}>Sign in with a token</button></div>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
