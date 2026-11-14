import { useCallback, useEffect, useRef, useState } from 'react';
import type { InvitePreview, WebMe, WebNodesView, WebOverview, WebSignInMethods } from '@konjir/types';
import { ApiError, acceptInvite, api, createKolab, dropInvite, markPushTick, openInvite, pageUpdated, patiently, pushed, signIn, signOut, switchTo, whoAmI } from './api.js';
import { useLive } from './live.js';
import { Here, Wordmark } from './components/bits.js';
import { NodeView } from './components/NodeView.js';
import { ActivityView, ForeignKolabView, KolabsView, LineageView, More, QuestionsView, ReviewsView, SignIn } from './components/Pages.js';
import { CasesView } from './components/Cases.js';
import { InboxView, RulingsView, SettingsView, WorkView } from './components/Places.js';
import { ConnectPage, GettingStarted, InviteCard, PeopleView, SessionsView } from './components/Onboarding.js';
import { parseKj, parsePlace, placeLink, routeOf } from './util.js';
import type { Act } from './components/Marks.js';

/**
 * Where the page is: `#/node/<name>[@<version>][#<element>]`, `#/questions`, `#/cases`,
 * `#/reviews`, `#/lineage`, `#/activity`, `#/kolabs`, `#/people`, `#/connect` or `#/sessions`; another kolab read
 * in place (D49) is `#/read/<kolab>` and `#/read/<kolab>/<name>[@<version>][#<element>]`. The hash
 * keeps every place linkable without the server knowing any route but `/`. An invite's link,
 * `#/invite/<secret>` (W3.4), is taken out of the address as soon as the page reads it.
 *
 * The address names the kolab too, `#/k/<kolab>/<place>` (parsePlace), so a copied one opens the
 * same place for whoever can reach that kolab, whichever kolab their session is in. One without a
 * kolab means the session's, and the page writes the kolab into it.
 */
export type Route =
  | { view: 'node'; name: string; version?: number; focus?: string; kolab?: string }
  | { view: 'read'; kolab: string }
  /** `focus` an element, as `<node>#<element>`, to show what it relies on and what relies on it: #/lineage/orders#R1. */
  | { view: 'lineage'; focus?: string }
  | { view: 'questions' | 'cases' | 'reviews' | 'activity' | 'kolabs' | 'people' | 'connect' | 'sessions' | 'home' | 'start' | 'inbox' | 'work' | 'settings' | 'new' }
  /** The address names another kolab, and the session is on its way there: nothing of this one is shown as that one's. */
  | { view: 'opening' }
  /** The rulings, as precedent to search; `ref` a ruling's name to show, #/rulings/D104. */
  | { view: 'rulings'; ref?: string }
  /** An address the page has no place for: said so, never another page shown in its place. */
  | { view: 'missing'; what: string };

export function parseRoute(hash: string): Route {
  let h: string;
  try { h = decodeURIComponent(parsePlace(hash).place); } catch { return { view: 'home' }; }
  const node = /^node\/([^@#]+)(?:@(\d+))?(?:#(.+))?$/.exec(h);
  if (node) return { view: 'node', name: node[1], version: node[2] ? Number(node[2]) : undefined, focus: node[3] ? `${node[1]}#${node[3]}` : undefined };
  const foreign = /^read\/([a-z0-9][a-z0-9-]*)\/([^@#/]+)(?:@(\d+))?(?:#(.+))?$/.exec(h);
  if (foreign) {
    return { view: 'node', kolab: foreign[1], name: foreign[2], version: foreign[3] ? Number(foreign[3]) : undefined, focus: foreign[4] ? `${foreign[2]}#${foreign[4]}` : undefined };
  }
  const kolab = /^read\/([a-z0-9][a-z0-9-]*)$/.exec(h);
  if (kolab) return { view: 'read', kolab: kolab[1] };
  const lineage = /^lineage\/([^@#/]+)(?:#(.+))?$/.exec(h);
  if (lineage) return { view: 'lineage', focus: `${lineage[1]}#${lineage[2] ?? ''}` };
  if (['questions', 'cases', 'reviews', 'lineage', 'activity', 'kolabs', 'people', 'connect', 'sessions', 'inbox', 'work', 'settings', 'new'].includes(h)) return { view: h as 'questions' };
  const rulings = /^rulings(?:\/([A-Za-z][\w.-]{0,39}))?$/.exec(h);
  if (rulings) return rulings[1] ? { view: 'rulings', ref: rulings[1] } : { view: 'rulings' };
  // An invite's link is taken out of the address as the page reads it (takeInvite): the page under it is home.
  return h === '' || h.startsWith('invite/') ? { view: 'home' } : { view: 'missing', what: h };
}

/** Each place's name, as the rail, the page's heading and its title say it. */
const PLACE: Record<string, string> = {
  inbox: 'Inbox', work: 'Work', rulings: 'Rulings', settings: 'Settings', new: 'New document',
  questions: 'Questions', cases: 'Case files', reviews: 'Reviews', lineage: 'Lineage', activity: 'Activity', kolabs: 'All kolabs',
  opening: 'Opening', people: 'People', connect: 'Connect a harness', sessions: 'Your sessions', start: 'Getting started', missing: 'Not found',
};

/** The rail's order of documents: the spec first, then what serves it, and a retired plan (D104) last. */
const KIND_ORDER: Record<string, number> = { spec: 0, binding: 1, prototype: 2, plan: 9 };

/** A document's name in the rail, without the kolab's title its own title repeats ("Kolab — Technical Binding"). */
export function shortTitle(title: string, kolabTitle?: string): string {
  if (!kolabTitle) return title;
  for (const sep of [' — ', ' - ', ': ']) if (title.startsWith(kolabTitle + sep) && title.length > kolabTitle.length + sep.length) return title.slice(kolabTitle.length + sep.length);
  return title;
}

/** Asks before the session changes kolab or role: the change ends this session, and opens another. */
export const confirmMove = (what: string) => typeof window.confirm !== 'function' || window.confirm(`${what}? This session ends, and one opens there. Whatever you were drafting here is discarded.`);

/** An invite's secret in the address (W3.4), `#/invite/kji_…`, or undefined. One written after a kolab, `#/k/<kolab>/invite/kji_…`, is an invite all the same. */
export function inviteOf(hash: string): string | undefined {
  return /^#\/?(?:k\/[a-z0-9][a-z0-9-]*\/)?invite\/(kji_[A-Za-z0-9_-]{43})$/.exec(hash)?.[1];
}

/** Reads an invite's secret from the address, and takes it out, so it stays in no history or bookmark. */
function takeInvite(): string | undefined {
  const token = inviteOf(location.hash);
  if (token) at('#/');
  return token;
}

/**
 * The kolab an address asks the session to be in. An invite's address asks for none, whatever is
 * written before it and whether its secret is well formed: an invite never moves a session.
 */
const askedBy = (hash: string) => { const { kolab, place } = parsePlace(hash); return /^invite(\/|$)/.test(place) ? undefined : kolab; };

/** Rewrites the address in place: no history entry, and no hashchange. */
const at = (hash: string) => history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);

/**
 * The address a signed-out page was opened at, kept in this tab while the browser signs in with the
 * identity provider, whose way back is `/` with no fragment, and put back when it returns.
 */
const KEPT = 'konjir.place';
function keepPlace() {
  try { if (location.hash.replace(/^#\/?/, '')) sessionStorage.setItem(KEPT, location.hash); else sessionStorage.removeItem(KEPT); } catch { /* storage unavailable */ }
}
/** A signed-in page keeps none: one left by a sign-in that never came back opens nothing later. */
function forgetPlace() {
  try { sessionStorage.removeItem(KEPT); } catch { /* storage unavailable */ }
}
function takePlace() {
  try {
    const kept = sessionStorage.getItem(KEPT);
    sessionStorage.removeItem(KEPT);
    if (kept?.startsWith('#/') && !location.hash.replace(/^#\/?/, '')) at(kept);
  } catch { /* storage unavailable */ }
}

type Theme = 'light' | 'dark' | undefined;
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export function App() {
  const [me, setMe] = useState<WebMe | null>();
  const [signInError, setSignInError] = useState<string | undefined>(() => {
    takePlace();
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
  /**
   * The kolab the address asked for, until the session is there or Kolab refuses: as the page
   * loaded, or as it moved to another kolab's address and the person agreed to go.
   */
  const [asked, setAsked] = useState<string | undefined>(() => askedBy(location.hash));
  // The session and what was asked, for what hears of an address or of the session between renders.
  const meNow = useRef(me);
  meNow.current = me;
  const askedNow = useRef(asked);
  askedNow.current = asked;
  /** The address last shown as a place of the session's kolab; none until a sign-in has shown one. */
  const settled = useRef<string>(undefined);
  /**
   * A move of the session to another kolab or role is under way, by any route: the picker, the
   * role, a new kolab, an invite joined or an address. There is one at a time: Kolab answers the
   * next as the session this one opens. `turn` moves as each ends, so an address that waited is
   * taken up, and `busy` is the same for what the page shows.
   */
  const gate = useRef(false);
  const [turn, setTurn] = useState(0);
  const [busy, setBusy] = useState(false);
  /** The page's own sign-out is under way or done, until a session is here again: a session found gone is no news. */
  const leaving = useRef(false);
  useEffect(() => { if (me) leaving.current = false; }, [me]);
  /** The address `route` and `asked` were read from: one set since is read when its hashchange arrives. */
  const [seen, setSeen] = useState(() => location.hash);
  const seenNow = useRef(seen);
  seenNow.current = seen;
  const [tick, setTick] = useState(0);
  // A re-read Kolab's push prompts, not a person's action: its reads renew no lease on work (D100).
  const pushTick = useCallback(() => setTick((t) => { markPushTick(t + 1); return t + 1; }), []);
  const [toast, setToast] = useState<string>();
  const [theme, setTheme] = useState<Theme>(() => (store.get('konjir.theme') as Theme) ?? undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 3600);
  }, []);
  /** Kolab is away (restarting): the page waits for it, and says so, rather than signing out. */
  const [away, setAway] = useState(false);
  /** Kolab now serves a newer page than this one: it was deployed while this tab was open. */
  const [updated, setUpdated] = useState(false);
  // The next sign-in opens the address as a fresh load does.
  const signedOut = useCallback((why?: string) => {
    setMe(null); setOverview(undefined); setSignInError(why); setAsked(askedBy(location.hash));
  }, []);
  /** Runs one move of the session, with the gate held from its start to the last of what follows it. */
  const gated = useCallback(async <T,>(what: () => Promise<T>): Promise<T> => {
    gate.current = true;
    setBusy(true);
    try { return await what(); } finally { gate.current = false; setBusy(false); setTurn((t) => t + 1); }
  }, []);
  /**
   * Moves the session to another kolab or role, as `how` asks Kolab to: a fresh page there. An
   * answer that comes after the page signed out signs nobody in: the session it opened is ended too.
   */
  const moveBy = useCallback(async (how: () => Promise<WebMe>): Promise<WebMe | undefined> => {
    const next = await how();
    if (leaving.current) { void signOut().catch(() => undefined); return undefined; }
    meNow.current = next;
    setMe(next); setOverview(undefined); setTick((t) => t + 1);
    return next;
  }, []);
  // How a person signs in here, asked as the page loads, so a session that ends while Kolab is away
  // still gets this Kolab's own sign-in. Kolab away is waited out; the token form shows only when
  // Kolab says it takes tokens, never as a guess.
  useEffect(() => {
    if (methods) return;
    let alive = true;
    patiently(() => api<WebSignInMethods>('session/methods'), { alive: () => alive })
      .then((m) => { if (alive) setMethods(m); }, () => { if (alive) setMethods({ provider: null, token: false }); });
    return () => { alive = false; };
  }, [methods]);

  useEffect(() => {
    let alive = true;
    whoAmI({ first: true, alive: () => alive, onWait: () => { if (alive) setAway(true); } }).then(
      (now) => { if (!alive) return; setAway(false); setMe(now); },
      (e: unknown) => { if (!alive) return; setAway(false); signedOut((e as Error).message); },
    );
    return () => { alive = false; };
  }, [signedOut]);

  /**
   * Something said the session may have ended (a 401, or the event stream closing): Kolab is asked,
   * once however many say so, and a restart waited out. The page signs out only when Kolab says the
   * session is gone; otherwise it re-reads what it shows. Resolves whether the session lives.
   * The browser holds one session for all its tabs: when another tab moved it to another kolab or
   * role, this page follows it there, and says so. Once the page itself signs out, nothing found matters.
   */
  const checking = useRef<Promise<boolean>>(undefined);
  const recheck = useCallback(() => {
    // Kolab's own check, after its stream dropped or a call came back 401: no person's request (D100).
    checking.current ??= whoAmI({ onWait: () => setAway(true), push: true }).then(
      (now) => {
        if (leaving.current) return !!now;
        if (!now) { signedOut('Your session ended. Sign in again.'); return false; }
        const was = meNow.current;
        if (was && !gate.current && (was.kolab !== now.kolab || was.role !== now.role)) {
          say(`${was.kolab !== now.kolab ? `Your session moved to ${now.kolab}` : `Your session now works as ${now.role}`} in another tab. This page follows it: what was drafted here is discarded.`);
        }
        meNow.current = now;
        setMe((was) => (was && JSON.stringify(was) === JSON.stringify(now) ? was : now));
        pushTick();
        return true;
      },
      (e: unknown) => { if (!leaving.current) signedOut((e as Error).message); return false; },
    ).finally(() => { setAway(false); checking.current = undefined; });
    return checking.current;
  }, [signedOut, pushTick, say]);
  const lastOverview = useRef<{ key: string; tick: number }>(undefined);
  useEffect(() => {
    if (!me) return;
    api<WebOverview>('overview', undefined, undefined, { push: pushed(lastOverview, JSON.stringify(me), tick) }).then((o) => { setOverview(o); setMoreNodes(undefined); }, (e: unknown) => { if (e instanceof ApiError && e.status === 401) void recheck(); });
  }, [me, tick, recheck]);
  // The rail's documents past the overview's first page (W2.21), read on asking; a new overview starts again.
  const [moreNodes, setMoreNodes] = useState<WebNodesView>();
  const [readingNodes, setReadingNodes] = useState(false);
  const nodesNext = moreNodes ? moreNodes.next : overview?.nodes_next ?? null;
  const readMoreNodes = async () => {
    if (!nodesNext || readingNodes) return;
    setReadingNodes(true);
    try {
      const p = await api<WebNodesView>(`nodes?cursor=${encodeURIComponent(nodesNext)}`);
      setMoreNodes({ nodes: [...(moreNodes?.nodes ?? []), ...p.nodes], next: p.next });
    } catch { /* the button stays, to try again */ } finally { setReadingNodes(false); }
  };
  // An invite opened from its link: what it offers. Kolab keeps it for the sign-in, which offers to join.
  useEffect(() => {
    if (!invite || invite.preview || invite.error) return;
    openInvite(invite.token).then((preview) => setInvite({ ...invite, preview }), (e: Error) => setInvite({ ...invite, error: e.message }));
  }, [invite]);
  useEffect(() => {
    const on = () => {
      const token = takeInvite();
      if (token) setInvite({ token });
      const kolab = askedBy(location.hash);
      // Another kolab's address, on a page showing a place: asked before anything shown is put away.
      // Declined, the address is written back as it was, in place, and nothing else changes: the
      // page stays with what was drafted there, and the entry moved to now holds this place.
      const elsewhere = kolab !== undefined && kolab !== meNow.current?.kolab && kolab !== askedNow.current;
      if (elsewhere && meNow.current && settled.current && !confirmMove(`Work in ${kolab}`)) { at(seenNow.current); return; }
      askedNow.current = kolab;
      seenNow.current = location.hash;
      setSeen(location.hash);
      setRoute(parseRoute(location.hash));
      setAsked(kolab);
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  // Live: every signal re-reads what the page shows (API8).
  // A stream that closes, as when Kolab restarts, is not the session's end: Kolab's `ended` is,
  // unless the browser holds another by then, as when another tab moved to another kolab.
  useLive(!!me, {
    onChange: pushTick,
    onEnded: recheck,
    onDropped: recheck,
    // What a break may have missed includes the session's own move, in another tab: asked, and followed.
    onResumed: () => {
      void recheck();
      void pageUpdated().then((u) => { if (u) setUpdated(true); });
    },
  });

  const act: Act = {
    async run(what, done, told) {
      try {
        const out = await what();
        const words = told ? told(out) : done;
        if (words) say(words);
        setTick((t) => t + 1);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { if (await recheck()) say('That didn’t go through while Kolab reconnected: try it again.'); } else say((e as Error).message);
        return false;
      }
    },
  };
  const go = (r: string) => { location.hash = placeLink(me?.kolab, r); };
  /**
   * After the session moved to another kolab or role: a fresh page, at its home, and the address
   * names the kolab; an address that asked for another kolab meanwhile is left, to be taken up next.
   */
  const moved = (next: WebMe, what: string) => { if (!askedNow.current || askedNow.current === next.kolab) location.hash = placeLink(next.kolab, ''); say(what); };
  /** Whether a move may start: not while another is under way, and then nothing is asked or sent. */
  const free = () => { if (gate.current) say('The session is on its way to another kolab or role: wait for it.'); return !gate.current; };
  const move = (kolab: string, role: string) => {
    if (!free() || (me && !confirmMove(kolab === me.kolab ? `Work as ${role}` : `Work in ${kolab}`))) return Promise.resolve(false);
    return act.run(() => gated(async () => {
      const next = await moveBy(() => switchTo(kolab, role));
      if (next) moved(next, `Working in ${next.kolab} as ${next.role}`);
    }), '');
  };

  /**
   * The address and the session agree on the kolab. An address that names none, or the session's,
   * is written with the session's kolab, in place, so the one in the address bar is a link to here.
   * One that names another kolab moves the session there, as the picker does, once no other move
   * is under way. A move under way finishes: when it returns the page is in that kolab, and the address is
   * written to say so, whatever was pressed meanwhile; an address set to a third kolab meanwhile is
   * taken up next. A kolab Kolab won't open is said so, one way whether it exists or not, the
   * address is written back to where the page was, and nothing is asked of Kolab again until the
   * person moves again. Only an address moves the session: when the session's kolab changes under
   * the page, as from another tab, the address follows it.
   */
  useEffect(() => {
    // Signed out, nothing is held to go back to, or to ask about: the next sign-in starts as a fresh load does.
    if (!me) { settled.current = undefined; return; }
    if (location.hash !== seen) return;
    if (!asked || asked === me.kolab) {
      const here = placeLink(me.kolab, parsePlace(location.hash).place);
      if (location.hash !== here) { at(here); setSeen(location.hash); }
      settled.current = here;
      forgetPlace();
      if (asked) setAsked(undefined);
      return;
    }
    if (gate.current) return;
    const to = asked;
    /** The switch isn't to be: it is asked for no more, and its address gives way to where the page was. */
    const stay = () => {
      // Another kolab asked for meanwhile is taken up next, not undone.
      if (askedNow.current !== to) return;
      askedNow.current = undefined;
      setAsked(undefined);
      // An address set meanwhile is read when it arrives, and isn't written over.
      if (location.hash !== seenNow.current) return;
      at(settled.current ?? placeLink(meNow.current?.kolab, ''));
      setSeen(location.hash);
      setRoute(parseRoute(location.hash));
    };
    // The gate is held until the refusal is dealt with, so nothing sends the switch again meanwhile.
    void gated(async () => {
      try {
        const next = await moveBy(() => switchTo(to, me.role));
        if (next) say(`Working in ${next.kolab} as ${next.role}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // A session that ended keeps the address: signing in again opens it.
          if (!(await recheck())) return;
          // Another tab had moved the session there already: the page has arrived, at the place asked for.
          if (meNow.current?.kolab === to) return;
          say('That didn’t go through while Kolab reconnected: try it again.');
        } else say(e instanceof ApiError && [400, 403, 404].includes(e.status) ? `There’s no kolab ${to} you can reach. You’re still in ${meNow.current?.kolab}.` : (e as Error).message);
        stay();
      }
    });
  }, [me, asked, seen, turn, recheck, say, moveBy, gated]);

  const docs = [...(overview?.nodes ?? []), ...(moreNodes?.nodes ?? [])];
  const specs = [...docs].sort((a, b) => (KIND_ORDER[a.kind] ?? 5) - (KIND_ORDER[b.kind] ?? 5));
  const home = specs.find((n) => n.kind === 'spec') ?? specs[0];
  // Home is the person's inbox (WEB1); a kolab with nothing written yet starts at its first step.
  const r: Route = me && asked && asked !== me.kolab ? { view: 'opening' } : route.view === 'home' ? (home ? { view: 'inbox' } : { view: 'start' }) : route;
  // A full address in the session's own kolab is its own node's page; another kolab's is read in place.
  const nodeRoute = r.view === 'node' && r.kolab === me?.kolab ? { ...r, kolab: undefined } : r;
  const reading = (nodeRoute.view === 'node' && nodeRoute.kolab !== undefined) || nodeRoute.view === 'read';
  const kolabTitle = overview?.kolab.title || me?.kolab || 'Kolab';
  // The page names itself (WCAG 2.4.2): what it shows, in which kolab.
  const place = !me ? 'Sign in' : nodeRoute.view === 'node'
    ? (nodeRoute.kolab ? `kj:${nodeRoute.kolab}/${nodeRoute.name}` : docs.find((n) => n.name === nodeRoute.name)?.title ?? `kj:${nodeRoute.name}`)
      + (nodeRoute.focus ? ` #${nodeRoute.focus.split('#')[1]}` : '')
    : nodeRoute.view === 'read' ? `Reading ${nodeRoute.kolab}` : nodeRoute.view === 'rulings' && nodeRoute.ref ? `Ruling ${nodeRoute.ref}` : PLACE[nodeRoute.view] ?? '';
  useEffect(() => { document.title = !me ? 'Kolab' : place ? `${place} · ${kolabTitle} · Kolab` : `${kolabTitle} · Kolab`; }, [me, place, kolabTitle]);
  // On a narrow screen the rail scrolls sideways: the place shown stays in view. Only the rail
  // scrolls, never the page, so a jump to an element (#/node/x#ID) stays where it landed.
  // Its documents arrive with the overview: the key changes then too, so the current one is brought into view.
  const railKey = `${nodeRoute.view}:${nodeRoute.view === 'node' ? `${nodeRoute.kolab ?? ''}/${nodeRoute.name}` : ''}:${docs.length}`;
  useEffect(() => {
    const rail = document.querySelector<HTMLElement>('.rail');
    const current = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !current || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollLeft = current.offsetLeft - (rail.clientWidth - current.offsetWidth) / 2;
  }, [railKey]);
  const mainRef = useRef<HTMLElement>(null);

  const inviteNote = invite?.error ? <p className="notice" role="alert">{invite.error}</p> : null;
  const awayNote = away ? <p className="notice live-note" role="status">Kolab is restarting: reconnecting…</p> : null;
  const updatedNote = updated ? (
    <p className="notice live-note" role="status">Kolab was updated. <button type="button" className="btn" onClick={() => location.reload()}>Reload</button></p>
  ) : null;
  if (me === undefined) return <p className="empty" style={{ padding: 24 }}>{away ? 'Kolab is restarting: reconnecting…' : 'Connecting to Kolab…'}</p>;
  if (me === null) {
    return (
      <>
        <Bar theme={theme} setTheme={(t) => { setTheme(t); store.set('konjir.theme', t); }} />
        {(invite?.preview || inviteNote) && <div className="signin-invite">{invite?.preview ? <InviteCard invite={invite.preview} signedIn={false} /> : inviteNote}</div>}
        <SignIn error={signInError} methods={methods} onLeave={keepPlace} onSignedIn={async (token) => {
          try { setMe(await signIn(token)); setSignInError(undefined); return undefined; } catch (e) { return (e as Error).message; }
        }} />
      </>
    );
  }

  const counts = overview?.counts;
  const belongs = me.access.layers.length > 0;
  const live = specs.filter((n) => n.kind !== 'plan');
  const retired = specs.filter((n) => n.kind === 'plan');
  const docButton = (n: typeof specs[number]) => (
    <button key={n.name} type="button" className="place" title={n.title} aria-current={nodeRoute.view === 'node' && !nodeRoute.kolab && nodeRoute.name === n.name ? 'page' : undefined} onClick={() => go(`node/${n.name}`)}>
      {shortTitle(n.title, kolabTitle)}{n.in_review > 0 && <span className="count question" title={`${n.in_review} in review`}>{n.in_review}</span>}
    </button>
  );
  return (
    <Here value={me.kolab}>
      <a className="skip" href="#/" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Skip to the page’s content</a>
      <Bar theme={theme} setTheme={(t) => { setTheme(t); store.set('konjir.theme', t); }} me={me} overview={overview}
        onMove={move} busy={busy} onAllKolabs={() => go('kolabs')}
        onSignOut={async () => { leaving.current = true; await signOut().catch(() => undefined); signedOut('Signed out. Your session has ended.'); }} />
      <div className="frame">
        <div className="side">
        <nav className="rail" aria-label="Places">
          <button type="button" className="place" aria-current={r.view === 'inbox' ? 'page' : undefined} onClick={() => go('inbox')}>
            Inbox{counts && counts.waiting + counts.reviews + counts.stale + counts.cases > 0
              ? <span className="count question" title="Waiting on you: reviews, questions, marks and case files">{counts.waiting + counts.reviews + counts.stale + counts.cases}</span> : null}
          </button>
          <div className="rail-label">Documents</div>
          {live.map(docButton)}
          <More more={nodesNext ? readMoreNodes : undefined} busy={readingNodes} what="documents" />
          {me.access.layers.includes(me.layer) && <button type="button" className="place add" aria-current={r.view === 'new' ? 'page' : undefined} onClick={() => go('new')}>New document</button>}
          <div className="rail-label">{kolabTitle}</div>
          {(['work', 'questions', 'reviews', ...(belongs ? ['rulings' as const, 'cases' as const] : []), 'lineage', 'activity', 'people', 'settings', 'connect', 'sessions'] as const).map((v) => (
            <button key={v} type="button" className="place" aria-current={r.view === v ? 'page' : undefined} onClick={() => go(v)}>
              {PLACE[v]}
              {v === 'questions' && counts?.waiting ? <span className="count question" title={`${counts.waiting} waiting on you`}>{counts.waiting}</span> : null}
              {v === 'reviews' && counts?.reviews ? <span className="count question" title={`${counts.reviews} waiting for your review`}>{counts.reviews}</span> : null}
              {v === 'cases' && counts?.cases ? <span className="count stale" title={`${counts.cases} open on your layer`}>{counts.cases}</span> : null}
            </button>
          ))}
          {retired.length > 0 && <><div className="rail-label">Retired</div>{retired.map(docButton)}</>}
          <div className="rail-label">Konjir</div>
          <button type="button" className="place" aria-current={r.view === 'kolabs' ? 'page' : undefined} onClick={() => go('kolabs')}>All kolabs</button>
        </nav>
          <GoTo here={me.kolab} go={go} />
          <div className="rail-foot"><span>{me.name} · {me.role} · {me.kolab}</span>
            {me.konjirAdmin && <span title="You are a Konjir admin: run admin verbs from the konjir CLI or MCP, signed in as yourself">Konjir admin</span>}</div>
        </div>
        {/* Keyed by the session's kolab and role: when either changes, by whatever route, every place starts afresh, and nothing drafted in one is left to submit in another. */}
        <main key={`${me.kolab}/${me.role}`} id="main" ref={mainRef} tabIndex={-1}>
          {nodeRoute.view !== 'node' && !['kolabs', 'people', 'connect', 'sessions', 'inbox', 'work', 'rulings', 'settings'].includes(r.view) && !(nodeRoute.view === 'read' && nodeRoute.kolab !== me.kolab)
            && <h1 className="sr-only">{place}</h1>}
          {awayNote}
          {updatedNote}
          {invite?.preview && <InviteCard invite={invite.preview} signedIn onDismiss={() => { setInvite(undefined); void dropInvite().catch(() => undefined); }}
            onJoin={() => free() && act.run(() => gated(async () => {
              const next = await moveBy(() => acceptInvite(invite.token));
              if (!next) return;
              setInvite(undefined);
              moved(next, `Joined ${next.kolab}: you work here as ${next.role}`);
            }), '')} />}
          {inviteNote}
          {/* What waits is the inbox's now (and the rail's count); only a kolab with nothing written yet keeps the summary, to say where to start. */}
          {overview && r.view === 'start' && <Summary overview={overview} />}
          {nodeRoute.view === 'node' && <NodeView key={`${nodeRoute.kolab ?? ''}/${nodeRoute.name}`} me={me} name={nodeRoute.name} version={nodeRoute.version} focus={nodeRoute.focus}
            kolab={nodeRoute.kolab} tick={tick} act={act} go={go}
            read={(v) => go(`${nodeRoute.kolab ? `read/${nodeRoute.kolab}` : 'node'}/${nodeRoute.name}${v ? `@${v}` : ''}`)} />}
          {nodeRoute.view === 'read' && (nodeRoute.kolab === me.kolab ? <p className="empty">This is the kolab you work in: its documents are in the rail.</p>
            : <ForeignKolabView kolab={nodeRoute.kolab} tick={tick} go={go} onOpen={(k) => move(k, me.role)} />)}
          {r.view === 'opening' && <p className="empty">Opening {asked}…</p>}
          {r.view === 'questions' && <QuestionsView me={me} tick={tick} act={act} go={go} />}
          {r.view === 'cases' && <CasesView me={me} tick={tick} act={act} go={go} />}
          {r.view === 'reviews' && <ReviewsView tick={tick} act={act} go={go} />}
          {r.view === 'lineage' && <LineageView tick={tick} go={go} focus={r.focus} />}
          {r.view === 'activity' && <ActivityView tick={tick} here={me.kolab} />}
          {r.view === 'start' && <GettingStarted me={me} go={go} />}
          {r.view === 'inbox' && overview && <InboxView me={me} overview={overview} tick={tick} go={go} />}
          {r.view === 'work' && <WorkView me={me} tick={tick} go={go} />}
          {r.view === 'rulings' && <RulingsView me={me} tick={tick} go={go} focus={r.ref} />}
          {r.view === 'settings' && <SettingsView me={me} tick={tick} act={act} />}
          {r.view === 'missing' && (
            <section className="notice" role="alert">
              <h2>There’s no page at <span className="addr">#/{r.view === 'missing' ? r.what : ''}</span></h2>
              <p>Kolab has no place by that name. Choose one from the rail, or search for an address.</p>
            </section>
          )}
          {r.view === 'people' && overview && <PeopleView me={me} overview={overview} tick={tick} act={act} />}
          {r.view === 'connect' && <ConnectPage me={me} />}
          {r.view === 'sessions' && <SessionsView tick={tick} act={act} />}
          {r.view === 'new' && !me.access.layers.includes(me.layer) && <p className="empty">Working as {me.role}, you don’t write the {me.layer} layer here, so you make no document in it.</p>}
          {(r.view === 'start' || r.view === 'new') && overview && <KolabsView start overview={overview} act={act} onCreated={(n) => go(`node/${n}`)} onOpen={(k) => move(k, me.role)} onCreateKolab={async () => false} />}
          {r.view === 'kolabs' && overview && <KolabsView overview={overview} act={act} onCreated={(n) => go(`node/${n}`)} onOpen={(k) => move(k, me.role)} onRead={(k) => go(`read/${k}`)}
            onCreateKolab={async (name, title) => free() && act.run(() => gated(async () => {
              const next = await moveBy(() => createKolab(name, title));
              if (next) moved(next, `Created ${name}. Its spec is empty: start it.`);
            }), '')} />}
        </main>
      </div>
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </Here>
  );
}

/**
 * Goes to a `kj:` address: in the session's kolab, the node's page; in another kolab, read in place,
 * where Kolab answers only if the session may read it (D49), and a refusal says nothing of what is there.
 */
function GoTo({ here, go }: { here: string; go(r: string): void }) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  // What was typed stays, so a mistyped address can be fixed rather than typed again.
  return (
    <form className="goto" role="search" onSubmit={(e) => {
      e.preventDefault();
      // A ruling's name, D104, opens it among the rulings; anything else is an address.
      const ref = /^\s*(D\d{1,4})\s*$/i.exec(text);
      if (ref) { setBad(false); go(`rulings/${ref[1].toUpperCase()}`); return; }
      const a = parseKj(text);
      setBad(!a);
      if (a) go(routeOf(a, here));
    }}>
      <label htmlFor="goto">Go to an address or ruling</label>
      <input id="goto" value={text} spellCheck={false} autoComplete="off" aria-invalid={bad} aria-describedby="goto-hint"
        onChange={(e) => { setText(e.target.value); setBad(false); }} />
      {/* Always there, so a screen reader announces the error when its text arrives. */}
      <span id="goto-hint" className={bad ? 'err' : 'hint'} aria-live="polite">
        {bad ? 'That isn’t an address. One looks like kj:kolab#TEN1, or kj:other-kolab/node#R1; a ruling, D104.' : <>For example <span className="mono">kj:{here}#R1</span> or <span className="mono">D104</span></>}
      </span>
    </form>
  );
}

function Summary({ overview: o }: { overview: WebOverview }) {
  const { stale, waiting, reviews, open } = o.counts;
  const parts = [
    stale ? `${stale} element${stale > 1 ? 's are' : ' is'} stale on your layer` : '',
    waiting ? `${waiting} question${waiting > 1 ? 's wait' : ' waits'} on you` : '',
    reviews ? `${reviews} review${reviews > 1 ? 's wait' : ' waits'} for you` : '',
  ].filter(Boolean);
  const lead = !o.nodes.length ? 'Nothing written yet. Start with the spec.' : parts.length ? `${parts.join(', ')}.` : 'Everything holds.';
  return (
    <section className="summary" aria-label="Summary">
      <p className="summary-lead">{lead.charAt(0).toUpperCase() + lead.slice(1)}</p>
      {o.nodes.filter((n) => n.latest !== null).slice(0, 4).map((n) => <span key={n.name} className="fact">{n.title} <b className="mono">v{n.latest}</b></span>)}
      <span className="fact"><b>{open}</b> open question{open === 1 ? '' : 's'} in total</span>
    </section>
  );
}

function Bar({ theme, setTheme, me, overview, onSignOut, onMove, busy, onAllKolabs }: {
  theme: Theme; setTheme(t: 'light' | 'dark'): void; me?: WebMe; overview?: WebOverview;
  onSignOut?(): void; onMove?(kolab: string, role: string): void; onAllKolabs?(): void;
  /** A move to another kolab or role is under way: the picker and the role wait for it. */
  busy?: boolean;
}) {
  const dark = theme ? theme === 'dark' : !(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches);
  const [open, setOpen] = useState(false);
  const current = overview?.kolab;
  const pick = useRef<HTMLDivElement>(null);
  // The menu closes on Escape, giving focus back to its button, and on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); pick.current?.querySelector<HTMLButtonElement>('.kolab-btn')?.focus(); } };
    const click = (e: MouseEvent) => { if (!pick.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('keydown', key);
    addEventListener('mousedown', click);
    return () => { removeEventListener('keydown', key); removeEventListener('mousedown', click); };
  }, [open]);
  return (
    <header className="bar">
      <div className="bar-in">
        <a className="brand" href={placeLink(me?.kolab, '')} aria-label="Konjir, home"><Wordmark /></a>
        {me && (
          <div className="kolab-pick" ref={pick}>
            <button type="button" className="kolab-btn" aria-expanded={open} aria-controls="kolabMenu" aria-label={`Kolab: ${current?.title || me.kolab}. Switch kolab`} onClick={() => setOpen(!open)}>
              <span className="lbl">Kolab</span><span className="nm">{current?.title || me.kolab}</span>
              <svg viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4l2.5 2.5L7.5 4" /></svg>
            </button>
            {open && (
              <div className="menu" id="kolabMenu">
                {(overview?.kolabs ?? []).map((k) => (
                  <button key={k.id} type="button" className="mi" aria-current={k.current} disabled={busy && !k.current} onClick={() => { setOpen(false); if (!k.current) onMove?.(k.id, me.role); }}>
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
                <button key={r} type="button" role="radio" aria-checked={me.role === r} disabled={busy && me.role !== r} title={me.role === r ? `You work as ${r}` : `Switch to ${r}: this session ends, and one opens in that role`}
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

