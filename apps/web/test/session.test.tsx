// The page across a restart of Kolab (a deploy): a dropped event stream, a proxy's 502 or no answer
// at all never signs the person out; only Kolab saying, after its own try at a refresh, that the
// session is gone does, and then the page shows this Kolab's own sign-in, as a fresh load would.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { WebMe, WebOverview, WebSignInMethods } from '@konjir/types';
import { App } from '../src/App.js';
import { clock, transient, ApiError } from '../src/api.js';

const ann: WebMe = { actor: 'ann', name: 'Ann', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'anns', access: { level: 'admin', layers: ['functional', 'technical'] } };
const overview: WebOverview = {
  me: ann, kolab: { id: 'anns', title: 'Ann’s', owner: 'ann', visibility: 'private', current: true, access: ann.access },
  kolabs: [], nodes: [], counts: { stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0 },
};
const GITHUB: WebSignInMethods = { provider: 'GitHub', token: false };

/** A reply: a status and body, or no answer at all (the connection refused while Kolab restarts). */
type Reply = { status: number; body?: unknown; html?: string } | 'network';
const ok = (body: unknown): Reply => ({ status: 200, body });
const BAD_GATEWAY: Reply = { status: 502, html: '<html><body>502 Bad Gateway</body></html>' };
const UNAUTHORIZED: Reply = { status: 401, body: { error: 'unauthorized', message: 'sign in again with GitHub' } };

/** Each path's replies, taken in turn; the last one repeats. */
let replies: Record<string, Reply[]>;
let calls: string[];
const reply = (path: string, ...r: Reply[]) => { replies[path] = r; };

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.all.push(this); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  send(data: unknown) { this.readyState = FakeEventSource.OPEN; this.onmessage?.({ data: JSON.stringify(data) }); }
  /** The browser gives up on the stream: a reply that isn't one, such as a proxy's 502. */
  fail() { this.readyState = FakeEventSource.CLOSED; this.onerror?.(); }
  static get last() { return FakeEventSource.all[FakeEventSource.all.length - 1]; }
}

const realWait = clock.wait;
beforeEach(() => {
  replies = {};
  calls = [];
  FakeEventSource.all = [];
  clock.wait = async () => undefined;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = jest.fn(async (url: string | URL | Request) => {
    const path = String(url);
    calls.push(path);
    const queue = replies[path];
    const r = !queue ? ok({}) : queue.length > 1 ? queue.shift()! : queue[0];
    if (r === 'network') throw new TypeError('Failed to fetch');
    return { ok: r.status < 400, status: r.status, text: async () => r.html ?? JSON.stringify(r.body ?? {}) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  clock.wait = realWait;
  delete (globalThis as { EventSource?: unknown }).EventSource;
  document.querySelectorAll('script[data-test]').forEach((s) => s.remove());
});

/** Signs Ann in, with the page's stream open. */
async function signedIn(methods: WebSignInMethods = GITHUB) {
  reply('/api/session/methods', ok(methods));
  reply('/api/me', ok(ann));
  reply('/api/overview', ok(overview));
  render(<App />);
  await screen.findByText('Working as');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  act(() => FakeEventSource.last.send({ type: 'ready' }));
}
const meCalls = () => calls.filter((c) => c === '/api/me').length;
const overviewCalls = () => calls.filter((c) => c === '/api/overview').length;

test('a failure is transient only when Kolab is away: no answer, or a 5xx; a 401 or 403 is not', () => {
  expect(transient(new TypeError('Failed to fetch'))).toBe(true);
  expect(transient(new ApiError(502, 'Kolab answered 502'))).toBe(true);
  expect(transient(new ApiError(503, 'x'))).toBe(true);
  expect(transient(new ApiError(401, 'sign in again'))).toBe(false);
  expect(transient(new ApiError(403, 'forbidden'))).toBe(false);
  expect(transient(new Error('other'))).toBe(false);
});

test('a restart doesn\'t sign you out: the stream drops, /api/me finds no server then a 502, then Kolab is back, and the page carries on', async () => {
  await signedIn();
  const before = overviewCalls();
  reply('/api/me', 'network', BAD_GATEWAY, BAD_GATEWAY, ok(ann));
  await act(async () => FakeEventSource.last.fail());
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
  expect(meCalls()).toBeGreaterThanOrEqual(5);
  expect(screen.queryByRole('heading', { name: 'Sign in to Kolab' })).toBeNull();
  expect(screen.getByText('Working as')).toBeTruthy();
  // What the page shows is read again, since signals may have been missed meanwhile.
  await waitFor(() => expect(overviewCalls()).toBeGreaterThan(before));
});

test('the page\'s first load during a restart waits for Kolab rather than showing the sign-in', async () => {
  reply('/api/session/methods', BAD_GATEWAY, ok(GITHUB));
  reply('/api/me', 'network', BAD_GATEWAY, ok(ann));
  reply('/api/overview', ok(overview));
  render(<App />);
  await screen.findByText('Working as');
  expect(screen.queryByRole('heading', { name: 'Sign in to Kolab' })).toBeNull();
});

test('a 401 that a refresh in flight explains (the call raced another\'s refresh) doesn\'t sign you out', async () => {
  await signedIn();
  reply('/api/me', UNAUTHORIZED, ok(ann));
  await act(async () => FakeEventSource.last.fail());
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
  expect(screen.queryByRole('heading', { name: 'Sign in to Kolab' })).toBeNull();
});

test('a session that really ended shows Sign in with GitHub, never the token form, even when Kolab was away as it ended', async () => {
  await signedIn();
  // The methods were learned as the page loaded: Kolab being away now can't turn them into a guess.
  reply('/api/session/methods', BAD_GATEWAY);
  reply('/api/me', BAD_GATEWAY, UNAUTHORIZED);
  await act(async () => FakeEventSource.last.fail());
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  expect(screen.getByRole('link', { name: 'Sign in with GitHub' }).getAttribute('href')).toBe('/api/session/oauth/start');
  expect(screen.queryByLabelText('Session token')).toBeNull();
  expect(screen.queryByText(/admin_open_session/)).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.');
  expect(FakeEventSource.all).toHaveLength(1);
});

test('a fresh load with no session, while Kolab is still coming up, waits for the methods and shows Sign in with GitHub', async () => {
  reply('/api/session/methods', 'network', BAD_GATEWAY, ok(GITHUB));
  reply('/api/me', UNAUTHORIZED);
  render(<App />);
  expect(await screen.findByRole('link', { name: 'Sign in with GitHub' })).toBeTruthy();
  expect(screen.queryByLabelText('Session token')).toBeNull();
});

test('the token form shows only when Kolab takes hand-issued tokens and offers no identity provider', async () => {
  reply('/api/session/methods', ok({ provider: null, token: true }));
  reply('/api/me', UNAUTHORIZED);
  const { unmount } = render(<App />);
  expect(await screen.findByLabelText('Session token')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Sign in with/ })).toBeNull();
  unmount();

  // Methods Kolab won't give (a refusal, not a restart): no token form on a guess.
  reply('/api/session/methods', { status: 403, body: { error: 'forbidden', message: 'no' } });
  render(<App />);
  await screen.findByText(/no way to sign in from the web set up yet/);
  expect(screen.queryByLabelText('Session token')).toBeNull();
});

test('Kolab saying `ended` on the stream signs the page out at once', async () => {
  await signedIn();
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  await screen.findByRole('link', { name: 'Sign in with GitHub' });
});

test('an overview refused with a 401 is checked before the page signs out', async () => {
  reply('/api/session/methods', ok(GITHUB));
  reply('/api/me', ok(ann));
  reply('/api/overview', UNAUTHORIZED, ok(overview));
  render(<App />);
  await screen.findByText('Working as');
  await waitFor(() => expect(overviewCalls()).toBeGreaterThanOrEqual(2));
  expect(screen.queryByRole('heading', { name: 'Sign in to Kolab' })).toBeNull();
});

test('after a restart onto a new build, the page offers to reload', async () => {
  const s = document.createElement('script');
  s.type = 'module';
  s.src = '/assets/index-old.js';
  s.dataset.test = '';
  document.head.appendChild(s);
  await signedIn();
  reply('/', { status: 200, html: '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-new.js"></script></head><body></body></html>' });
  act(() => { FakeEventSource.last.fail(); });
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
  act(() => FakeEventSource.last.send({ type: 'ready' }));
  expect(await screen.findByText(/Kolab was updated/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
});

test('a reconnect onto the same build offers no reload', async () => {
  const s = document.createElement('script');
  s.type = 'module';
  s.src = '/assets/index-same.js';
  s.dataset.test = '';
  document.head.appendChild(s);
  await signedIn();
  reply('/', { status: 200, html: '<script type="module" src="/assets/index-same.js"></script>' });
  act(() => { FakeEventSource.last.fail(); });
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
  act(() => FakeEventSource.last.send({ type: 'ready' }));
  await waitFor(() => expect(calls).toContain('/'));
  expect(screen.queryByText(/Kolab was updated/)).toBeNull();
});
