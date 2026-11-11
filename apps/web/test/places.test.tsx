// The places from the web page's audit of 2026-11-08: the inbox as home, the work board, the
// rulings as precedent to search, and links from element text to the rulings it cites.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WebMe, WebOverview, WebRuling, WebWorkView } from '@konjir/types';
import { InboxView, RulingsView, WorkView, withRulingLinks } from '../src/components/Places.js';
import { KolabsView, LineageView, ReviewsView, kolabStatus, waitingStatus } from '../src/components/Pages.js';
import { parseRoute } from '../src/App.js';

const lee: WebMe = { actor: 'lee', name: 'Lee', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'accounts', access: { level: 'admin', layers: ['functional', 'technical'] } };
const at = new Date().toISOString();
const overview = (counts: Partial<WebOverview['counts']> = {}): WebOverview => ({
  me: lee, kolab: { id: 'accounts', title: 'Accounts', owner: 'lee', visibility: 'private', current: true, access: lee.access },
  kolabs: [], nodes: [], nodes_next: null, counts: { stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0, ...counts },
});

let replies: Record<string, unknown>;
let calls: string[];
beforeEach(() => {
  replies = {};
  calls = [];
  globalThis.fetch = jest.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const key = Object.keys(replies).filter((k) => u.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return { ok: true, status: 200, text: async () => JSON.stringify(key ? replies[key] : {}) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);

test('home is the inbox: what waits on the person\'s layer, each kind with its count, each item opening where it is acted on', async () => {
  replies['/api/reviews'] = { for_me: [{ kind: 'version', subject: 'kj:password-reset@4', node: 'password-reset', seq: 4, author: 'pm-agent', at }], mine: [], next: null };
  replies['/api/queries?state=open'] = { queries: [
    { id: 'q1', kind: 'question', state: 'open', address: 'kj:password-reset@3#PR3', node: 'password-reset', seq: 3, element: 'PR3', quote: null, layer: 'functional', question: 'Timing too?', raised_by: 'eng-agent', at, answer: null, answered_by: null, from: null, mark: null, mark_reason: null },
    { id: 'q2', kind: 'question', state: 'open', address: 'kj:password-reset-pg@2#B9', node: 'password-reset-pg', seq: 2, element: 'B9', quote: null, layer: 'technical', question: 'Which queue?', raised_by: 'pm-agent', at, answer: null, answered_by: null, from: null, mark: null, mark_reason: null },
  ], next: null };
  // A mark on the technical layer isn't Lee's to settle as product: only hers are listed.
  replies['/api/marks'] = { marks: [
    { id: 'm1', reason: 'changed', node: 'password-reset', seq: 3, element: 'PR2', layer: 'functional', because: 'kj:other#R1 changed', next: '', at, target: null, override: null, question: null },
    { id: 'm2', reason: 'changed', node: 'password-reset-pg', seq: 2, element: 'B9', layer: 'technical', because: 'kj:password-reset#PR8 changed', next: '', at, target: null, override: null, question: null },
  ], next: null };
  replies['/api/cases?state=open'] = { cases: [], belongs: true, next: null };
  render(<InboxView me={lee} overview={overview({ reviews: 1, waiting: 1, stale: 1 })} tick={0} go={() => undefined} />);
  expect(await screen.findByRole('heading', { level: 1, name: '3 things wait on you' })).toBeTruthy();
  const reviews = screen.getByRole('region', { name: /Reviews for you/ });
  expect((await within(reviews).findByRole('link', { name: 'kj:password-reset@4' })).getAttribute('href')).toBe('#/node/password-reset@4');
  // Only the questions the person's own layer answers.
  const questions = screen.getByRole('region', { name: /Questions product answers/ });
  expect(await within(questions).findByText('Timing too?')).toBeTruthy();
  expect(within(questions).queryByText('Which queue?')).toBeNull();
  expect(within(questions).getByRole('link', { name: 'kj:password-reset@3#PR3' }).getAttribute('href')).toBe('#/node/password-reset@3#PR3');
  const marks = screen.getByRole('region', { name: /Marks on your layer/ });
  expect(await within(marks).findByText('kj:other#R1 changed')).toBeTruthy();
  expect(within(marks).queryByText('kj:password-reset#PR8 changed')).toBeNull();
});

test('an inbox section reads on, page after page, until it holds what its count counts', async () => {
  const q = (id: string, layer: 'functional' | 'technical') => ({ id, kind: 'question', state: 'open', address: `kj:n@1#${id}`, node: 'n', seq: 1, element: id, quote: null, layer,
    question: `About ${id}?`, raised_by: 'x', at, answer: null, answered_by: null, from: null, mark: null, mark_reason: null });
  replies['/api/reviews'] = { for_me: [], mine: [], next: null };
  replies['/api/marks'] = { marks: [], next: null };
  replies['/api/cases?state=open'] = { cases: [], belongs: true, next: null };
  // The first page holds only the other layer's questions; Lee's is on the second.
  replies['/api/queries?state=open'] = { queries: [q('T1', 'technical'), q('T2', 'technical')], next: 'p2' };
  replies['/api/queries?state=open&cursor=p2'] = { queries: [q('F1', 'functional')], next: null };
  render(<InboxView me={lee} overview={overview({ waiting: 1 })} tick={0} go={() => undefined} />);
  expect(await screen.findByText('About F1?')).toBeTruthy();
  expect(screen.queryByText('About T1?')).toBeNull();
  expect(calls).toContain('/api/queries?state=open&cursor=p2');
});

const work = (id: string, over: Partial<WebWorkView['work'][number]> = {}): WebWorkView['work'][number] => ({
  work: `kj:orders-pg#${id}`, binding: 'orders-pg', id, text: `Build ${id}.\n\nMore.`, state: 'todo', assignee: null, lease_until: null,
  milestone: false, size: 'S', blocked: [], ready: false, yours: false, ...over,
});

test('the work board shows each binding\'s packages by state, which are blocked and why, and filters to ready, blocked, at risk or mine', async () => {
  replies['/api/work'] = { work: [
    work('W1', { state: 'in_progress', assignee: 'lee-engineer', yours: true }),
    // A person whose name only looks like an agent of Lee's: not Lee's (Kolab says so).
    work('W5', { state: 'in_progress', assignee: 'lee-x' }),
    work('W2', { blocked: [{ reason: 'depends_on', work: 'kj:orders-pg#W1', state: 'in_progress' }] }),
    work('W3', { ready: true }),
    work('W4', { state: 'done', assignee: 'eng-agent', at_risk: true }),
  ], next: null };
  render(<WorkView me={lee} tick={0} go={() => undefined} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
  expect(calls[0]).toBe('/api/work?limit=200');
  expect([...document.querySelectorAll('.summary .fact')].map((f) => f.textContent)).toStrictEqual(['1 of 5 work packages done', '1 ready', '1 blocked', '1 at risk']);
  const todo = screen.getByRole('region', { name: 'To do, 2' });
  expect(within(todo).getByText('Blocked: W1 isn’t done')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Done, 1' })).getByText('at risk')).toBeTruthy();
  // Only the first line of a package's text is its card.
  expect(screen.getByText('Build W3.')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Ready' }));
  expect(screen.queryByText('Build W2.')).toBeNull();
  expect(screen.getByText('Build W3.')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Held by me or my agents' }));
  expect(screen.getByText('Build W1.')).toBeTruthy();
  expect(screen.queryByText('Build W4.')).toBeNull();
  expect(screen.queryByText('Build W5.')).toBeNull();
});

const ruling = (ref: string, text: string): WebRuling => ({
  ruling: `r-${ref}`, ref, on: 'kj:kolab@3', case: null, text, effect: 'change_intent', replaces: null, ruled_by: 'Lee', ruled_at: at, recorded_at: at,
  node: 'kolab', seq: 3, element: null,
} as WebRuling);

test('the rulings can be searched by their name and their words; an address naming one shows it alone', async () => {
  replies['/api/rulings'] = { rulings: [ruling('D104', 'There is no plan: work lives in the binding.'), ruling('D12', 'Konjir is one hosted service.')], next: null };
  const page = render(<RulingsView me={lee} tick={0} go={() => undefined} />);
  expect(calls[0]).toBe('/api/rulings?limit=200');
  expect(await screen.findByText('There is no plan: work lives in the binding.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search the rulings'), { target: { value: 'hosted' } });
  expect(screen.queryByText('There is no plan: work lives in the binding.')).toBeNull();
  expect(screen.getByText('Konjir is one hosted service.')).toBeTruthy();
  // A ruling named in the address is read by its name, however far back it is.
  replies['/api/rulings?ref=D104'] = { rulings: [ruling('D104', 'There is no plan: work lives in the binding.')], next: null };
  page.rerender(<RulingsView me={lee} tick={0} go={() => undefined} focus="D104" />);
  expect(await screen.findByText('There is no plan: work lives in the binding.')).toBeTruthy();
  expect(calls).toContain('/api/rulings?ref=D104');
  expect(screen.queryByText('Konjir is one hosted service.')).toBeNull();
  expect((screen.getByLabelText('Search the rulings') as HTMLInputElement).value).toBe('D104');
  // Leaving the ruling's address for Rulings clears the search.
  page.rerender(<RulingsView me={lee} tick={0} go={() => undefined} />);
  expect(await screen.findByText('Konjir is one hosted service.')).toBeTruthy();
  expect((screen.getByLabelText('Search the rulings') as HTMLInputElement).value).toBe('');
  page.rerender(<RulingsView me={lee} tick={0} go={() => undefined} focus="D104" />);
  await screen.findByText('There is no plan: work lives in the binding.');
  // D1 isn't D104: a name is matched whole.
  fireEvent.change(screen.getByLabelText('Search the rulings'), { target: { value: 'D1' } });
  expect(screen.getByText(/No ruling is called “D1”/)).toBeTruthy();
});

test('a reader who holds only Read is told the rulings belong to the kolab\'s work, not that there are none (D49)', () => {
  render(<RulingsView me={{ ...lee, access: { level: 'read', layers: [] } }} tick={0} go={() => undefined} />);
  expect(screen.getByText(/Rulings belong to this kolab’s work/)).toBeTruthy();
});

test('an element\'s text links each ruling it cites', () => {
  render(<p>{withRulingLinks('Konjir is one service. Source: D12, D47')}</p>);
  expect(screen.getByRole('link', { name: 'D12' }).getAttribute('href')).toBe('#/rulings/D12');
  expect(screen.getByRole('link', { name: 'D47' }).getAttribute('href')).toBe('#/rulings/D47');
  expect(withRulingLinks('No citation here.')).toBe('No citation here.');
});

test('a ruling\'s address in lower case finds it; typing other words there searches every ruling, keeping what was typed', async () => {
  replies['/api/rulings'] = { rulings: [ruling('D104', 'There is no plan: work lives in the binding.'), ruling('D12', 'Konjir is one hosted service.')], next: null };
  replies['/api/rulings?ref=D104'] = { rulings: [ruling('D104', 'There is no plan: work lives in the binding.')], next: null };
  const went: string[] = [];
  const page = render(<RulingsView me={lee} tick={0} go={(r) => went.push(r)} focus="d104" />);
  expect(await screen.findByText('There is no plan: work lives in the binding.')).toBeTruthy();
  expect(calls[0]).toBe('/api/rulings?ref=D104');
  fireEvent.change(screen.getByLabelText('Search the rulings'), { target: { value: 'hosted' } });
  expect(went).toStrictEqual(['rulings']);
  page.rerender(<RulingsView me={lee} tick={0} go={(r) => went.push(r)} />);
  expect(await screen.findByText('Konjir is one hosted service.')).toBeTruthy();
  expect((screen.getByLabelText('Search the rulings') as HTMLInputElement).value).toBe('hosted');
});

const lineagePage = (nodes: unknown[], links: unknown[], next: string | null = null) => ({ nodes, links, next });
const link = (source: [string, string], target: [string, string], mark: boolean) => ({
  edge: `${source.join('#')}>${target.join('#')}`, kind: 'dependency',
  source: { node: source[0], seq: 1, element: source[1], layer: 'technical' }, target: { node: target[0], seq: 1, element: target[1], quote: null, latest: mark ? 2 : 1 },
  mark: mark ? { id: 'm1', reason: 'changed' } : null,
});

test('lineage lists both ways of an element named in the address, reading every page of documents; and lists the stale links when none is', async () => {
  replies['/api/lineage'] = lineagePage([
    { name: 'orders', title: 'Orders', kind: 'spec', layer: 'functional', seq: 2, elements: [{ id: 'R1', text: 'An order can be cancelled.' }, { id: 'R2', text: 'Refunds are prompt.' }] },
  ], [], 'c1');
  replies['/api/lineage?cursor=c1'] = lineagePage([
    { name: 'orders-pg', title: 'Orders on Postgres', kind: 'binding', layer: 'technical', seq: 1, elements: [{ id: 'b1', text: 'orders.status allows cancel.' }, { id: 'b2', text: 'A refund queue.' }] },
  ], [link(['orders-pg', 'b1'], ['orders', 'R1'], false), link(['orders-pg', 'b2'], ['orders', 'R1'], true)]);
  const go = jest.fn();
  const { rerender } = render(<LineageView tick={0} go={go} focus="orders#R1" />);
  const focus = await screen.findByRole('article', { name: 'kj:orders#R1' });
  expect(within(focus).getByText('An order can be cancelled.')).toBeTruthy();
  const by = await within(focus).findByRole('region', { name: 'Relied on by (2)' });
  expect(within(by).getAllByRole('button').map((b) => b.textContent)).toStrictEqual(['kj:orders-pg#b1', 'kj:orders-pg#b2']);
  expect(within(focus).getByRole('region', { name: 'Relies on (0)' })).toBeTruthy();
  fireEvent.click(within(by).getByRole('button', { name: 'kj:orders-pg#b2' }));
  expect(go).toHaveBeenLastCalledWith('lineage/orders-pg#b2');
  fireEvent.click(within(focus).getByRole('button', { name: 'Open in its document' }));
  expect(go).toHaveBeenLastCalledWith('node/orders#R1');

  // From b2: what it relies on, pinned and now stale.
  rerender(<LineageView tick={0} go={go} focus="orders-pg#b2" />);
  const on = screen.getByRole('region', { name: 'Relies on (1)' });
  expect(within(on).getByText('stale')).toBeTruthy();
  expect(within(on).getByText('pinned to @1, now @2')).toBeTruthy();

  // With none named, the stale links; a search lists the elements it finds.
  rerender(<LineageView tick={0} go={go} />);
  const stale = screen.getByRole('region', { name: 'Stale links (1)' });
  expect(within(stale).getByRole('button', { name: 'kj:orders-pg#b2' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Find an element'), { target: { value: 'refund' } });
  expect(screen.getByRole('status').textContent).toMatch(/^2 elements match\./);
  expect(screen.getAllByRole('button', { name: /^kj:/ }).map((b) => b.textContent)).toStrictEqual(['kj:orders#R2', 'kj:orders-pg#b2']);
});

test('an element of lineage has an address of its own', () => {
  expect(parseRoute('#/lineage/orders#R1')).toStrictEqual({ view: 'lineage', focus: 'orders#R1' });
  expect(parseRoute('#/lineage/orders')).toStrictEqual({ view: 'lineage', focus: 'orders#' });
  expect(parseRoute('#/lineage')).toStrictEqual({ view: 'lineage' });
});

test('reviews lists what the person\'s agents reviewed, with their verdicts and notes', async () => {
  replies['/api/reviews'] = { for_me: [], mine: [], next: null, by_agents: [
    { subject: 'kj:orders@3', node: 'orders', seq: 3, reviewer: 'lee-agent', state: 'changes_requested', note: 'Say which email.', at },
    { subject: 'kj:orders@2', node: 'orders', seq: 2, reviewer: 'lee-agent', state: 'approved', note: null, at },
  ] };
  const go = jest.fn();
  render(<ReviewsView tick={0} act={{} as never} go={go} />);
  const agents = await screen.findByRole('region', { name: 'What your agents reviewed' });
  expect(within(agents).getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual([
    expect.stringMatching(/^changes requestedkj:orders@3by lee-agent .*Say which email\.$/), expect.stringMatching(/^approvedkj:orders@2by lee-agent/)]);
  fireEvent.click(within(agents).getByRole('button', { name: 'kj:orders@2' }));
  expect(go).toHaveBeenCalledWith('node/orders@2');
});

test('the open kolab\'s card says what waits there, and only what there is', () => {
  expect(kolabStatus({ stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0 })).toBe('Nothing waits here.');
  expect(kolabStatus({ stale: 2, waiting: 1, reviews: 1, open: 3, cases: 0 })).toBe('1 review for you · 1 question for your layer · 2 marks · 3 open questions in all');
});

test('lineage reads an element in another kolab there, in place, and keeps each link a row of its own', async () => {
  const theirs = { ...link(['orders-pg', 'b1'], ['specs', 'S1'], true), target: { node: 'specs', seq: 1, element: 'S1', quote: null, latest: 2, kolab: 'other' } };
  const quoted = { ...link(['orders-pg', 'b1'], ['orders', 'R1'], true), edge: 'e2' };
  replies['/api/lineage'] = lineagePage([
    { name: 'orders-pg', title: 'Orders on Postgres', kind: 'binding', layer: 'technical', seq: 1, elements: [{ id: 'b1', text: 'orders.status allows cancel.' }] },
  ], [theirs, link(['orders-pg', 'b1'], ['orders', 'R1'], true), quoted]);
  const go = jest.fn();
  render(<LineageView tick={0} go={go} />);
  const stale = await screen.findByRole('region', { name: 'Stale links (3)' });
  expect(within(stale).getAllByRole('listitem')).toHaveLength(3);
  expect(within(stale).getByText('relies on kj:other/specs@1#S1, which changed since')).toBeTruthy();
  cleanup();
  render(<LineageView tick={0} go={go} focus="orders-pg#b1" />);
  const on = await screen.findByRole('region', { name: 'Relies on (3)' });
  fireEvent.click(within(on).getByRole('button', { name: 'kj:other/specs#S1' }));
  expect(go).toHaveBeenLastCalledWith('read/other/specs#S1');
});

test('another kolab\'s card says what waits there for the person; All kolabs keeps to kolabs, and the new document form has its own place', () => {
  expect(waitingStatus({ reviews: 0, questions: 0, marks: 0, cases: 0 })).toBe('Nothing waits for you there.');
  expect(waitingStatus({ reviews: 2, questions: 1, marks: 0, cases: 1 })).toBe('2 reviews for you · 1 question for your layers · 1 case file');
  const o = overview({ waiting: 1 });
  o.kolabs = [o.kolab, { id: 'checkout', title: 'Checkout', owner: 'lee', visibility: 'private', current: false, access: lee.access, waiting: { reviews: 1, questions: 0, marks: 2, cases: 0 } },
    { id: 'billing', title: 'Billing', owner: 'pat', visibility: 'private', current: false, access: { level: 'read', layers: [] } }];
  const props = { overview: o, act: {} as never, onCreated: () => undefined, onOpen: () => undefined, onCreateKolab: async () => false };
  const { rerender } = render(<KolabsView {...props} />);
  expect(within(screen.getByRole('article', { name: 'Checkout' })).getByText('1 review for you · 2 marks')).toBeTruthy();
  expect(within(screen.getByRole('article', { name: 'Billing' })).queryByText(/waits|for you/)).toBeNull();
  expect(screen.queryByRole('heading', { name: /^New document/ })).toBeNull();
  rerender(<KolabsView {...props} start />);
  expect(screen.getByRole('heading', { name: 'New document in accounts' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Kolabs' })).toBeNull();
  expect(parseRoute('#/new')).toStrictEqual({ view: 'new' });
});
