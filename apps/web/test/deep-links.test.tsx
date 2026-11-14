// Every place's address names its kolab, #/k/<kolab>/<place>: one copied from the address bar opens
// the same place for whoever can reach that kolab. An address without a kolab means the session's,
// and is rewritten in place; one that names another kolab moves the session there, as the picker
// does, and a kolab Kolab won't open is said so, with the page left where it was.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InvitePreview, WebMe, WebNodeView, WebOverview, WebSignInMethods } from '@konjir/types';
import { App, inviteOf, parseRoute } from '../src/App.js';
import { clock } from '../src/api.js';
import { parsePlace, placeLink } from '../src/util.js';

const ann: WebMe = { actor: 'ann', name: 'Ann', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'anns', access: { level: 'admin', layers: ['functional', 'technical'] } };
const inBilling: WebMe = { ...ann, kolab: 'billing' };
const card = (id: string, title: string, current: boolean): WebOverview['kolab'] => ({ id, title, owner: 'ann', visibility: 'private', current, access: ann.access });
const TITLES: Record<string, string> = { anns: 'Ann’s', billing: 'Billing', third: 'Third' };
const overviewOf = (me: WebMe): WebOverview => ({
  me, kolab: card(me.kolab, TITLES[me.kolab], true),
  kolabs: Object.keys(TITLES).map((k) => card(k, TITLES[k], me.kolab === k)),
  nodes: [], nodes_next: null, counts: { stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0 },
});
const GITHUB: WebSignInMethods = { provider: 'GitHub', token: false };

type Reply = { status: number; body?: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const NO_KOLAB: Reply = { status: 403, body: { error: 'forbidden', message: 'no kolab nowhere you can reach' } };
const UNAUTHORIZED: Reply = { status: 401, body: { error: 'unauthorized', message: 'sign in' } };
const TOKEN = `kji_${'a'.repeat(43)}`;
const invite: InvitePreview = { kolab: 'billing', title: 'Billing', owner: 'bo', level: 'write', layers: ['technical'], invited_by: 'Bo', expires_at: new Date(Date.now() + 86_400_000).toISOString() };
const at = new Date().toISOString();
/** A document Ann can edit, so the page holds a draft. */
const doc: WebNodeView = {
  node: { name: 'password-reset', kind: 'spec', layer: 'functional', title: 'Password reset', latest: 3, drafts: 0, in_review: 0 },
  reading: { seq: 3, state: 'committed', author: 'Ann', role: 'product', at, note: null, mine: true },
  versions: [], versions_next: null,
  elements: [{ id: 'PR8', parent: null, text: 'At most 3 reset requests per hour.', address: 'kj:password-reset@3#PR8', queries: [], relies_on: [], relied_on_by: [], marks: [], rulings: [], cases: [] }],
  queries: [], queries_next: null, compared_with: null, in_review: [], drafts: [], can_write: true, rulings: [], kolab: 'anns', foreign: false,
};
/** Billing's document of the same name. */
const billingDoc: WebNodeView = { ...doc, kolab: 'billing', elements: [{ ...doc.elements[0], text: 'Billing resets nothing.' }] };

/** Whose session the browser's cookie holds, which a switch Kolab allows changes; null is signed out. */
let session: WebMe | null;
let switchReply: (kolab: string) => Reply;
let switches: { kolab: string; role: string }[];
let asked: string[];
let confirms: boolean;
let methods: WebSignInMethods;
/** While set, a switch waits for it before Kolab answers. */
let hold: Promise<void> | undefined;
/** Every call that isn't a read, as `METHOD path`. */
let writes: string[];
/** While set, Kolab's answer to who the session is waits for it. */
let holdMe: Promise<void> | undefined;
/** The most switches Kolab had before it at once. */
let together: number;
let inFlight: number;

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
  static get last() { return FakeEventSource.all[FakeEventSource.all.length - 1]; }
}

const realWait = clock.wait;
const realConfirm = window.confirm;
beforeEach(() => {
  session = ann;
  switches = [];
  asked = [];
  confirms = true;
  methods = GITHUB;
  hold = undefined;
  writes = [];
  holdMe = undefined;
  together = inFlight = 0;
  FakeEventSource.all = [];
  switchReply = (kolab) => (kolab === 'billing' ? ok(inBilling) : NO_KOLAB);
  clock.wait = async () => undefined;
  window.confirm = (q?: string) => { asked.push(q ?? ''); return confirms; };
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${path}`);
    let r: Reply = ok({});
    if (path === '/api/session/methods') r = ok(methods);
    else if (path === '/api/session' && init?.method === 'DELETE') session = null;
    else if (path === '/api/session') r = ok(session = ann);
    else if (path === '/api/session/invite') r = ok(invite);
    else if (path.startsWith('/api/nodes/password-reset')) r = ok(session?.kolab === 'billing' ? billingDoc : doc);
    else if (path === '/api/session/present') r = ok({ present: !!session });
    else if (path === '/api/me') { await holdMe; r = session ? ok(session) : UNAUTHORIZED; }
    else if (path === '/api/overview') r = ok(overviewOf(session!));
    else if (path === '/api/session/switch') {
      const to = JSON.parse(String(init!.body)) as { kolab: string; role: string };
      switches.push(to);
      together = Math.max(together, ++inFlight);
      await hold;
      inFlight--;
      r = switchReply(to.kolab);
      if (r.status === 200) session = r.body as WebMe;
    }
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body ?? {}) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  clock.wait = realWait;
  window.confirm = realConfirm;
  delete (globalThis as { EventSource?: unknown }).EventSource;
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

/** Opens the page at an address, as a link followed or pasted does. */
async function open(hash: string) {
  history.replaceState(null, '', `/${hash}`);
  render(<App />);
  await screen.findByText(session ? 'Working as' : 'Sign in to Kolab');
}
const kolabShown = () => document.querySelector('.kolab-btn .nm')?.textContent;
/** Long enough for anything the page would still do by itself to have been done. */
const idle = () => act(async () => { await new Promise((r) => { setTimeout(r, 60); }); });
/** A switch Kolab holds until released. */
function held() {
  let release = () => undefined as void;
  hold = new Promise<void>((r) => { release = r; });
  return () => { hold = undefined; release(); };
}
/** The place the rail marks as shown. */
const current = () => document.querySelector('.rail [aria-current="page"]')?.textContent;

test('an address names its kolab, #/k/<kolab>/<place>; one without means the session\'s', () => {
  expect(parsePlace('#/k/billing/node/orders@2#R1')).toStrictEqual({ kolab: 'billing', place: 'node/orders@2#R1' });
  expect(parsePlace('#/k/billing')).toStrictEqual({ kolab: 'billing', place: '' });
  expect(parsePlace('#/k/billing/')).toStrictEqual({ kolab: 'billing', place: '' });
  expect(parsePlace('#/reviews')).toStrictEqual({ place: 'reviews' });
  expect(parsePlace('')).toStrictEqual({ place: '' });
  // Not a kolab's name: the address is read as a place, which the page has none for.
  expect(parsePlace('#/k/Not_A_Kolab/reviews')).toStrictEqual({ place: 'k/Not_A_Kolab/reviews' });
  expect(placeLink('billing', 'node/orders@2#R1')).toBe('#/k/billing/node/orders@2#R1');
  expect(placeLink('billing', '')).toBe('#/k/billing');
  expect(placeLink(undefined, 'reviews')).toBe('#/reviews');
  // The place reads the same with a kolab before it, another kolab read in place included.
  expect(parseRoute('#/k/billing/node/orders@2#R1')).toStrictEqual({ view: 'node', name: 'orders', version: 2, focus: 'orders#R1' });
  expect(parseRoute('#/k/billing/read/checkout/checkout@2#R5')).toStrictEqual(parseRoute('#/read/checkout/checkout@2#R5'));
  expect(parseRoute('#/k/billing/rulings/D104')).toStrictEqual({ view: 'rulings', ref: 'D104' });
  expect(parseRoute('#/k/billing')).toStrictEqual({ view: 'home' });
  expect(parseRoute('#/k/billing/nowhere')).toStrictEqual({ view: 'missing', what: 'nowhere' });
  expect(parseRoute('#/k/Not_A_Kolab/reviews')).toStrictEqual({ view: 'missing', what: 'k/Not_A_Kolab/reviews' });
});

test('an address without a kolab is rewritten with the session\'s, in place: no history entry, and no switch', async () => {
  const entries = history.length;
  await open('#/connect');
  await waitFor(() => expect(location.hash).toBe('#/k/anns/connect'));
  expect(history.length).toBe(entries);
  expect(current()).toBe('Connect a harness');
  expect(switches).toStrictEqual([]);
});

test('the bare page is the session\'s kolab\'s home, and the address says so; the page\'s links and its places name the kolab', async () => {
  await open('');
  await waitFor(() => expect(location.hash).toBe('#/k/anns'));
  expect(screen.getByRole('link', { name: 'Konjir, home' }).getAttribute('href')).toBe('#/k/anns');
  fireEvent.click(screen.getByRole('button', { name: 'Your sessions' }));
  await waitFor(() => expect(location.hash).toBe('#/k/anns/sessions'));
  expect(switches).toStrictEqual([]);
});

test('a link to a place in another kolab you can reach moves the session there, without asking, and shows the place', async () => {
  await open('#/k/billing/connect');
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);
  expect(asked).toStrictEqual([]);
  expect(location.hash).toBe('#/k/billing/connect');
  expect(current()).toBe('Connect a harness');
  expect(screen.getByRole('status').textContent).toBe('Working in billing as product');
});

test('a link to the session\'s own kolab switches nothing', async () => {
  await open('#/k/anns/connect');
  expect(current()).toBe('Connect a harness');
  expect(location.hash).toBe('#/k/anns/connect');
  expect(switches).toStrictEqual([]);
});

test.each([
  ['you can\'t reach', NO_KOLAB],
  ['that isn\'t there', { status: 400, body: { error: 'bad_request', message: 'name the kolab' } }],
])('a link to a kolab %s says so, the same way for both, and the page stays in its kolab', async (_, refusal) => {
  switchReply = () => refusal;
  await open('#/k/nowhere/connect');
  expect((await screen.findByRole('status')).textContent).toBe('There’s no kolab nowhere you can reach. You’re still in anns.');
  await waitFor(() => expect(location.hash).toBe('#/k/anns'));
  // Asked of Kolab once: a refusal isn't tried again.
  await idle();
  expect(switches).toStrictEqual([{ kolab: 'nowhere', role: 'product' }]);
  expect(location.hash).toBe('#/k/anns');
  expect(kolabShown()).toBe('Ann’s');
  expect(current()).toBeUndefined();
});

test('the picker\'s switch writes the kolab into the address, and going back to the other kolab\'s entry moves the session back, asking first', async () => {
  await open('#/k/anns/connect');
  fireEvent.click(screen.getByRole('button', { name: /Switch kolab/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Billing/ }));
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  await waitFor(() => expect(location.hash).toBe('#/k/billing'));
  expect(asked).toHaveLength(1);
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);

  switchReply = () => ok(ann);
  history.back();
  await waitFor(() => expect(kolabShown()).toBe('Ann’s'));
  expect(location.hash).toBe('#/k/anns/connect');
  expect(asked).toStrictEqual([expect.stringMatching(/^Work in billing\?/), expect.stringMatching(/^Work in anns\?/)]);
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }, { kolab: 'anns', role: 'product' }]);
  expect(current()).toBe('Connect a harness');
});

test('moving to another kolab\'s address from a page already open asks first, and declining stays where it was', async () => {
  await open('#/k/anns/connect');
  confirms = false;
  location.hash = '#/k/billing/sessions';
  await waitFor(() => expect(asked).toHaveLength(1));
  await waitFor(() => expect(location.hash).toBe('#/k/anns/connect'));
  expect(switches).toStrictEqual([]);
  expect(kolabShown()).toBe('Ann’s');
  expect(current()).toBe('Connect a harness');
});

test('signed out, a link keeps its address through signing in with the identity provider, and opens once signed in', async () => {
  session = null;
  await open('#/k/billing/connect');
  expect(location.hash).toBe('#/k/billing/connect');
  // The browser leaves for GitHub: jsdom goes nowhere.
  const leaving = (e: Event) => e.preventDefault();
  document.addEventListener('click', leaving);
  fireEvent.click(screen.getByRole('link', { name: 'Sign in with GitHub' }));
  document.removeEventListener('click', leaving);
  cleanup();

  // It comes back at `/`, signed in to the kolab chosen there.
  session = ann;
  await open('');
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  expect(location.hash).toBe('#/k/billing/connect');
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);
  expect(current()).toBe('Connect a harness');
});

test('declining a move to another kolab leaves the page as it was, its draft included: it asks before anything is put away', async () => {
  await open('#/k/anns/node/password-reset');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit PR8' }));
  fireEvent.change(screen.getByLabelText('Edit PR8'), { target: { value: 'At most 2 reset requests per hour.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep in draft' }));
  expect(screen.getByText(/1 change to kj:password-reset/)).toBeTruthy();
  // What the page shows as it asks: still the document, with its draft.
  let shown: boolean | undefined;
  window.confirm = (q?: string) => { asked.push(q ?? ''); shown = !!screen.queryByText(/1 change to kj:password-reset/); return false; };
  location.hash = '#/k/billing/sessions';
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(shown).toBe(true);
  await waitFor(() => expect(location.hash).toBe('#/k/anns/node/password-reset'));
  expect(screen.getByText(/1 change to kj:password-reset/)).toBeTruthy();
  expect(screen.getByText('At most 2 reset requests per hour.')).toBeTruthy();
  expect(screen.queryByText(/^Opening/)).toBeNull();
  expect(switches).toStrictEqual([]);
});

test('a move to another kolab that is declined, refused, or met with a 401 writes the address back in place, and asks Kolab nothing more', async () => {
  await open('#/k/anns/connect');
  fireEvent.click(screen.getByRole('button', { name: /Switch kolab/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Billing/ }));
  await waitFor(() => expect(location.hash).toBe('#/k/billing'));
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  fireEvent.click(screen.getByRole('button', { name: 'Your sessions' }));
  await waitFor(() => expect(current()).toBe('Your sessions'));
  const entries = history.length;

  // Back twice, to Ann's entry: declined. That entry now holds this place; nothing is traversed.
  confirms = false;
  history.go(-2);
  await waitFor(() => expect(asked).toHaveLength(2));
  await waitFor(() => expect(location.hash).toBe('#/k/billing/sessions'));
  await idle();
  expect(asked).toHaveLength(2);
  expect(current()).toBe('Your sessions');
  expect(switches).toHaveLength(1);

  // A link to a kolab Kolab won't open: asked of Kolab once.
  confirms = true;
  switchReply = () => NO_KOLAB;
  location.hash = '#/k/nowhere/connect';
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('There’s no kolab nowhere you can reach. You’re still in billing.'));
  await waitFor(() => expect(location.hash).toBe('#/k/billing/sessions'));
  await idle();
  expect(switches.map((x) => x.kolab)).toStrictEqual(['billing', 'nowhere']);
  expect(current()).toBe('Your sessions');
  expect(kolabShown()).toBe('Billing');

  // A 401 from a session that lives: said, and not tried again by the page.
  switchReply = () => UNAUTHORIZED;
  location.hash = '#/k/third/connect';
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('That didn’t go through while Kolab reconnected: try it again.'));
  await waitFor(() => expect(location.hash).toBe('#/k/billing/sessions'));
  await idle();
  expect(switches.map((x) => x.kolab)).toStrictEqual(['billing', 'nowhere', 'third']);
  expect(asked).toHaveLength(4);
  expect(history.length).toBeGreaterThanOrEqual(entries);
});

test('going back to an entry made on the way through another kolab, and declining, asks once and no more', async () => {
  switchReply = (kolab) => ok({ ...ann, kolab });
  await open('#/k/anns/connect');
  const release = held();
  location.hash = '#/k/billing/sessions';
  await waitFor(() => expect(switches).toHaveLength(1));
  location.hash = '#/k/third/connect';
  await waitFor(() => expect(asked).toHaveLength(2));
  release();
  await waitFor(() => expect(kolabShown()).toBe('Third'));
  await waitFor(() => expect(location.hash).toBe('#/k/third/connect'));

  confirms = false;
  history.back();
  await waitFor(() => expect(asked).toHaveLength(3));
  await waitFor(() => expect(location.hash).toBe('#/k/third/connect'));
  await idle();
  expect(asked).toHaveLength(3);
  expect(switches.map((x) => x.kolab)).toStrictEqual(['billing', 'third']);
  expect(kolabShown()).toBe('Third');
  expect(current()).toBe('Connect a harness');
});

test('a switch under way finishes: going back to your own kolab meanwhile still ends in the other, and the address says so', async () => {
  await open('#/k/anns/connect');
  fireEvent.click(screen.getByRole('button', { name: 'Your sessions' }));
  await waitFor(() => expect(location.hash).toBe('#/k/anns/sessions'));
  const release = held();
  location.hash = '#/k/billing/connect';
  await waitFor(() => expect(switches).toHaveLength(1));
  history.back();
  await waitFor(() => expect(location.hash).toBe('#/k/anns/sessions'));
  release();
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  await waitFor(() => expect(location.hash).toBe('#/k/billing/sessions'));
  await idle();
  expect(current()).toBe('Your sessions');
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);
  expect(asked).toHaveLength(1);
});

test('a page that follows its session to another kolab starts afresh there: the draft is gone, and nothing of it can be submitted', async () => {
  await open('#/k/anns/node/password-reset');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit PR8' }));
  fireEvent.change(screen.getByLabelText('Edit PR8'), { target: { value: 'At most 2 reset requests per hour.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep in draft' }));
  expect(screen.getByText(/1 change to kj:password-reset/)).toBeTruthy();
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  session = inBilling;
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  // Billing's document of that name, as it is committed there.
  expect(await screen.findByText('Billing resets nothing.')).toBeTruthy();
  expect(location.hash).toBe('#/k/billing/node/password-reset');
  expect(screen.queryByText(/1 change to kj:password-reset/)).toBeNull();
  expect(screen.queryByText('At most 2 reset requests per hour.')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Submit/ })).toBeNull();
  expect(writes).toStrictEqual([]);
});

test('the page\'s own sign-out ends on Signed out, whatever the stream says of the session after', async () => {
  await open('#/k/anns/connect');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  const stream = FakeEventSource.last;
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  act(() => stream.send({ type: 'ended' }));
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  await idle();
  expect(screen.getByRole('alert').textContent).toBe('Signed out. Your session has ended.');
});

test('a switch this page asked for is never told as another tab\'s, though the stream says the session ended before Kolab answers', async () => {
  await open('#/k/anns/connect');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  const release = held();
  fireEvent.click(screen.getByRole('button', { name: /Switch kolab/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Billing/ }));
  await waitFor(() => expect(switches).toHaveLength(1));
  // Kolab has made the switch, and its answer is still on its way.
  session = inBilling;
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  await idle();
  expect(screen.queryByText(/another tab/)).toBeNull();
  release();
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Working in billing as product'));
  expect(location.hash).toBe('#/k/billing');
  expect(switches).toHaveLength(1);
});

test('two addresses in other kolabs, one set before the first switch returns: each is asked once, switched to once, and the later is where the page ends', async () => {
  switchReply = (kolab) => ok({ ...ann, kolab });
  await open('#/k/anns/connect');
  let release = () => undefined as void;
  hold = new Promise<void>((r) => { release = r; });
  location.hash = '#/k/billing/sessions';
  await waitFor(() => expect(switches).toHaveLength(1));
  location.hash = '#/k/third/connect';
  await waitFor(() => expect(asked).toHaveLength(2));
  // The second waits for the first: Kolab has one before it.
  await idle();
  expect(switches).toHaveLength(1);
  hold = undefined;
  release();
  await waitFor(() => expect(kolabShown()).toBe('Third'));
  expect(together).toBe(1);
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }, { kolab: 'third', role: 'product' }]);
  expect(asked).toStrictEqual([expect.stringMatching(/^Work in billing\?/), expect.stringMatching(/^Work in third\?/)]);
  expect(location.hash).toBe('#/k/third/connect');
  expect(current()).toBe('Connect a harness');
});

test('another tab moves the browser\'s session to another kolab: this page follows it, and says so, rather than signing out', async () => {
  await open('#/k/anns/connect');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  // The other tab's switch ended this page's session, and the cookie holds the one it opened.
  session = inBilling;
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  expect((await screen.findByRole('status')).textContent).toBe('Your session moved to billing in another tab. This page follows it: what was drafted here is discarded.');
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  expect(location.hash).toBe('#/k/billing/connect');
  expect(current()).toBe('Connect a harness');
  expect(screen.queryByRole('heading', { name: 'Sign in to Kolab' })).toBeNull();
  expect(switches).toStrictEqual([]);
  // The page listens again, as the session it now has.
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
});

test('a session that ends with no other in the browser signs the page out, and signing in again by token opens the address without asking', async () => {
  methods = { provider: null, token: true };
  await open('#/k/anns/connect');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  session = null;
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  // A link to another kolab is pasted over the address before signing in.
  location.hash = '#/k/billing/sessions';
  await waitFor(() => expect(location.hash).toBe('#/k/billing/sessions'));
  fireEvent.change(screen.getByLabelText('Session token'), { target: { value: 'kjs_anns' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a token' }));
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  expect(asked).toStrictEqual([]);
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);
  expect(location.hash).toBe('#/k/billing/sessions');
  expect(current()).toBe('Your sessions');
});

test('a 401 in the middle of a switch is checked: a session that lives says to try again, and the page stays in its kolab', async () => {
  await open('#/k/anns/connect');
  // Kolab is slow to say the session lives: the switch isn't sent again while the page waits to hear.
  let known = () => undefined as void;
  switchReply = () => { holdMe = new Promise<void>((r) => { known = r; }); return UNAUTHORIZED; };
  location.hash = '#/k/billing/connect';
  await waitFor(() => expect(switches).toHaveLength(1));
  await idle();
  expect(switches).toHaveLength(1);
  holdMe = undefined;
  known();
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('That didn’t go through while Kolab reconnected: try it again.'));
  await waitFor(() => expect(location.hash).toBe('#/k/anns/connect'));
  cleanup();
  switches = [];
  switchReply = () => UNAUTHORIZED;
  await open('#/k/billing/connect');
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('That didn’t go through while Kolab reconnected: try it again.'));
  await waitFor(() => expect(location.hash).toBe('#/k/anns'));
  expect(kolabShown()).toBe('Ann’s');
  // It is the person who tries again, never the page.
  await idle();
  expect(switches).toHaveLength(1);
});

test('a 401 in the middle of a switch from a session that ended signs the page out, with the address kept for the sign-in', async () => {
  switchReply = () => { session = null; return UNAUTHORIZED; };
  await open('#/k/billing/connect');
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  expect(location.hash).toBe('#/k/billing/connect');
});

test('an invite\'s link opened signed in shows the invite, is taken out of the address, and switches nothing, written after a kolab or not', async () => {
  expect(inviteOf(`#/k/billing/invite/${TOKEN}`)).toBe(TOKEN);
  expect(inviteOf(`#/k/billing/invite/${TOKEN}/x`)).toBeUndefined();
  await open(`#/invite/${TOKEN}`);
  expect(await screen.findByRole('button', { name: 'Join billing' })).toBeTruthy();
  await waitFor(() => expect(location.hash).toBe('#/k/anns'));
  cleanup();
  await open(`#/k/billing/invite/${TOKEN}`);
  expect(await screen.findByRole('button', { name: 'Join billing' })).toBeTruthy();
  await waitFor(() => expect(location.hash).toBe('#/k/anns'));
  expect(kolabShown()).toBe('Ann’s');
  expect(switches).toStrictEqual([]);
});

test('the address kept for a sign-in is dropped when there is none to keep, and once a signed-in page shows its place', async () => {
  session = null;
  await open('#/k/billing/connect');
  const leaving = (e: Event) => e.preventDefault();
  document.addEventListener('click', leaving);
  fireEvent.click(screen.getByRole('link', { name: 'Sign in with GitHub' }));
  expect(sessionStorage.getItem('konjir.place')).toBe('#/k/billing/connect');
  history.replaceState(null, '', '/');
  fireEvent.click(screen.getByRole('link', { name: 'Sign in with GitHub' }));
  document.removeEventListener('click', leaving);
  expect(sessionStorage.getItem('konjir.place')).toBeNull();
  cleanup();

  // One found as a page loads is dropped whether it was put back or not, so a later load at `/` opens nothing old.
  sessionStorage.setItem('konjir.place', '#/k/billing/connect');
  await open('#/k/anns/sessions');
  expect(sessionStorage.getItem('konjir.place')).toBeNull();
  expect(location.hash).toBe('#/k/anns/sessions');
  cleanup();

  // One left behind while a signed-in page is open opens nothing later.
  session = ann;
  await open('#/k/anns/connect');
  sessionStorage.setItem('konjir.place', '#/k/billing/connect');
  fireEvent.click(screen.getByRole('button', { name: 'Your sessions' }));
  await waitFor(() => expect(location.hash).toBe('#/k/anns/sessions'));
  await waitFor(() => expect(sessionStorage.getItem('konjir.place')).toBeNull());
  expect(switches).toStrictEqual([]);
});

test('a stream that comes back after a break asks who the session is: one moved in another tab meanwhile is followed, and the page starts afresh', async () => {
  await open('#/k/anns/node/password-reset');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit PR8' }));
  fireEvent.change(screen.getByLabelText('Edit PR8'), { target: { value: 'At most 2 reset requests per hour.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep in draft' }));
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  act(() => FakeEventSource.last.send({ type: 'ready' }));
  // The stream closed with no `ended`, as when its token expires; the browser reconnects, as the session another tab moved.
  session = inBilling;
  act(() => FakeEventSource.last.send({ type: 'ready' }));
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  expect(screen.getByRole('status').textContent).toMatch(/^Your session moved to billing in another tab\./);
  expect(await screen.findByText('Billing resets nothing.')).toBeTruthy();
  expect(location.hash).toBe('#/k/billing/node/password-reset');
  expect(screen.queryByText(/1 change to kj:password-reset/)).toBeNull();
  expect(writes).toStrictEqual([]);
});

test('while an address\'s switch is under way the role and the picker wait: Kolab has one move before it', async () => {
  const release = held();
  history.replaceState(null, '', '/#/k/billing/connect');
  render(<App />);
  await waitFor(() => expect(switches).toHaveLength(1));
  const engineer = await screen.findByRole('radio', { name: 'engineer' });
  await waitFor(() => expect((engineer as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(engineer);
  fireEvent.click(screen.getByRole('button', { name: /Switch kolab/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Third/ }));
  await idle();
  expect(switches).toHaveLength(1);
  release();
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  await idle();
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);
  expect(together).toBe(1);
  expect(asked).toStrictEqual([]);
  expect((screen.getByRole('radio', { name: 'engineer' }) as HTMLButtonElement).disabled).toBe(false);
});

test('an address set to a third kolab while the picker\'s switch is under way waits for it, is asked about once, and is where the page ends', async () => {
  switchReply = (kolab) => ok({ ...ann, kolab });
  await open('#/k/anns/connect');
  const release = held();
  fireEvent.click(screen.getByRole('button', { name: /Switch kolab/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Billing/ }));
  await waitFor(() => expect(switches).toHaveLength(1));
  location.hash = '#/k/third/sessions';
  await waitFor(() => expect(asked).toHaveLength(2));
  await idle();
  expect(switches).toHaveLength(1);
  release();
  await waitFor(() => expect(kolabShown()).toBe('Third'));
  await idle();
  expect(switches.map((x) => x.kolab)).toStrictEqual(['billing', 'third']);
  expect(together).toBe(1);
  // The picker's and the address's: nobody is asked about a move nobody made.
  expect(asked).toStrictEqual([expect.stringMatching(/^Work in billing\?/), expect.stringMatching(/^Work in third\?/)]);
  expect(location.hash).toBe('#/k/third/sessions');
  expect(current()).toBe('Your sessions');
});

test('a switch that answers after Sign out signs nobody in, and the session it opened is ended; a later sign-in is a session like any other', async () => {
  methods = { provider: null, token: true };
  await open('#/k/anns/connect');
  const release = held();
  location.hash = '#/k/billing/connect';
  await waitFor(() => expect(switches).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  release();
  await idle();
  expect(screen.getByRole('heading', { name: 'Sign in to Kolab' })).toBeTruthy();
  expect(screen.queryByText('Working as')).toBeNull();
  // Its own session, and the one the late switch opened.
  expect(writes.filter((w) => w === 'DELETE /api/session')).toHaveLength(2);
  expect(session).toBeNull();

  // Signed in again, the page hears of its session's end as any page does.
  fireEvent.change(screen.getByLabelText('Session token'), { target: { value: 'kjs_anns' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a token' }));
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  await waitFor(() => expect(FakeEventSource.all.length).toBeGreaterThanOrEqual(2));
  session = null;
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.');
});

test('a role changed in another tab is followed and said, as a kolab is', async () => {
  await open('#/k/anns/connect');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  session = { ...ann, role: 'engineer', layer: 'technical' };
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Your session now works as engineer in another tab. This page follows it: what was drafted here is discarded.'));
  expect(screen.getByRole('radio', { name: 'engineer' }).getAttribute('aria-checked')).toBe('true');
  expect(location.hash).toBe('#/k/anns/connect');
});

test('a 401 on an address\'s switch when another tab had already moved the session there is an arrival: the place asked for, and no error', async () => {
  await open('#/k/anns/connect');
  switchReply = () => { session = inBilling; return UNAUTHORIZED; };
  location.hash = '#/k/billing/sessions';
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  await idle();
  expect(location.hash).toBe('#/k/billing/sessions');
  expect(current()).toBe('Your sessions');
  expect(screen.queryByText(/try it again/)).toBeNull();
  expect(switches).toHaveLength(1);
});

test.each(['#/k/billing/invite/kji_short', '#/k/billing/invite/', '#/k/billing/invite'])('an invite\'s address with no well-formed secret, %s, moves no session', async (hash) => {
  await open(hash);
  await idle();
  expect(switches).toStrictEqual([]);
  expect(asked).toStrictEqual([]);
  expect(kolabShown()).toBe('Ann’s');
  expect(parsePlace(location.hash).kolab).toBe('anns');
});

test('a page that has shown no place yet asks nothing: another kolab\'s address set while its first switch is under way is taken up next', async () => {
  switchReply = (kolab) => ok({ ...ann, kolab });
  const release = held();
  history.replaceState(null, '', '/#/k/billing/connect');
  render(<App />);
  await waitFor(() => expect(switches).toHaveLength(1));
  location.hash = '#/k/third/sessions';
  await idle();
  release();
  await waitFor(() => expect(kolabShown()).toBe('Third'));
  expect(asked).toStrictEqual([]);
  expect(switches.map((x) => x.kolab)).toStrictEqual(['billing', 'third']);
  expect(location.hash).toBe('#/k/third/sessions');
});

test('signing in again holds nothing of the session before: a refused address gives way to home, not to where that session was', async () => {
  methods = { provider: null, token: true };
  await open('#/k/anns/sessions');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  session = null;
  act(() => FakeEventSource.last.send({ type: 'ended' }));
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  location.hash = '#/k/nowhere/connect';
  await waitFor(() => expect(location.hash).toBe('#/k/nowhere/connect'));
  fireEvent.change(screen.getByLabelText('Session token'), { target: { value: 'kjs_anns' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a token' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('There’s no kolab nowhere you can reach. You’re still in anns.'));
  await waitFor(() => expect(location.hash).toBe('#/k/anns'));
  expect(asked).toStrictEqual([]);
});

test('signing out and in again opens the address in the bar, whichever kolab the new session starts in', async () => {
  methods = { provider: null, token: true };
  session = inBilling;
  await open('#/k/billing/connect');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('heading', { name: 'Sign in to Kolab' });
  // The token's session is in anns; the address names billing.
  fireEvent.change(screen.getByLabelText('Session token'), { target: { value: 'kjs_anns' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with a token' }));
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);
  expect(asked).toStrictEqual([]);
  expect(location.hash).toBe('#/k/billing/connect');
});

test('an address set a moment before the page hears of its session is read as it was set, not rewritten to the session\'s kolab', async () => {
  await open('#/k/anns/connect');
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  // The session is renewed under the page as the address changes: the page re-reads who it is before the address's turn comes.
  session = { ...ann, name: 'Ann B' };
  await act(async () => { location.hash = '#/k/billing/sessions'; FakeEventSource.last.send({ type: 'ended' }); });
  await waitFor(() => expect(kolabShown()).toBe('Billing'));
  expect(switches).toStrictEqual([{ kolab: 'billing', role: 'product' }]);
  expect(location.hash).toBe('#/k/billing/sessions');
});

test('a refused switch undoes only itself: another kolab asked for meanwhile is taken up, and an address set as the refusal lands is the one shown', async () => {
  switchReply = (kolab) => (kolab === 'nowhere' ? NO_KOLAB : ok({ ...ann, kolab }));
  await open('#/k/anns/connect');
  let release = held();
  location.hash = '#/k/nowhere/connect';
  await waitFor(() => expect(switches).toHaveLength(1));
  location.hash = '#/k/third/sessions';
  await waitFor(() => expect(asked).toHaveLength(2));
  release();
  await waitFor(() => expect(kolabShown()).toBe('Third'));
  expect(switches.map((x) => x.kolab)).toStrictEqual(['nowhere', 'third']);
  expect(location.hash).toBe('#/k/third/sessions');

  // Refused again, and as Kolab says so the person goes elsewhere in the kolab they are in.
  release = held();
  location.hash = '#/k/nowhere/connect';
  await waitFor(() => expect(switches).toHaveLength(3));
  release();
  location.hash = '#/k/third/connect';
  await waitFor(() => expect(current()).toBe('Connect a harness'));
  await idle();
  expect(location.hash).toBe('#/k/third/connect');
  expect(kolabShown()).toBe('Third');
  expect(switches).toHaveLength(3);
});
