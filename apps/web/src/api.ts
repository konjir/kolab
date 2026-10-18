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
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data as Partial<WebError> | undefined;
    throw new ApiError(res.status, typeof e?.message === 'string' ? e.message : `Kolab answered ${res.status}`);
  }
  return data as T;
}

export const signIn = (token: string) => api<WebMe>('session', { token });
export const signOut = () => api<void>('session', undefined, 'DELETE');
