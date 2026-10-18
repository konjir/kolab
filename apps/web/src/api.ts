import type { WebError, WebMe } from '@konjir/types';

/** A refusal from Kolab's API: its HTTP status and its message, which says what to do. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

/**
 * Calls Kolab's web API (/api). The session rides in an HttpOnly cookie Kolab set at sign-in, so
 * this page never holds the token; the browser sends the page's own origin, which Kolab requires
 * for changes.
 */
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
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

export const signIn = (token: string) => api<WebMe>('session', { token });
/** Ends the session: its token is revoked, so signing in again takes a new one. */
export const signOut = () => api<void>('session', undefined, 'DELETE');
/** Ends this session and opens one in another kolab or role; Kolab keeps the new token in the cookie. */
export const switchTo = (kolab: string, role: string) => api<WebMe>('session/switch', { kolab, role });
export const createKolab = (name: string, title: string) => api<WebMe>('session/kolab', { name, title });
