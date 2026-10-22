// The document page (W3.1): a spec read with its questions and marks beside each element, edits
// kept as a draft and submitted, an answer given, a mark settled, and a review given, each a call
// to Kolab's web API. Kolab's own behavior is apps/server/test/web.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nobodyCanReview, type WebMark, type WebMe, type WebNodeView, type WebQuery } from '@konjir/types';
import { NodeView } from '../src/components/NodeView.js';
import type { Act } from '../src/components/Marks.js';
import { parseRoute } from '../src/App.js';
import { nextElementId, wordDiff } from '../src/util.js';

const lee: WebMe = { actor: 'lee', name: 'Lee', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'accounts', access: { level: 'write', layers: ['functional'] } };
const eng: WebMe = { ...lee, actor: 'eng-agent', name: 'eng-agent', kind: 'agent', owner: 'lee', role: 'engineer', layer: 'technical', access: { level: 'write', layers: ['technical'] } };
const at = new Date().toISOString();

const question: WebQuery = {
  id: 'q1', kind: 'question', state: 'open', address: 'kj:password-reset@3#PR3', node: 'password-reset', seq: 3, element: 'PR3', quote: null,
  layer: 'functional', question: 'Should the response time be indistinguishable too?', raised_by: 'eng-agent', at, answer: null, answered_by: null,
  from: null, mark: null, mark_reason: null,
};
const mark: WebMark = {
  id: 'm1', reason: 'changed', node: 'password-reset-pg', seq: 2, element: 'B9', layer: 'technical', because: 'kj:password-reset#PR8 changed in version 3', next: '', at,
  target: { node: 'password-reset', element: 'PR8', pinned: 2, now: 3, before: 'At most 5 reset requests per hour.', after: 'At most 3 reset requests per hour.' },
  override: null, question: null,
};
const spec = (over: Partial<WebNodeView> = {}): WebNodeView => ({
  node: { name: 'password-reset', kind: 'functional_spec', layer: 'functional', title: 'Password reset', latest: 3, drafts: 0, in_review: 0 },
  reading: { seq: 3, state: 'committed', author: 'Lee', role: 'product', at, note: null, mine: true },
  versions: [1, 2, 3].map((seq) => ({ seq, state: 'committed' as const, author: 'pm-agent', role: 'product', at, note: null, mine: false })),
  elements: [
    { id: 'PR3', parent: null, text: 'The request page shows the same response whether or not the email belongs to an account.', address: 'kj:password-reset@3#PR3', queries: [question], relies_on: [], relied_on_by: [], marks: [], rulings: [], cases: [] },
    { id: 'PR8', parent: null, text: 'At most 3 reset requests per hour.', address: 'kj:password-reset@3#PR8', queries: [], relies_on: [], marks: [], rulings: [], cases: [],
      relied_on_by: [{ edge: 'e1', kind: 'dependency', source: { node: 'password-reset-pg', seq: 2, element: 'B9', layer: 'technical' }, target: { node: 'password-reset', seq: 2, element: 'PR8', quote: null, latest: 3 }, mark: { id: 'm1', reason: 'changed' } }] },
  ],
  queries: [], compared_with: null, in_review: [], drafts: [], can_write: true, rulings: [], kolab: 'accounts', foreign: false,
  ...over,
});
const binding = (): WebNodeView => ({
  ...spec(),
  node: { name: 'password-reset-pg', kind: 'technical_binding', layer: 'technical', title: 'Password reset on Postgres', latest: 2, drafts: 0, in_review: 0 },
  reading: { seq: 2, state: 'committed', author: 'eng-agent', role: 'engineer', at, note: null, mine: false },
  versions: [],
  elements: [{ id: 'B9', parent: null, text: 'Rate limit: 5 requests per normalized email per hour.', address: 'kj:password-reset-pg@2#B9', queries: [], relied_on_by: [], marks: [mark], rulings: [], cases: [],
    relies_on: [{ edge: 'e1', kind: 'dependency', source: { node: 'password-reset-pg', seq: 2, element: 'B9', layer: 'technical' }, target: { node: 'password-reset', seq: 2, element: 'PR8', quote: null, latest: 3 }, mark: { id: 'm1', reason: 'changed' } }] }],
  can_write: false,
});

let calls: { url: string; method: string; body: unknown }[];
let replies: Record<string, unknown>;
beforeEach(() => {
  calls = [];
  replies = {};
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(replies).filter((k) => u.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    // jsdom has no Response: this is the part of one the page reads.
    return { ok: true, status: 200, text: async () => JSON.stringify(key ? replies[key] : {}) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);

const said: string[] = [];
const runner: Act = { async run(what, done) { await what(); said.push(done); return true; } };
const view = (me: WebMe, data: WebNodeView, name = data.node.name) => {
  replies[`/api/nodes/${name}`] = data;
  return render(<NodeView me={me} name={name} tick={0} act={runner} go={() => undefined} read={() => undefined} />);
};

test('a spec reads with its question beside its element, and its owner answers it there', async () => {
  view(lee, spec());
  expect(await screen.findByText('Should the response time be indistinguishable too?')).toBeTruthy();
  expect(screen.getByText(/eng-agent asked/)).toBeTruthy();
  expect(screen.getByText('relied on by')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/^Answer\./), { target: { value: 'Yes: pad both to the same time.' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Answer' })); });
  expect(calls.at(-1)).toStrictEqual({ url: '/api/queries/q1/answer', method: 'POST', body: { answer: 'Yes: pad both to the same time.' } });
});

test('a stale binding element shows what changed, and only its own layer may say it still holds', async () => {
  view(lee, binding());
  expect(await screen.findByText(/^Rate limit/)).toBeTruthy();
  expect(screen.getByText(/changed in version 3\. This element was written against version 2/)).toBeTruthy();
  expect(document.querySelector('.diff del')?.textContent).toBe('5');
  expect(document.querySelector('.diff ins')?.textContent).toBe('3');
  expect(screen.queryByRole('button', { name: 'Still holds' })).toBeNull();
  expect(screen.getByText('Waiting on the technical layer to settle it.')).toBeTruthy();
});

test('the layer that owns a stale element says it still holds', async () => {
  view(eng, binding());
  const holds = await screen.findByRole('button', { name: 'Still holds' });
  await act(async () => { fireEvent.click(holds); });
  expect(calls.at(-1)).toMatchObject({ url: '/api/marks/m1/clear', method: 'POST' });
});

test('edits are kept as a draft in the page until submitted for review', async () => {
  view(lee, spec());
  fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[1]);
  fireEvent.change(screen.getByLabelText('Edit PR8'), { target: { value: 'At most 3 reset requests per email address per hour.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep in draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add a requirement' }));
  fireEvent.change(screen.getByLabelText('Edit PR9'), { target: { value: 'A reset is logged.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep in draft' }));
  expect(screen.getByText(/2 changes to kj:password-reset/)).toBeTruthy();
  replies['/api/nodes/password-reset/submit'] = { ok: false, seq: 4, committed: false, in_review: true, stale: false, unreviewed: false, reviewers: ['pm-agent'], note: null, cascade_queued: false, abandoned: false };
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit for review' })); });
  expect(calls.find((c) => c.url.endsWith('/submit'))!.body).toStrictEqual({
    base: 3,
    changes: [{ kind: 'override', element: 'PR8', text: 'At most 3 reset requests per email address per hour.' }, { kind: 'add', element: 'PR9', text: 'A reset is logged.' }],
  });
  await waitFor(() => expect(screen.getByText(/pm-agent has been asked to review it/)).toBeTruthy());
});

test('a reviewer asked to review a version approves it, or requests changes with a note', async () => {
  view(lee, spec({ in_review: [{ seq: 4, author: 'pm-agent', at, reviewers: ['lee'], for_me: true }] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Request changes' }));
  fireEvent.change(screen.getByLabelText('What must change'), { target: { value: 'Split PR8.' } });
  replies['/api/nodes/password-reset/versions/4/review'] = { ok: false, seq: 4, committed: false, in_review: false, stale: false, unreviewed: false, reviewers: [], note: 'Split PR8.', cascade_queued: false, abandoned: false };
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Request changes' })); });
  expect(calls.find((c) => c.method === 'POST')).toStrictEqual({ url: '/api/nodes/password-reset/versions/4/review', method: 'POST', body: { verdict: 'request_changes', note: 'Split PR8.' } });
});

test('a new spec submitted for review shows its version in review, not an empty page', async () => {
  const review = { seq: 1, author: 'lee', at, reviewers: ['pat'], for_me: false };
  const v1 = { seq: 1, state: 'in_review' as const, author: 'lee', role: 'product', at, note: null, mine: true };
  const node = { ...spec().node, latest: null, in_review: 1 };
  replies['/api/nodes/password-reset?version=1'] = spec({ node, reading: v1, versions: [v1], in_review: [review] });
  view(lee, spec({ node, reading: null, versions: [v1], elements: [], in_review: [review] }));
  expect(await screen.findByText(/^At most 3 reset requests per hour/)).toBeTruthy();
  expect(calls.map((c) => c.url)).toStrictEqual(['/api/nodes/password-reset', '/api/nodes/password-reset?version=1']);
  expect(screen.queryByText(/No requirements yet/)).toBeNull();
  expect(screen.getByText(/Version 1, in review, by lee/)).toBeTruthy();
  expect(screen.getByText(/Not committed yet: nothing is, so this is the version waiting/)).toBeTruthy();
  expect(screen.getByRole('region', { name: 'In review' }).textContent).toMatch(/Version 1 of kj:password-reset, submitted by lee/);
  // Not editable while it waits: an edit would be made on top of nothing committed.
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add a requirement' })).toBeNull();
});

test('a committed spec with a newer version in review still reads the committed one, and says where the changes are', async () => {
  const read = jest.fn();
  replies['/api/nodes/password-reset'] = spec({ in_review: [{ seq: 4, author: 'pm-agent', at, reviewers: ['pat'], for_me: false }] });
  render(<NodeView me={lee} name="password-reset" tick={0} act={runner} go={() => undefined} read={read} />);
  expect(await screen.findByText(/^At most 3 reset requests per hour/)).toBeTruthy();
  expect(screen.getByText(/Version 3, committed by Lee/)).toBeTruthy();
  const bar = screen.getByRole('region', { name: 'In review' });
  expect(bar.textContent).toMatch(/The changes are in v4, submitted by pm-agent .*This page shows v3, the committed version\. v4 waits for pat/);
  const link = screen.getByRole('link', { name: 'v4' });
  expect(link.getAttribute('href')).toBe('#/node/password-reset@4');
  fireEvent.click(link);
  expect(read).toHaveBeenCalledWith(4);
});

test('when nobody else can review a version yet, the page says so and how to get a reviewer, in the bar and on submitting (D65)', async () => {
  view(lee, spec({ in_review: [{ seq: 4, author: 'lee', at, reviewers: [], for_me: false }] }));
  expect(await screen.findByText(new RegExp(nobodyCanReview('functional').replace(/[.]/g, '\\.')))).toBeTruthy();
  cleanup();
  view(lee, spec());
  fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[1]);
  fireEvent.change(screen.getByLabelText('Edit PR8'), { target: { value: 'At most 2 reset requests per hour.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep in draft' }));
  replies['/api/nodes/password-reset/submit'] = { ok: false, seq: 4, committed: false, in_review: true, stale: false, unreviewed: false, reviewers: [], note: null, cascade_queued: false, abandoned: false };
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit for review' })); });
  await waitFor(() => expect(screen.getByText(/Structural checks passed\. Nobody else can review the functional layer yet\. Invite a product teammate, or connect an agent of yours with the product role\./)).toBeTruthy());
});

test('an engineer reading the spec may ask, not edit', async () => {
  view(eng, spec({ can_write: false }));
  await screen.findByText(/Engineers can’t change intent/);
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.getByText('Waiting on the functional layer.')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Ask' })[0]);
  fireEvent.change(screen.getByLabelText(/Ask about/), { target: { value: 'Which timing?' } });
  await act(async () => { fireEvent.click(document.querySelector('form.ask-form button[type=submit]')!); });
  expect(calls.at(-1)).toStrictEqual({ url: '/api/queries', method: 'POST', body: { node: 'password-reset', seq: 3, element: 'PR3', kind: 'question', text: 'Which timing?' } });
});

test('routes, diffs and new element IDs', () => {
  expect(parseRoute('#/node/password-reset@2#PR6')).toStrictEqual({ view: 'node', name: 'password-reset', version: 2, focus: 'password-reset#PR6' });
  expect(parseRoute('#/questions')).toStrictEqual({ view: 'questions' });
  expect(parseRoute('')).toStrictEqual({ view: 'home' });
  expect(wordDiff('at most 5 a day', 'at most 3 a day')).toStrictEqual([{ kind: 'same', text: 'at most ' }, { kind: 'del', text: '5' }, { kind: 'ins', text: '3' }, { kind: 'same', text: ' a day' }]);
  expect(nextElementId(['PR1', 'PR2', 'PR10', 'X1'], 'R')).toBe('PR11');
  expect(nextElementId([], 'B')).toBe('B1');
});
