import { REFRESH_HEADER, type InvitePreview, type WebError, type WebMe } from '@konjir/types';

/**
 * The page's re-reads a push caused (D100): `tick` values the event stream, or Kolab's own check
 * after it dropped, moved to, never one a person's action moved to. Only the last few are kept.
 */
const pushTicks = new Set<number>();
export function markPushTick(tick: number) {
  pushTicks.add(tick);
  if (pushTicks.size > 100) pushTicks.delete(pushTicks.values().next().value!);
}

/**
 * Whether a read keyed by `key` (what it reads) runs now because a push moved `tick`: the same read
 * as last time, with only the tick moved, to one a push made. `last` is the read's own memory.
 */
export function pushed(last: { current: { key: string; tick: number } | undefined }, key: string, tick: number): boolean {
  const was = last.current;
  last.current = { key, tick };
  return !!was && was.key === key && was.tick !== tick && pushTicks.has(tick);
}

/** A refusal from Kolab's API: its HTTP status and its message, which says what to do. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

/**
 * Calls Kolab's web API (/api). The session rides in an HttpOnly cookie Kolab set at sign-in, so
 * this page never holds the token; the browser sends the page's own origin, which Kolab requires
 * for changes.
 */
export async function api<T>(path: string, body?: unknown, method?: string, opts: { push?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' };
  // A read the page makes by itself, after a pushed event, says so: it renews no lease on the
  // person's work (D100). The mark only withholds a renewal; it never grants anything.
  if (opts.push) headers[REFRESH_HEADER] = 'push';
  const res = await fetch(`/api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // A proxy's error page (Kolab restarting) isn't JSON: say what status came back instead.
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!res.ok) {
    const e = data as Partial<WebError> | undefined;
    throw new ApiError(res.status, typeof e?.message === 'string' ? e.message : `Kolab answered ${res.status}${res.status >= 500 ? ': it may be restarting. Try again in a moment' : ''}`);
  }
  return data as T;
}

/**
 * Whether a failure is Kolab being briefly away, as while it restarts behind its proxy: no answer
 * at all (fetch's TypeError), or a 5xx such as the proxy's 502. Never a sign the session ended.
 */
export function transient(e: unknown): boolean {
  return e instanceof ApiError ? e.status >= 500 : e instanceof TypeError;
}

/** How long to wait before the next try while Kolab is away: 0.5 s, doubling, at most 15 s. */
export const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 15_000);

/** The page's clock for waiting out a restart; the tests make it instant. */
export const clock = { wait: (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }) };

/** While a call waits for Kolab to come back: `onWait` hears each retry, and `alive` going false stops it. */
export interface Patience { onWait?(): void; alive?(): boolean }

/** Runs a call, trying again with backoff while Kolab is away (transient); any other failure is thrown at once. */
export async function patiently<T>(fn: () => Promise<T>, p: Patience = {}): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (!transient(e) || p.alive?.() === false) throw e; }
    p.onWait?.();
    await clock.wait(backoff(i));
  }
}

/** How long a 401 is given to be a refresh in flight before it counts. */
export const RECHECK_401_MS = 1000;

/**
 * Who the session is, asked so that a restart can't sign the page out: Kolab away is waited out,
 * and a 401 is asked once more after a moment, since another of the page's calls may have just
 * refreshed the session (D55) and its new cookie be on its way. Null only when Kolab says twice,
 * each time after its own try at a refresh, that there is no session.
 */
export async function whoAmI(p: Patience & { push?: boolean } = {}): Promise<WebMe | null> {
  for (let i = 0; i < 2; i++) {
    try { return await patiently(() => api<WebMe>('me', undefined, undefined, { push: p.push }), p); } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e; }
    if (i === 0) await clock.wait(RECHECK_401_MS);
  }
  return null;
}

/**
 * Whether Kolab now serves a newer page than this one, as after a deploy: its index.html names
 * another entry script (Vite names each by its content hash). False when that can't be told.
 */
export async function pageUpdated(): Promise<boolean> {
  const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src');
  if (!mine || typeof DOMParser === 'undefined') return false;
  try {
    const res = await fetch('/', { headers: { accept: 'text/html' }, cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return false;
    const theirs = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('script[type="module"][src]')?.getAttribute('src');
    return !!theirs && theirs !== mine;
  } catch { return false; }
}

export const signIn = (token: string) => api<WebMe>('session', { token });
/** Ends the session: its token is revoked, so signing in again takes a new one. */
export const signOut = () => api<void>('session', undefined, 'DELETE');
/** Ends this session and opens one in another kolab or role; Kolab keeps the new token in the cookie. */
export const switchTo = (kolab: string, role: string) => api<WebMe>('session/switch', { kolab, role });
export const createKolab = (name: string, title: string) => api<WebMe>('session/kolab', { name, title });
/** What an invite's link offers (W3.4); Kolab keeps it for the sign-in that follows. */
export const openInvite = (token: string) => api<InvitePreview>('session/invite', { token });
/** The signed-in person joins the invite's kolab: Kolab grants its access and moves the session there. */
/** Not now: Kolab forgets the invite this browser opened. */
export const dropInvite = () => api<void>('session/invite', undefined, 'DELETE');
export const acceptInvite = (token: string) => api<WebMe>('session/invite/accept', { token });
