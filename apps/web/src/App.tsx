import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebMe, WebOverview } from '@konjir/types';
import { ApiError, api, signIn, signOut } from './api.js';
import { useLive } from './live.js';
import { Wordmark } from './components/bits.js';
import { NodeView } from './components/NodeView.js';
import { ActivityView, KolabsView, LineageView, QuestionsView, ReviewsView, SignIn } from './components/Pages.js';
import type { Act } from './components/Marks.js';

/**
 * Where the page is: `#/node/<name>[@<version>][#<element>]`, `#/questions`, `#/reviews`,
 * `#/lineage`, `#/activity` or `#/kolabs`. The hash keeps every place linkable without the server
 * knowing any route but `/`.
 */
export type Route =
  | { view: 'node'; name: string; version?: number; focus?: string }
  | { view: 'questions' | 'reviews' | 'lineage' | 'activity' | 'kolabs' | 'home' };

export function parseRoute(hash: string): Route {
  const h = decodeURIComponent(hash.replace(/^#\/?/, ''));
  const node = /^node\/([^@#]+)(?:@(\d+))?(?:#(.+))?$/.exec(h);
  if (node) return { view: 'node', name: node[1], version: node[2] ? Number(node[2]) : undefined, focus: node[3] ? `${node[1]}#${node[3]}` : undefined };
  if (['questions', 'reviews', 'lineage', 'activity', 'kolabs'].includes(h)) return { view: h as 'questions' };
  return { view: 'home' };
}

type Theme = 'light' | 'dark' | undefined;
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export function App() {
  const [me, setMe] = useState<WebMe | null>();
  const [signInError, setSignInError] = useState<string>();
  const [overview, setOverview] = useState<WebOverview>();
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState<string>();
  const [theme, setTheme] = useState<Theme>(() => (store.get('konjir.theme') as Theme) ?? undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 3600);
  }, []);
  const signedOut = useCallback((why?: string) => { setMe(null); setOverview(undefined); setSignInError(why); }, []);

  useEffect(() => {
    api<WebMe>('me').then(setMe, (e: unknown) => signedOut(e instanceof ApiError && e.status === 401 ? undefined : (e as Error).message));
  }, [signedOut]);
  useEffect(() => {
    if (!me) return;
    api<WebOverview>('overview').then(setOverview, (e: unknown) => { if (e instanceof ApiError && e.status === 401) signedOut('Your session ended. Sign in again.'); });
  }, [me, tick, signedOut]);
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  // Live: every signal re-reads what the page shows (API8).
  useLive(!!me, () => setTick((t) => t + 1), () => signedOut('Your session ended. Sign in again.'));

  const act: Act = {
    async run(what, done) {
      try {
        await what();
        if (done) say(done);
        setTick((t) => t + 1);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) signedOut('Your session ended. Sign in again.');
        else say((e as Error).message);
        return false;
      }
    },
  };
  const go = (r: string) => { location.hash = `#/${r}`; };

  if (me === undefined) return <p className="empty" style={{ padding: 24 }}>Connecting to Kolab…</p>;
  if (me === null) {
    return (
      <>
        <Bar theme={theme} setTheme={(t) => { setTheme(t); store.set('konjir.theme', t); }} />
        <SignIn error={signInError} onSignedIn={async (token) => {
          try { setMe(await signIn(token)); setSignInError(undefined); return undefined; } catch (e) { return (e as Error).message; }
        }} />
      </>
    );
  }

  const specs = overview?.nodes ?? [];
  const home = specs.find((n) => n.kind === 'functional_spec') ?? specs[0];
  const r: Route = route.view === 'home' ? (home ? { view: 'node', name: home.name } : { view: 'kolabs' }) : route;
  const counts = overview?.counts;
  return (
    <>
      <Bar theme={theme} setTheme={(t) => { setTheme(t); store.set('konjir.theme', t); }} me={me} kolab={overview?.kolab.title || me.kolab}
        onSignOut={async () => { await signOut().catch(() => undefined); signedOut(); }} />
      <div className="frame">
        <nav className="rail" aria-label="Places">
          <button type="button" className="place" aria-current={r.view === 'kolabs' ? 'page' : undefined} onClick={() => go('kolabs')}>All kolabs</button>
          <div className="rail-label">Documents</div>
          {specs.map((n) => (
            <button key={n.name} type="button" className="place" aria-current={r.view === 'node' && r.name === n.name ? 'page' : undefined} onClick={() => go(`node/${n.name}`)}>
              {n.title}{n.in_review > 0 && <span className="count question" title={`${n.in_review} in review`}>{n.in_review}</span>}
            </button>
          ))}
          <div className="rail-label">Kolab</div>
          {(['lineage', 'questions', 'reviews', 'activity'] as const).map((v) => (
            <button key={v} type="button" className="place" aria-current={r.view === v ? 'page' : undefined} onClick={() => go(v)}>
              {v[0].toUpperCase() + v.slice(1)}
              {v === 'questions' && counts?.waiting ? <span className="count question" title={`${counts.waiting} waiting on you`}>{counts.waiting}</span> : null}
              {v === 'reviews' && counts?.reviews ? <span className="count question" title={`${counts.reviews} waiting for your review`}>{counts.reviews}</span> : null}
            </button>
          ))}
          <div className="rail-foot"><span>{me.name} · {me.role} · {me.kolab}</span></div>
        </nav>
        <main>
          {overview && r.view !== 'kolabs' && <Summary overview={overview} />}
          {r.view === 'node' && <NodeView key={r.name} me={me} name={r.name} version={r.version} focus={r.focus} tick={tick} act={act} go={go}
            read={(v) => go(`node/${r.name}${v ? `@${v}` : ''}`)} />}
          {r.view === 'questions' && <QuestionsView me={me} tick={tick} act={act} go={go} />}
          {r.view === 'reviews' && <ReviewsView tick={tick} go={go} />}
          {r.view === 'lineage' && <LineageView tick={tick} go={go} />}
          {r.view === 'activity' && <ActivityView tick={tick} />}
          {r.view === 'kolabs' && overview && <KolabsView overview={overview} act={act} onCreated={(n) => go(`node/${n}`)} />}
        </main>
      </div>
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </>
  );
}

function Summary({ overview: o }: { overview: WebOverview }) {
  const { stale, waiting, reviews, open } = o.counts;
  const parts = [
    stale ? `${stale} element${stale > 1 ? 's are' : ' is'} stale on your layer` : '',
    waiting ? `${waiting} question${waiting > 1 ? 's wait' : ' waits'} on you` : '',
    reviews ? `${reviews} version${reviews > 1 ? 's wait' : ' waits'} for your review` : '',
  ].filter(Boolean);
  const lead = !o.nodes.length ? 'Nothing written yet. Start with the spec.' : parts.length ? `${parts.join(', ')}.` : 'Everything holds.';
  return (
    <section className="summary" aria-label="Summary">
      <h1>{lead.charAt(0).toUpperCase() + lead.slice(1)}</h1>
      {o.nodes.filter((n) => n.latest !== null).slice(0, 4).map((n) => <span key={n.name} className="fact">{n.title} <b className="mono">v{n.latest}</b></span>)}
      <span className="fact"><b>{open}</b> open question{open === 1 ? '' : 's'} in total</span>
    </section>
  );
}

function Bar({ theme, setTheme, me, kolab, onSignOut }: { theme: Theme; setTheme(t: 'light' | 'dark'): void; me?: WebMe; kolab?: string; onSignOut?(): void }) {
  const dark = theme ? theme === 'dark' : !(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches);
  return (
    <header className="bar">
      <div className="bar-in">
        <a className="brand" href="#/" aria-label="Konjir"><Wordmark /></a>
        {me && <span className="kolab-btn" title={`You work in the kolab ${me.kolab}`}><span className="lbl">Kolab</span><span className="nm">{kolab}</span></span>}
        <span className="server">{location.host}</span>
        <span className="spacer" />
        {me && <span className="who">Working as <b>{me.name}</b> · {me.role}{me.kind === 'agent' ? ` · agent of ${me.owner}` : ''}</span>}
        <div className="seg icons" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} aria-label="Daybreak, the light theme" title="Daybreak" onClick={() => setTheme('light')}>
            <svg viewBox="0 0 37 37" aria-hidden="true"><circle cx="18.5" cy="18.5" r="11.7" fill="var(--sun)" /></svg></button>
          <button type="button" role="radio" aria-checked={dark} aria-label="Predawn, the dark theme" title="Predawn" onClick={() => setTheme('dark')}>
            <svg viewBox="65.5 17 37 37" aria-hidden="true"><path d="M84.60 18.60 A19.68 19.68 0 0 1 76.40 52.40 A29.60 29.60 0 0 0 84.60 18.60Z" fill="var(--moon)" stroke="var(--moon)" strokeWidth="0.6" strokeLinejoin="round" /></svg></button>
        </div>
        {onSignOut && <button type="button" className="btn quiet" onClick={onSignOut}>Sign out</button>}
      </div>
      <div className="horizon" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    </header>
  );
}

