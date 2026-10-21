import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvitePreview, WebMe, WebOverview, WebSignInMethods } from '@konjir/types';
import { ApiError, acceptInvite, api, createKolab, dropInvite, openInvite, signIn, signOut, switchTo } from './api.js';
import { useLive } from './live.js';
import { Wordmark } from './components/bits.js';
import { NodeView } from './components/NodeView.js';
import { ActivityView, ForeignKolabView, KolabsView, LineageView, QuestionsView, ReviewsView, SignIn } from './components/Pages.js';
import { CasesView } from './components/Cases.js';
import { ConnectPage, GettingStarted, InviteCard, PeopleView } from './components/Onboarding.js';
import { parseKj, routeOf } from './util.js';
import type { Act } from './components/Marks.js';

/**
 * Where the page is: `#/node/<name>[@<version>][#<element>]`, `#/questions`, `#/cases`,
 * `#/reviews`, `#/lineage`, `#/activity`, `#/kolabs`, `#/people` or `#/connect`; another kolab read
 * in place (D49) is `#/read/<kolab>` and `#/read/<kolab>/<name>[@<version>][#<element>]`. The hash
 * keeps every place linkable without the server knowing any route but `/`. An invite's link,
 * `#/invite/<secret>` (W3.4), is taken out of the address as soon as the page reads it.
 */
export type Route =
  | { view: 'node'; name: string; version?: number; focus?: string; kolab?: string }
  | { view: 'read'; kolab: string }
  | { view: 'questions' | 'cases' | 'reviews' | 'lineage' | 'activity' | 'kolabs' | 'people' | 'connect' | 'home' | 'start' };

export function parseRoute(hash: string): Route {
  let h: string;
  try { h = decodeURIComponent(hash.replace(/^#\/?/, '')); } catch { return { view: 'home' }; }
  const node = /^node\/([^@#]+)(?:@(\d+))?(?:#(.+))?$/.exec(h);
  if (node) return { view: 'node', name: node[1], version: node[2] ? Number(node[2]) : undefined, focus: node[3] ? `${node[1]}#${node[3]}` : undefined };
  const foreign = /^read\/([a-z0-9][a-z0-9-]*)\/([^@#/]+)(?:@(\d+))?(?:#(.+))?$/.exec(h);
  if (foreign) {
    return { view: 'node', kolab: foreign[1], name: foreign[2], version: foreign[3] ? Number(foreign[3]) : undefined, focus: foreign[4] ? `${foreign[2]}#${foreign[4]}` : undefined };
  }
  const kolab = /^read\/([a-z0-9][a-z0-9-]*)$/.exec(h);
  if (kolab) return { view: 'read', kolab: kolab[1] };
  if (['questions', 'cases', 'reviews', 'lineage', 'activity', 'kolabs', 'people', 'connect'].includes(h)) return { view: h as 'questions' };
  return { view: 'home' };
}

/** An invite's secret in the address (W3.4), `#/invite/kji_…`, or undefined. */
export function inviteOf(hash: string): string | undefined {
  return /^#\/?invite\/(kji_[A-Za-z0-9_-]{43})$/.exec(hash)?.[1];
}

/** Reads an invite's secret from the address, and takes it out, so it stays in no history or bookmark. */
function takeInvite(): string | undefined {
  const token = inviteOf(location.hash);
  if (token) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  return token;
}

type Theme = 'light' | 'dark' | undefined;
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export function App() {
  const [me, setMe] = useState<WebMe | null>();
  const [signInError, setSignInError] = useState<string | undefined>(() => {
    // A sign-in with the identity provider that didn't finish comes back with why (D55).
    const why = new URLSearchParams(location.search).get('signin_error') ?? undefined;
    if (why) history.replaceState(null, '', location.pathname + location.hash);
    return why;
  });
  const [methods, setMethods] = useState<WebSignInMethods>();
  const [overview, setOverview] = useState<WebOverview>();
  const [invite, setInvite] = useState<{ token: string; preview?: InvitePreview; error?: string } | undefined>(() => {
    const token = takeInvite();
    return token ? { token } : undefined;
  });
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
    if (me !== null || methods) return;
    api<WebSignInMethods>('session/methods').then(setMethods, () => setMethods({ provider: null, token: true }));
  }, [me, methods]);

  useEffect(() => {
    api<WebMe>('me').then(setMe, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) { setMe(null); return; }
      signedOut((e as Error).message);
    });
  }, [signedOut]);
  useEffect(() => {
    if (!me) return;
    api<WebOverview>('overview').then(setOverview, (e: unknown) => { if (e instanceof ApiError && e.status === 401) signedOut('Your session ended. Sign in again.'); });
  }, [me, tick, signedOut]);
  // An invite opened from its link: what it offers. Kolab keeps it for the sign-in, which offers to join.
  useEffect(() => {
    if (!invite || invite.preview || invite.error) return;
    openInvite(invite.token).then((preview) => setInvite({ ...invite, preview }), (e: Error) => setInvite({ ...invite, error: e.message }));
  }, [invite]);
  useEffect(() => {
    const on = () => {
      const token = takeInvite();
      if (token) setInvite({ token });
      setRoute(parseRoute(location.hash));
    };
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
  /** After the session moved to another kolab or role: a fresh page, at its spec. */
  const moved = (next: WebMe, what: string) => { setMe(next); setOverview(undefined); setTick((t) => t + 1); go(''); say(what); };
  const move = (kolab: string, role: string) => act.run(async () => {
    const next = await switchTo(kolab, role);
    moved(next, `Working in ${next.kolab} as ${next.role}`);
  }, '');

  const inviteNote = invite?.error ? <p className="notice" role="alert">{invite.error}</p> : null;
  if (me === undefined) return <p className="empty" style={{ padding: 24 }}>Connecting to Kolab…</p>;
  if (me === null) {
    return (
      <>
        <Bar theme={theme} setTheme={(t) => { setTheme(t); store.set('konjir.theme', t); }} />
        {(invite?.preview || inviteNote) && <div className="signin-invite">{invite?.preview ? <InviteCard invite={invite.preview} signedIn={false} /> : inviteNote}</div>}
        <SignIn error={signInError} methods={methods} onSignedIn={async (token) => {
          try { setMe(await signIn(token)); setSignInError(undefined); return undefined; } catch (e) { return (e as Error).message; }
        }} />
      </>
    );
  }

  const specs = overview?.nodes ?? [];
  const home = specs.find((n) => n.kind === 'functional_spec') ?? specs[0];
  const r: Route = route.view === 'home' ? (home ? { view: 'node', name: home.name } : { view: 'start' }) : route;
  const counts = overview?.counts;
  const belongs = me.access.layers.length > 0;
  // A full address in the session's own kolab is its own node's page; another kolab's is read in place.
  const nodeRoute = r.view === 'node' && r.kolab === me.kolab ? { ...r, kolab: undefined } : r;
  const reading = (nodeRoute.view === 'node' && nodeRoute.kolab !== undefined) || nodeRoute.view === 'read';
  return (
    <>
      <Bar theme={theme} setTheme={(t) => { setTheme(t); store.set('konjir.theme', t); }} me={me} overview={overview}
        onMove={move} onAllKolabs={() => go('kolabs')}
        onSignOut={async () => { await signOut().catch(() => undefined); signedOut('Signed out. Your session has ended.'); }} />
      <div className="frame">
        <nav className="rail" aria-label="Places">
          <button type="button" className="place" aria-current={r.view === 'kolabs' ? 'page' : undefined} onClick={() => go('kolabs')}>All kolabs</button>
          <div className="rail-label">Documents</div>
          {specs.map((n) => (
            <button key={n.name} type="button" className="place" aria-current={nodeRoute.view === 'node' && !nodeRoute.kolab && nodeRoute.name === n.name ? 'page' : undefined} onClick={() => go(`node/${n.name}`)}>
              {n.title}{n.in_review > 0 && <span className="count question" title={`${n.in_review} in review`}>{n.in_review}</span>}
            </button>
          ))}
          <div className="rail-label">Kolab</div>
          {(['lineage', 'questions', ...(belongs ? ['cases' as const] : []), 'reviews', 'activity', 'people', 'connect'] as const).map((v) => (
            <button key={v} type="button" className="place" aria-current={r.view === v ? 'page' : undefined} onClick={() => go(v)}>
              {v === 'connect' ? 'Connect a harness' : v[0].toUpperCase() + v.slice(1)}
              {v === 'questions' && counts?.waiting ? <span className="count question" title={`${counts.waiting} waiting on you`}>{counts.waiting}</span> : null}
              {v === 'reviews' && counts?.reviews ? <span className="count question" title={`${counts.reviews} waiting for your review`}>{counts.reviews}</span> : null}
              {v === 'cases' && counts?.cases ? <span className="count stale" title={`${counts.cases} open on your layer`}>{counts.cases}</span> : null}
            </button>
          ))}
          <GoTo here={me.kolab} go={go} />
          <div className="rail-foot"><span>{me.name} · {me.role} · {me.kolab}</span></div>
        </nav>
        <main>
          {invite?.preview && <InviteCard invite={invite.preview} signedIn onDismiss={() => { setInvite(undefined); void dropInvite().catch(() => undefined); }}
            onJoin={() => act.run(async () => {
              const next = await acceptInvite(invite.token);
              setInvite(undefined);
              moved(next, `Joined ${next.kolab}: you work here as ${next.role}`);
            }, '')} />}
          {inviteNote}
          {overview && !['kolabs', 'people', 'connect'].includes(r.view) && !reading && <Summary overview={overview} />}
          {nodeRoute.view === 'node' && <NodeView key={`${nodeRoute.kolab ?? ''}/${nodeRoute.name}`} me={me} name={nodeRoute.name} version={nodeRoute.version} focus={nodeRoute.focus}
            kolab={nodeRoute.kolab} tick={tick} act={act} go={go}
            read={(v) => go(`${nodeRoute.kolab ? `read/${nodeRoute.kolab}` : 'node'}/${nodeRoute.name}${v ? `@${v}` : ''}`)} />}
          {nodeRoute.view === 'read' && (nodeRoute.kolab === me.kolab ? <p className="empty">This is the kolab you work in: its documents are in the rail.</p>
            : <ForeignKolabView kolab={nodeRoute.kolab} tick={tick} go={go} onOpen={(k) => move(k, me.role)} />)}
          {r.view === 'questions' && <QuestionsView me={me} tick={tick} act={act} go={go} />}
          {r.view === 'cases' && <CasesView me={me} tick={tick} act={act} go={go} />}
          {r.view === 'reviews' && <ReviewsView tick={tick} go={go} />}
          {r.view === 'lineage' && <LineageView tick={tick} go={go} />}
          {r.view === 'activity' && <ActivityView tick={tick} />}
          {r.view === 'start' && <GettingStarted me={me} go={go} />}
          {r.view === 'people' && overview && <PeopleView me={me} overview={overview} tick={tick} act={act} />}
          {r.view === 'connect' && <ConnectPage me={me} />}
          {r.view === 'start' && overview && <KolabsView start overview={overview} act={act} onCreated={(n) => go(`node/${n}`)} onOpen={(k) => move(k, me.role)} onCreateKolab={async () => false} />}
          {r.view === 'kolabs' && overview && <KolabsView overview={overview} act={act} onCreated={(n) => go(`node/${n}`)} onOpen={(k) => move(k, me.role)} onRead={(k) => go(`read/${k}`)}
            onCreateKolab={(name, title) => act.run(async () => { moved(await createKolab(name, title), `Created ${name}. Its spec is empty: start it.`); }, '')} />}
        </main>
      </div>
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </>
  );
}

/**
 * Goes to a `kj:` address: in the session's kolab, the node's page; in another kolab, read in place,
 * where Kolab answers only if the session may read it (D49), and a refusal says nothing of what is there.
 */
function GoTo({ here, go }: { here: string; go(r: string): void }) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <form className="goto" role="search" onSubmit={(e) => {
      e.preventDefault();
      const a = parseKj(text);
      setBad(!a);
      if (a) { go(routeOf(a, here)); setText(''); }
    }}>
      <label htmlFor="goto">Go to an address</label>
      <input id="goto" value={text} spellCheck={false} autoComplete="off" placeholder="kj:kolab/node#R1" aria-invalid={bad}
        onChange={(e) => { setText(e.target.value); setBad(false); }} />
    </form>
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

function Bar({ theme, setTheme, me, overview, onSignOut, onMove, onAllKolabs }: {
  theme: Theme; setTheme(t: 'light' | 'dark'): void; me?: WebMe; overview?: WebOverview;
  onSignOut?(): void; onMove?(kolab: string, role: string): void; onAllKolabs?(): void;
}) {
  const dark = theme ? theme === 'dark' : !(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches);
  const [open, setOpen] = useState(false);
  const current = overview?.kolab;
  return (
    <header className="bar">
      <div className="bar-in">
        <a className="brand" href="#/" aria-label="Konjir"><Wordmark /></a>
        {me && (
          <div className="kolab-pick">
            <button type="button" className="kolab-btn" aria-expanded={open} aria-controls="kolabMenu" onClick={() => setOpen(!open)}>
              <span className="lbl">Kolab</span><span className="nm">{current?.title || me.kolab}</span>
              <svg viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4l2.5 2.5L7.5 4" /></svg>
            </button>
            {open && (
              <div className="menu" id="kolabMenu">
                {(overview?.kolabs ?? []).map((k) => (
                  <button key={k.id} type="button" className="mi" aria-current={k.current} onClick={() => { setOpen(false); if (!k.current) onMove?.(k.id, me.role); }}>
                    <span className="nm">{k.title || k.id}</span><span className="slug">{k.id} · {k.access.level ?? 'no access'}</span>
                  </button>
                ))}
                <hr />
                <button type="button" className="mi plain" onClick={() => { setOpen(false); onAllKolabs?.(); }}>All kolabs</button>
                <button type="button" className="mi plain" onClick={() => { setOpen(false); onAllKolabs?.(); setTimeout(() => document.getElementById('kName')?.focus(), 50); }}>New kolab</button>
              </div>
            )}
          </div>
        )}
        <span className="server">{location.host}</span>
        <span className="spacer" />
        {me && (
          <>
            <span className="who" id="whoLabel">Working as <b>{me.name}</b></span>
            <div className="seg" role="radiogroup" aria-labelledby="whoLabel">
              {(['product', 'engineer'] as const).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={me.role === r} title={me.role === r ? `You work as ${r}` : `Switch to ${r}: this session ends, and one opens in that role`}
                  onClick={() => { if (me.role !== r) onMove?.(me.kolab, r); }}>{r}</button>
              ))}
            </div>
          </>
        )}
        <div className="seg icons" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} aria-label="Daybreak, the light theme" title="Daybreak" onClick={() => setTheme('light')}>
            <svg viewBox="0 0 37 37" aria-hidden="true"><circle cx="18.5" cy="18.5" r="11.7" fill="var(--sun)" /></svg></button>
          <button type="button" role="radio" aria-checked={dark} aria-label="Predawn, the dark theme" title="Predawn" onClick={() => setTheme('dark')}>
            <svg viewBox="65.5 17 37 37" aria-hidden="true"><path d="M84.60 18.60 A19.68 19.68 0 0 1 76.40 52.40 A29.60 29.60 0 0 0 84.60 18.60Z" fill="var(--moon)" stroke="var(--moon)" strokeWidth="0.6" strokeLinejoin="round" /></svg></button>
        </div>
        {onSignOut && <button type="button" className="btn quiet" onClick={onSignOut} title="Ends this session: its token stops working everywhere">Sign out</button>}
      </div>
      <div className="horizon" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    </header>
  );
}

