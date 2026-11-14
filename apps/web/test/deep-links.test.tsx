// Every place's address names its kolab, #/k/<kolab>/<place>: one copied from the address bar opens
// the same place for whoever can reach that kolab. An address without a kolab means the session's,
// and is rewritten in place; one that names another kolab moves the session there, as the picker
// does, and a kolab Kolab won't open is said so, with the page left where it was.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WebMe, WebOverview, WebSignInMethods } from '@konjir/types';
import { App, parseRoute } from '../src/App.js';
import { clock } from '../src/api.js';
import { parsePlace, placeLink } from '../src/util.js';

const ann: WebMe = { actor: 'ann', name: 'Ann', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'anns', access: { level: 'admin', layers: ['functional', 'technical'] } };
const inBilling: WebMe = { ...ann, kolab: 'billing' };
const card = (id: string, title: string, current: boolean): WebOverview['kolab'] => ({ id, title, owner: 'ann', visibility: 'private', current, access: ann.access });
const overviewOf = (me: WebMe): WebOverview => ({
  me, kolab: card(me.kolab, me.kolab === 'anns' ? 'Ann’s' : 'Billing', true),
  kolabs: [card('anns', 'Ann’s', me.kolab === 'anns'), card('billing', 'Billing', me.kolab === 'billing')],
  nodes: [], nodes_next: null, counts: { stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0 },
});
const GITHUB: WebSignInMethods = { provider: 'GitHub', token: false };

type Reply = { status: number; body?: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const NO_KOLAB: Reply = { status: 403, body: { error: 'forbidden', message: 'no kolab nowhere you can reach' } };

/** Whose session the browser's cookie holds, which a switch Kolab allows changes; null is signed out. */
let session: WebMe | null;
let switchReply: (kolab: string) => Reply;
let switches: { kolab: string; role: string }[];
let asked: string[];
let confirms: boolean;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() { this.readyState = FakeEventSource.CLOSED; }
}

const realWait = clock.wait;
const realConfirm = window.confirm;
beforeEach(() => {
  session = ann;
  switches = [];
  asked = [];
  confirms = true;
  switchReply = (kolab) => (kolab === 'billing' ? ok(inBilling) : NO_KOLAB);
  clock.wait = async () => undefined;
  window.confirm = (q?: string) => { asked.push(q ?? ''); return confirms; };
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    let r: Reply = ok({});
    if (path === '/api/session/methods') r = ok(GITHUB);
    else if (path === '/api/session/present') r = ok({ present: !!session });
    else if (path === '/api/me') r = session ? ok(session) : { status: 401, body: { error: 'unauthorized', message: 'sign in' } };
    else if (path === '/api/overview') r = ok(overviewOf(session!));
    else if (path === '/api/session/switch') {
      const to = JSON.parse(String(init!.body)) as { kolab: string; role: string };
      switches.push(to);
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

test('a link to a kolab you can\'t reach, or that isn\'t there, says so one way, and the page stays in its kolab', async () => {
  await open('#/k/nowhere/connect');
  expect((await screen.findByRole('status')).textContent).toBe('There’s no kolab nowhere you can reach. You’re still in anns.');
  expect(switches).toStrictEqual([{ kolab: 'nowhere', role: 'product' }]);
  await waitFor(() => expect(location.hash).toBe('#/k/anns'));
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
