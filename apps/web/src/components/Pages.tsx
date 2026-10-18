import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  KINDS, LAYER_OF_KIND,
  type Kind, type WebActivityView, type WebLineageView, type WebMe, type WebOverview, type WebQuery, type WebReviewsView,
} from '@konjir/types';
import { api } from '../api.js';
import { addr, ago } from '../util.js';
import { Addr, Pill } from './bits.js';
import { QueryBox, type Act } from './Marks.js';

/** Re-reads `path` whenever `tick` moves. */
function useRead<T>(path: string, tick: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api<T>(path).then((d) => { if (live) { setData(d); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [path, tick]);
  return { data, error };
}

export function QuestionsView({ me, tick, act, go }: { me: WebMe; tick: number; act: Act; go(r: string): void }) {
  const { data, error } = useRead<{ queries: WebQuery[] }>('queries', tick);
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!data) return <p className="empty">Reading the questions…</p>;
  const open = data.queries.filter((q) => q.state === 'open');
  const done = data.queries.filter((q) => q.state === 'answered');
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
      </section>
      <section aria-labelledby="q-done"><h2 className="section-title" id="q-done">Answered</h2>
        <p className="why-not" style={{ margin: '-6px 0 12px', maxWidth: '68ch' }}>Answers are served to every agent as precedent, so a settled question isn’t asked again.</p>
        {done.length ? <ul className="qlist">{done.map(item)}</ul> : <p className="empty">Nothing answered yet.</p>}
      </section>
    </>
  );
}

export function ReviewsView({ tick, go }: { tick: number; go(r: string): void }) {
  const { data, error } = useRead<WebReviewsView>('reviews', tick);
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!data) return <p className="empty">Reading the reviews…</p>;
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
    </>
  );
}

export function ActivityView({ tick }: { tick: number }) {
  const { data, error } = useRead<WebActivityView>('activity', tick);
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!data) return <p className="empty">Reading the activity…</p>;
  return (
    <section aria-labelledby="act-title"><h2 className="section-title" id="act-title">Activity</h2>
      <p className="why-not" style={{ margin: '-6px 0 12px', maxWidth: '68ch' }}>From what Kolab records: versions as they were written, verdicts, questions and marks.</p>
      <ol className="log">{data.items.map((l, i) => (
        <li key={i}><time dateTime={l.at}>{ago(l.at)}</time><span><span className="actor">{l.actor}</span> {l.text.split(/(kj:[^\s·:]+)/).map((part, j) => part.startsWith('kj:') ? <Addr key={j}>{part}</Addr> : part)}</span></li>
      ))}</ol>
    </section>
  );
}

/** What depends on what: each wire a link from an element to what it relies on, pinned to the version it was checked against. */
export function LineageView({ tick, go }: { tick: number; go(r: string): void }) {
  const { data, error } = useRead<WebLineageView>('lineage', tick);
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
  }, [data, focus]);
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
    </section>
  );
}

/** All kolabs the signed-in actor can reach. A session works in one; the others need a session of their own. */
export function KolabsView({ overview, act, onCreated }: { overview: WebOverview; act: Act; onCreated(name: string): void }) {
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
      <section className="summary" aria-label="Kolabs">
        <h1>Kolabs</h1>
        <span className="fact">A kolab is one project with a hard edge. Its one spec, the bindings built on it, their links and questions stay inside it.</span>
      </section>
      <section aria-label="Your kolabs"><div className="kgrid">
        {overview.kolabs.map((k) => (
          <article key={k.id} className={`kcard${k.current ? ' current' : ''}`} aria-labelledby={`k-${k.id}`}>
            <div className="khead"><h3 id={`k-${k.id}`}>{k.title || k.id}</h3><span className="slug">{k.id}</span>{k.current && <span className="kind">Open now</span>}</div>
            <p>{k.visibility} · owned by {k.owner}</p>
            <div className="kfoot"><span className="why-not">{k.current ? `You work here as ${overview.me.name} (${overview.me.role}).` : 'Your session works in another kolab. To work here, sign in with a session opened in it.'}</span></div>
          </article>
        ))}
      </div></section>
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

/** Signing in with a Konjir session token, until OAuth is bound (P2). */
export function SignIn({ onSignedIn, error: initial }: { onSignedIn(token: string): Promise<string | undefined>; error?: string }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <main className="signin">
      <section className="newk" aria-labelledby="si-title">
        <h1 className="section-title" id="si-title">Sign in to Kolab</h1>
        <p className="why-not">Paste the session token you were given. It names you, your kolab and your role. Kolab keeps it in this browser’s cookie for this site, out of the page’s reach; signing out removes it.</p>
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(await onSignedIn(token.trim())); setBusy(false); }}>
          <div className="field"><label htmlFor="token">Session token</label>
            <input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} aria-invalid={!!error} aria-describedby={error ? 'token-err' : undefined} />
            {error && <span className="err" id="token-err" role="alert">{error}</span>}
            <span className="hint">An admin opens one for you: <span className="addr">konjir admin_open_session actor=you role=product kolab=…</span></span></div>
          <div className="edit-row"><button type="submit" className="btn primary" disabled={!token.trim() || busy}>Sign in</button></div>
        </form>
      </section>
    </main>
  );
}
