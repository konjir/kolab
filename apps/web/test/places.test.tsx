// The places from the web page's audit of 2026-11-08: the inbox as home, the work board, the
// rulings as precedent to search, and links from element text to the rulings it cites.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WebMe, WebOverview, WebRuling, WorkItemView } from '@konjir/types';
import { InboxView, RulingsView, WorkView, withRulingLinks } from '../src/components/Places.js';

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
  replies['/api/marks'] = { marks: [], next: null };
  replies['/api/cases?state=open'] = { cases: [], belongs: true, next: null };
  render(<InboxView me={lee} overview={overview({ reviews: 1, waiting: 1 })} tick={0} go={() => undefined} />);
  expect(await screen.findByRole('heading', { level: 1, name: '2 things wait on you' })).toBeTruthy();
  const reviews = screen.getByRole('region', { name: /Reviews for you/ });
  expect((await within(reviews).findByRole('link', { name: 'kj:password-reset@4' })).getAttribute('href')).toBe('#/node/password-reset@4');
  // Only the questions the person's own layer answers.
  const questions = screen.getByRole('region', { name: /Questions product answers/ });
  expect(await within(questions).findByText('Timing too?')).toBeTruthy();
  expect(within(questions).queryByText('Which queue?')).toBeNull();
  expect(within(questions).getByRole('link', { name: 'kj:password-reset@3#PR3' }).getAttribute('href')).toBe('#/node/password-reset@3#PR3');
  expect(screen.getByText(/Nothing on your layer is marked/)).toBeTruthy();
});

const work = (id: string, over: Partial<WorkItemView> = {}): WorkItemView => ({
  work: `kj:orders-pg#${id}`, binding: 'orders-pg', id, text: `Build ${id}.\n\nMore.`, state: 'todo', assignee: null, lease_until: null,
  milestone: false, size: 'S', blocked: [], ready: false, ...over,
});

test('the work board shows each binding\'s packages by state, which are blocked and why, and filters to ready, blocked, at risk or mine', async () => {
  replies['/api/work'] = { work: [
    work('W1', { state: 'in_progress', assignee: 'lee-engineer' }),
    work('W2', { blocked: [{ reason: 'depends_on', work: 'kj:orders-pg#W1', state: 'in_progress' }] }),
    work('W3', { ready: true }),
    work('W4', { state: 'done', assignee: 'eng-agent', at_risk: true }),
  ], next: null };
  render(<WorkView me={lee} tick={0} go={() => undefined} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Work' })).toBeTruthy();
  expect(calls[0]).toBe('/api/work?limit=200');
  expect([...document.querySelectorAll('.summary .fact')].map((f) => f.textContent)).toStrictEqual(['1 of 4 work packages done', '1 ready', '1 blocked', '1 at risk']);
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
});

const ruling = (ref: string, text: string): WebRuling => ({
  ruling: `r-${ref}`, ref, on: 'kj:kolab@3', case: null, text, effect: 'change_intent', replaces: null, ruled_by: 'Lee', ruled_at: at, recorded_at: at,
  node: 'kolab', seq: 3, element: null,
} as WebRuling);

test('the rulings can be searched by their name and their words; an address naming one shows it alone', async () => {
  replies['/api/rulings'] = { rulings: [ruling('D104', 'There is no plan: work lives in the binding.'), ruling('D12', 'Konjir is one hosted service.')], next: null };
  const page = render(<RulingsView me={lee} tick={0} go={() => undefined} />);
  expect(await screen.findByText('There is no plan: work lives in the binding.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search the rulings'), { target: { value: 'hosted' } });
  expect(screen.queryByText('There is no plan: work lives in the binding.')).toBeNull();
  expect(screen.getByText('Konjir is one hosted service.')).toBeTruthy();
  page.rerender(<RulingsView me={lee} tick={0} go={() => undefined} focus="D104" />);
  expect(await screen.findByText('There is no plan: work lives in the binding.')).toBeTruthy();
  expect(screen.queryByText('Konjir is one hosted service.')).toBeNull();
  // D1 isn't D104: a name is matched whole.
  fireEvent.change(screen.getByLabelText('Search the rulings'), { target: { value: 'D1' } });
  expect(screen.getByText(/No ruling is called “D1”/)).toBeTruthy();
});

test('an element\'s text links each ruling it cites', () => {
  render(<p>{withRulingLinks('Konjir is one service. Source: D12, D47')}</p>);
  expect(screen.getByRole('link', { name: 'D12' }).getAttribute('href')).toBe('#/rulings/D12');
  expect(screen.getByRole('link', { name: 'D47' }).getAttribute('href')).toBe('#/rulings/D47');
  expect(withRulingLinks('No citation here.')).toBe('No citation here.');
});
