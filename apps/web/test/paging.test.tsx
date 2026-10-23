// Lists in the page come a page at a time (W2.21): a list with more shows a button that reads the
// next page, with the cursor the last page gave, and adds it below; a change Kolab pushes reads the
// list again, as many pages as were shown.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  AccessHolder, InviteView, KolabAccessView, WebActivityView, WebInvitesView, WebMe, WebNodeView, WebOverview, WebQueriesView, WebQuery, WebVersionsView,
} from '@konjir/types';
import { ActivityView, QuestionsView } from '../src/components/Pages.js';
import { NodeView } from '../src/components/NodeView.js';
import { PeopleView } from '../src/components/Onboarding.js';
import type { Act } from '../src/components/Marks.js';

const lee: WebMe = { actor: 'lee', name: 'Lee', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'accounts', access: { level: 'write', layers: ['functional'] } };
const at = new Date().toISOString();
const question = (id: string, text: string): WebQuery => ({
  id, kind: 'question', state: 'open', address: 'kj:orders@1#R1', node: 'orders', seq: 1, element: 'R1', quote: null, layer: 'technical',
  question: text, raised_by: 'eli', at, answer: null, answered_by: null, from: null, mark: null, mark_reason: null,
});

let replies: Record<string, unknown>;
let calls: string[];
beforeEach(() => {
  replies = {};
  calls = [];
  globalThis.fetch = jest.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    return { ok: true, status: 200, text: async () => JSON.stringify(replies[u] ?? {}) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);
const runner: Act = { async run(what) { await what(); return true; } };

test('the questions page reads more open questions with the cursor the last page gave, and adds them below', async () => {
  replies['/api/queries?state=open'] = { queries: [question('q1', 'First?'), question('q2', 'Second?')], next: 'c1' } satisfies WebQueriesView;
  replies['/api/queries?state=open&cursor=c1'] = { queries: [question('q3', 'Third?')], next: null } satisfies WebQueriesView;
  replies['/api/queries?state=settled'] = { queries: [], next: null } satisfies WebQueriesView;
  const page = render(<QuestionsView me={lee} tick={0} act={runner} go={() => undefined} />);
  expect(await screen.findByText('Second?')).toBeTruthy();
  expect(screen.queryByText('Third?')).toBeNull();
  // Only the list that has more offers more.
  expect(screen.queryByRole('button', { name: 'More answered questions' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More open questions' })); });
  expect(screen.getByText('Third?')).toBeTruthy();
  expect(screen.getByText('First?')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'More open questions' })).toBeNull();

  // A change pushed: the list is read again, both pages of it, so nothing shown goes away.
  calls.length = 0;
  page.rerender(<QuestionsView me={lee} tick={1} act={runner} go={() => undefined} />);
  await waitFor(() => expect(calls).toContain('/api/queries?state=open&cursor=c1'));
  expect(calls.filter((c) => c.startsWith('/api/queries?state=open'))).toStrictEqual(['/api/queries?state=open', '/api/queries?state=open&cursor=c1']);
  expect(await screen.findByText('Third?')).toBeTruthy();
});

test('the activity reads its next page on asking', async () => {
  replies['/api/activity'] = { items: [{ at, actor: 'lee', text: 'committed kj:orders@2' }], next: 'a1' } satisfies WebActivityView;
  replies['/api/activity?cursor=a1'] = { items: [{ at, actor: 'eli', text: 'asked about kj:orders@1#R1' }], next: null } satisfies WebActivityView;
  render(<ActivityView tick={0} />);
  expect(await screen.findByText('lee')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More activity' })); });
  expect(screen.getByText('eli')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'More activity' })).toBeNull();
});

/** A spec at version 3 whose element R1 has more questions than it shows, as does the node as a whole. */
const spec = (): WebNodeView => ({
  node: { name: 'orders', kind: 'functional_spec', layer: 'functional', title: 'Orders', latest: 3, drafts: 0, in_review: 0 },
  reading: { seq: 3, state: 'committed', author: 'lee', role: 'product', at, note: null, mine: true },
  versions: [3, 2].map((seq) => ({ seq, state: 'committed' as const, author: 'lee', role: 'product', at, note: null, mine: true })),
  versions_next: 'v2',
  elements: [{ id: 'R1', parent: null, text: 'Orders can be cancelled.', address: 'kj:orders@3#R1', queries: [question('q9', 'Newest on R1?')], queries_next: 'r1',
    relies_on: [], relied_on_by: [], marks: [], rulings: [], cases: [] }],
  queries: [{ ...question('n2', 'Newest on the spec?'), element: null }], queries_next: 'n1',
  compared_with: null, in_review: [], drafts: [], can_write: true, rulings: [], kolab: 'accounts', foreign: false,
});

test('a node\'s page reads its older versions, and older questions on an element and on the node, each with the cursor it was given', async () => {
  replies['/api/nodes/orders'] = spec();
  replies['/api/nodes/orders/versions?cursor=v2'] = { versions: [{ seq: 1, state: 'committed', author: 'lee', role: 'product', at, note: null, mine: true }], next: null } satisfies WebVersionsView;
  replies['/api/nodes/orders/queries?element=R1&cursor=r1'] = { queries: [question('q8', 'Older on R1?')], next: null } satisfies WebQueriesView;
  replies['/api/nodes/orders/queries?cursor=n1'] = { queries: [{ ...question('n1', 'Older on the spec?'), element: null }], next: null } satisfies WebQueriesView;
  const page = render(<NodeView me={lee} name="orders" tick={0} act={runner} go={() => undefined} read={() => undefined} />);
  expect(await screen.findByText('Newest on R1?')).toBeTruthy();
  const versions = () => screen.getAllByRole('button').map((b) => b.textContent).filter((t) => /^v\d/.test(t ?? ''));
  expect(versions()).toStrictEqual(['v2', 'v3']);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Older …' })); });
  expect(versions()).toStrictEqual(['v1', 'v2', 'v3']);
  expect(screen.queryByRole('button', { name: 'Older …' })).toBeNull();

  expect(screen.queryByText('Older on R1?')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More questions on R1' })); });
  expect(screen.getByText('Older on R1?')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'More questions on R1' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More questions on kj:orders' })); });
  expect(screen.getByText('Older on the spec?')).toBeTruthy();

  // A change pushed: the node is read again, and so is each page read after its first.
  calls.length = 0;
  page.rerender(<NodeView me={lee} name="orders" tick={1} act={runner} go={() => undefined} read={() => undefined} />);
  await waitFor(() => expect(calls).toEqual(expect.arrayContaining([
    '/api/nodes/orders', '/api/nodes/orders/versions?cursor=v2', '/api/nodes/orders/queries?element=R1&cursor=r1', '/api/nodes/orders/queries?cursor=n1'])));
  expect(await screen.findByText('Older on R1?')).toBeTruthy();
});

test('the people page reads more invites and more of who holds access on asking', async () => {
  const admin: WebMe = { ...lee, access: { level: 'admin', layers: ['functional', 'technical'] } };
  const invite = (id: string, by: string): InviteView => ({ id, kolab: 'accounts', level: 'read', layers: [], invited_by: by, created_at: at, expires_at: at, state: 'open', accepted_by: null, accepted_at: null });
  const holder = (actor: string): AccessHolder => ({ actor, kind: 'person', owner: null, access: { level: 'read', layers: [] }, sources: [], grant: null, outside: false });
  const kolab = { id: 'accounts', owner: 'lee', owner_kind: 'user' as const, visibility: 'private' as const, base_permission: null };
  replies['/api/invites'] = { invites: [invite('i2', 'lee')], next: 'i1' } satisfies WebInvitesView;
  replies['/api/invites?cursor=i1'] = { invites: [invite('i1', 'mia')], next: null } satisfies WebInvitesView;
  replies['/api/access'] = { kolab, holders: [holder('ann')], teams: [], next: 'a1' } satisfies KolabAccessView;
  replies['/api/access?cursor=a1'] = { kolab, holders: [holder('bo')], teams: [], next: null } satisfies KolabAccessView;
  const overview = { kolab: { id: 'accounts', title: 'Accounts', owner: 'lee' } } as unknown as WebOverview;
  render(<PeopleView me={admin} overview={overview} tick={0} act={runner} />);
  expect(await screen.findByText('ann')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More people and agents' })); });
  expect(screen.getByText('bo')).toBeTruthy();
  expect(screen.getByText('ann')).toBeTruthy();
  expect(await screen.findByText(/by lee/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More invites' })); });
  expect(screen.getByText(/by mia/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'More invites' })).toBeNull();
});
