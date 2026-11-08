// The review list (W5.8, WRK5, VER17): versions and work packages waiting for the session's verdict,
// in one list. A work package shows with its done-when, assignee, the evidence of this submission
// (earlier rounds folded away) and its repository, and is approved or sent back from the list, by a
// call to Kolab's web API. Kolab's own rules, and its refusals, are apps/server/test/web.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WebReviewsView, WebWorkOutcome, WebWorkReview } from '@konjir/types';
import { ReviewsView } from '../src/components/Pages.js';
import type { Act } from '../src/components/Marks.js';

const at = new Date().toISOString();
const sha = 'a'.repeat(40);
const repo = 'https://github.com/acme/orders';
const work = (over: Partial<WebWorkReview> = {}): WebWorkReview => ({
  kind: 'work', subject: 'kj:orders-pg#W1', binding: 'orders-pg', id: 'W1', title: 'Build the cancel endpoint.',
  done_when: 'POST /orders/:id/cancel cancels an Open order.', assignee: 'bob', at, note: 'Cancels, with a test.',
  repository: { url: repo, confirmed: false }, open_marks: 0,
  evidence: [
    { id: 'e1', kind: 'commit', sha, title: 'Cancel an order', recorded_by: 'bob', at, repository: repo, confirmed: false },
    { id: 'e2', kind: 'pull_request', pr: 7, url: `${repo}/pull/7`, title: 'Orders: cancel', recorded_by: 'bob', at, repository: repo, confirmed: false },
    { id: 'e3', kind: 'test_run', title: 'npm test: 120 passed', url: 'https://ci.example.com/runs/812', recorded_by: 'bob', at },
    { id: 'e4', kind: 'pull_request', url: 'javascript:alert(1)', title: 'Not a link', recorded_by: 'bob', at, repository: null, confirmed: false },
  ],
  evidence_more: 0, earlier: [], earlier_count: 0, findings: [],
  ...over,
});
const page = (for_me: WebReviewsView['for_me']): WebReviewsView => ({ for_me, mine: [], next: null });

let calls: { url: string; method: string; body: unknown }[];
let reply: unknown;
let outcome: WebWorkOutcome;
let refusal: string | undefined;
beforeEach(() => {
  calls = [];
  refusal = undefined;
  outcome = { work: 'kj:orders-pg#W1', verdict: 'approve', state: 'done', assignee: 'bob', confirmed_repositories: [repo] };
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST' && refusal) return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'conflict', message: refusal }) } as unknown as Response;
    return { ok: true, status: 200, text: async () => JSON.stringify(method === 'GET' ? reply : outcome) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);

let said: string[];
const runner: Act = {
  async run(what, done, told) {
    try { const out = await what(); said.push(told ? told(out) : done); return true; } catch (e) { said.push((e as Error).message); return false; }
  },
};
const routes: string[] = [];
const show = () => { said = []; return render(<ReviewsView tick={0} act={runner} go={(r) => routes.push(r)} />); };
const posts = () => calls.filter((c) => c.method === 'POST');

test('a work package waits beside a version, with its done-when, assignee, evidence and repository; links show where they lead, and only http(s) ones are links', async () => {
  reply = page([work(), { kind: 'version', subject: 'kj:orders-pg@3', node: 'orders-pg', seq: 3, author: 'bob', at }]);
  show();
  expect(await screen.findByText('Build the cancel endpoint.')).toBeTruthy();
  expect(screen.getByText('POST /orders/:id/cancel cancels an Open order.')).toBeTruthy();
  expect(screen.getByText('Cancels, with a test.')).toBeTruthy();
  expect(screen.getByText(/work package by bob/)).toBeTruthy();
  expect(screen.getByRole('link', { name: sha.slice(0, 12) }).getAttribute('href')).toBe(`${repo}/commit/${sha}`);
  expect(screen.getByRole('link', { name: 'PR #7' }).getAttribute('href')).toBe(`${repo}/pull/7`);
  expect(screen.getByRole('link', { name: 'test run' }).getAttribute('href')).toBe('https://ci.example.com/runs/812');
  expect(screen.getByText('github.com')).toBeTruthy();
  expect(screen.getByText('ci.example.com')).toBeTruthy();
  expect(screen.getByText('Not a link')).toBeTruthy();
  expect(screen.queryAllByRole('link').map((a) => a.getAttribute('href'))).not.toContain('javascript:alert(1)');
  expect(screen.getByText(/not confirmed yet: approving confirms it/)).toBeTruthy();
  expect(screen.getByText(/Evidence is bob’s claim/)).toBeTruthy();
  // The version beside it, and each opens its own page.
  fireEvent.click(screen.getByRole('button', { name: 'kj:orders-pg@3' }));
  expect(routes.at(-1)).toBe('node/orders-pg@3');
  fireEvent.click(screen.getByRole('button', { name: 'kj:orders-pg#W1' }));
  expect(routes.at(-1)).toBe('node/orders-pg#W1');
  // Only the work package takes a verdict here.
  expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
});

test('a failed acceptance check shows with the request, naming the spec element and who recorded it, and says it stays whatever the verdict (REV9)', async () => {
  reply = page([work({ findings: [{
    kind: 'acceptance_failed', element: 'kj:test/orders#R2', version: 1, evidence: 'e3', recorded_by: 'bob', at,
    explanation: 'bob\'s test run https://ci.example.com/runs/812 records the acceptance check of kj:test/orders#R2 (version 1) as failed',
  }] })]);
  show();
  expect(await screen.findByText('kj:test/orders#R2')).toBeTruthy();
  expect(screen.getByText('acceptance failed')).toBeTruthy();
  expect(screen.getByText(/failed in bob’s test run/)).toBeTruthy();
  expect(screen.getByText('Each stays on its record whatever your verdict.')).toBeTruthy();
  // Approving isn't refused because of it.
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
});

test('this submission\'s evidence shows; earlier rounds are folded away and counted; a commit recorded before repositories links nowhere', async () => {
  const old = { id: 'e0', kind: 'commit' as const, sha: 'c'.repeat(40), title: 'An earlier try', recorded_by: 'bob', at, repository: null, confirmed: false, before_repositories: true as const };
  reply = page([work({ evidence: [work().evidence[0]], evidence_more: 3, earlier: [old], earlier_count: 5, repository: { url: repo, confirmed: true } })]);
  show();
  expect(await screen.findByText('This submission')).toBeTruthy();
  expect(screen.getByText(/and 3 more/)).toBeTruthy();
  expect(screen.getByText('5 items of evidence from before it last went In progress')).toBeTruthy();
  expect(screen.getByText(/and 4 more/)).toBeTruthy();
  expect(screen.getByText('An earlier try').closest('details')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'c'.repeat(12) })).toBeNull();
  expect(screen.getByText('recorded before repositories: names none')).toBeTruthy();
  expect(screen.getByText(/confirmed$/)).toBeTruthy();
});

test('Approve calls konjir_review work=… through the API and tells what it confirmed; Request changes needs a note', async () => {
  reply = page([work()]);
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toMatchObject({ url: '/api/work/orders-pg/W1/review', body: { verdict: 'approve' } });
  await waitFor(() => expect(said).toStrictEqual([`Approved kj:orders-pg#W1: it is Done. Your approval confirms ${repo}.`]));

  outcome = { work: 'kj:orders-pg#W1', verdict: 'request_changes', state: 'in_progress', assignee: 'bob', confirmed_repositories: [] };
  fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
  const send = screen.getByRole('button', { name: 'Request changes' });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('What must change'), { target: { value: 'It cancels a Shipped order too.' } });
  fireEvent.click(send);
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1]).toMatchObject({ url: '/api/work/orders-pg/W1/review', body: { verdict: 'request_changes', note: 'It cancels a Shipped order too.' } });
  await waitFor(() => expect(said.at(-1)).toBe('Changes requested on kj:orders-pg#W1. It is back with bob, In progress, and they are told.'));
});

test('a refusal is told as Kolab words it; an at-risk package says so; one Kolab couldn\'t read still shows, saying so', async () => {
  reply = page([work({ open_marks: 2, done_when: null }), work({ subject: 'kj:orders-pg#W2', id: 'W2', title: null, missing: true, evidence: [], repository: null })]);
  refusal = "bob is kj:orders-pg#W1's assignee; another actor with Write on the technical layer must review it (PLN16)";
  show();
  expect(await screen.findByText('at risk')).toBeTruthy();
  expect(screen.getByText(/2 open marks say something it serves or relies on changed/)).toBeTruthy();
  expect(screen.getAllByText(/Not given/).length).toBeGreaterThan(0);
  expect(screen.getByRole('alert').textContent).toMatch(/couldn’t read this package’s details/);
  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
  await waitFor(() => expect(said).toStrictEqual([refusal]));
});
