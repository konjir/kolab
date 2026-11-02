// The review list (W5.8, WRK5, VER17): versions and work packages waiting for the session's verdict,
// in one list. A work package shows with its done-when, assignee and evidence, and is approved or
// sent back from the list, by a call to Kolab's web API. Kolab's own rules, and its refusals, are
// apps/server/test/web.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WebReviewsView, WebWorkReview } from '@konjir/types';
import { ReviewsView } from '../src/components/Pages.js';
import type { Act } from '../src/components/Marks.js';

const at = new Date().toISOString();
const sha = 'a'.repeat(40);
const work = (over: Partial<WebWorkReview> = {}): WebWorkReview => ({
  kind: 'work', subject: 'kj:orders-pg#W1', binding: 'orders-pg', id: 'W1', title: 'Build the cancel endpoint.',
  done_when: 'POST /orders/:id/cancel cancels an Open order.', assignee: 'bob', at, note: 'Cancels, with a test.',
  repository: 'https://github.com/acme/orders', open_marks: 0,
  evidence: [
    { id: 'e1', kind: 'commit', sha, title: 'Cancel an order', recorded_by: 'bob', at, event: 'ev1', repository: 'https://github.com/acme/orders', confirmed: false },
    { id: 'e2', kind: 'pull_request', pr: 7, url: 'https://github.com/acme/orders/pull/7', title: 'Orders: cancel', recorded_by: 'bob', at, event: 'ev1', repository: 'https://github.com/acme/orders', confirmed: false },
    { id: 'e3', kind: 'test_run', title: 'npm test: 120 passed', recorded_by: 'bob', at, event: 'ev1' },
    { id: 'e4', kind: 'pull_request', url: 'javascript:alert(1)', title: 'Not a link', recorded_by: 'bob', at, event: 'ev1', repository: null, confirmed: false },
  ],
  ...over,
});
const page = (for_me: WebReviewsView['for_me']): WebReviewsView => ({ for_me, mine: [], next: null });

let calls: { url: string; method: string; body: unknown }[];
let reply: unknown;
let refusal: string | undefined;
beforeEach(() => {
  calls = [];
  refusal = undefined;
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST' && refusal) return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'conflict', message: refusal }) } as unknown as Response;
    return { ok: true, status: 200, text: async () => JSON.stringify(method === 'GET' ? reply : { work: 'kj:orders-pg#W1', verdict: 'approve', state: 'done', assignee: 'bob', confirmed_repositories: [] }) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);

let said: string[];
const runner: Act = { async run(what, done) { try { await what(); said.push(done); return true; } catch (e) { said.push((e as Error).message); return false; } } };
const routes: string[] = [];
const show = () => { said = []; return render(<ReviewsView tick={0} act={runner} go={(r) => routes.push(r)} />); };
const posts = () => calls.filter((c) => c.method === 'POST');

test('a work package waits beside a version, with its done-when, assignee and evidence; a commit links into its repository, and only http(s) links are links', async () => {
  reply = page([work(), { kind: 'version', subject: 'kj:orders-pg@3', node: 'orders-pg', seq: 3, author: 'bob', at }]);
  show();
  expect(await screen.findByText('Build the cancel endpoint.')).toBeTruthy();
  expect(screen.getByText('POST /orders/:id/cancel cancels an Open order.')).toBeTruthy();
  expect(screen.getByText('Cancels, with a test.')).toBeTruthy();
  expect(screen.getByText(/work package by bob/)).toBeTruthy();
  expect(screen.getByRole('link', { name: sha.slice(0, 12) }).getAttribute('href')).toBe(`https://github.com/acme/orders/commit/${sha}`);
  expect(screen.getByRole('link', { name: 'PR #7' }).getAttribute('href')).toBe('https://github.com/acme/orders/pull/7');
  expect(screen.getByText('npm test: 120 passed')).toBeTruthy();
  expect(screen.getByText('Not a link')).toBeTruthy();
  expect(screen.queryAllByRole('link').map((a) => a.getAttribute('href'))).not.toContain('javascript:alert(1)');
  expect(screen.getByText(/Evidence is bob’s claim/)).toBeTruthy();
  // The version beside it, and each opens its own page.
  fireEvent.click(screen.getByRole('button', { name: 'kj:orders-pg@3' }));
  expect(routes.at(-1)).toBe('node/orders-pg@3');
  fireEvent.click(screen.getByRole('button', { name: 'kj:orders-pg#W1' }));
  expect(routes.at(-1)).toBe('node/orders-pg#W1');
  // Only the work package takes a verdict here.
  expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
});

test('Approve calls konjir_review work=… through the API; Request changes needs a note', async () => {
  reply = page([work()]);
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toMatchObject({ url: '/api/work/orders-pg/W1/review', body: { verdict: 'approve' } });
  await waitFor(() => expect(said).toStrictEqual(['Approved kj:orders-pg#W1: it is Done.']));

  fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
  const send = screen.getByRole('button', { name: 'Request changes' });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('What must change'), { target: { value: 'It cancels a Shipped order too.' } });
  fireEvent.click(send);
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]).toMatchObject({ url: '/api/work/orders-pg/W1/review', body: { verdict: 'request_changes', note: 'It cancels a Shipped order too.' } });
});

test('a refusal is told as Kolab words it; an at-risk package says so', async () => {
  reply = page([work({ open_marks: 2, done_when: null })]);
  refusal = "bob is kj:orders-pg#W1's assignee; another actor with Write on the technical layer must review it (PLN16)";
  show();
  expect(await screen.findByText('at risk')).toBeTruthy();
  expect(screen.getByText(/2 open marks say something it serves or relies on changed/)).toBeTruthy();
  expect(screen.getByText(/Not given/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(said).toStrictEqual([refusal]));
});
