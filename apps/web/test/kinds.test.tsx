// Konstruct kinds on the page (W4.1; D77, D78): the new document form offers the kinds a kolab can
// still take and asks a plan for the binding it plans, and a document's page says what it binds or
// plans. Kolab's own refusals are libs/engine/test/kinds.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { REFRESH_HEADER, type WebMe, type WebNodeSummary, type WebNodeView, type WebOverview } from '@konjir/types';
import { markPushTick } from '../src/api.js';
import { KolabsView } from '../src/components/Pages.js';
import { NodeView } from '../src/components/NodeView.js';
import type { Act } from '../src/components/Marks.js';

const pm: WebMe = { actor: 'lee', name: 'Lee', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'accounts', access: { level: 'write', layers: ['functional', 'technical'] } };
const eng: WebMe = { ...pm, actor: 'eng-agent', name: 'eng-agent', kind: 'agent', owner: 'lee', role: 'engineer', layer: 'technical' };
const node = (name: string, kind: WebNodeSummary['kind'], parent?: string): WebNodeSummary => ({
  name, kind, layer: kind === 'spec' || kind === 'prototype' ? 'functional' : 'technical', title: name, latest: 1, drafts: 0, in_review: 0, ...(parent ? { parent } : {}),
});
const NODES = [node('accounts', 'spec'), node('accounts-api', 'binding', 'accounts'), node('accounts-web', 'binding', 'accounts'),
  node('accounts-api-plan', 'plan', 'accounts-api')];
const overview = (me: WebMe, nodes: WebNodeSummary[] = NODES): WebOverview => ({
  me, kolab: { id: 'accounts', title: 'Accounts', owner: 'lee', visibility: 'private', current: true, access: me.access }, kolabs: [],
  nodes, nodes_next: null, counts: { stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0 },
});

let calls: { url: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);
const runner: Act = { async run(what) { await what(); return true; } };
const form = (o: WebOverview) => render(<KolabsView overview={o} act={runner} start onCreated={() => undefined} onOpen={() => undefined} onCreateKolab={async () => true} />);
const kinds = () => [...(screen.getByLabelText('Kind') as HTMLSelectElement).options].map((o) => o.value);

test('a kolab with its spec offers product a prototype, never a second spec (KON1)', () => {
  form(overview(pm));
  expect(kinds()).toStrictEqual(['prototype']);
  cleanup();
  form(overview(pm, []));
  expect(kinds()).toStrictEqual(['spec', 'prototype']);
});

test('a plan names the binding it plans, from those without a plan (D78, KON5)', async () => {
  form(overview(eng));
  expect(kinds()).toStrictEqual(['binding', 'plan']);
  fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'plan' } });
  expect([...(screen.getByLabelText('Plans the binding') as HTMLSelectElement).options].map((o) => o.value)).toStrictEqual(['accounts-web']);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Web plan' } });
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'accounts-web-plan' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
  expect(calls.at(-1)).toStrictEqual({ url: '/api/nodes', body: { kind: 'plan', title: 'Web plan', name: 'accounts-web-plan', parent: 'accounts-web' } });
});

test('a binding is made with no parent named: Kolab names the kolab\'s spec', async () => {
  form(overview(eng));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Mobile' } });
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'accounts-mobile' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
  expect(calls.at(-1)).toStrictEqual({ url: '/api/nodes', body: { kind: 'binding', title: 'Mobile', name: 'accounts-mobile' } });
});

test('a plan\'s page shows where each work package stands, read only: its state, who holds it, and what blocks it (W5.1b)', async () => {
  const el = (id: string, extra: Partial<WebNodeView['elements'][number]>) => ({
    id, parent: null, text: `Package ${id}.`, address: `kj:accounts-api-plan@1#${id}`, queries: [], relies_on: [], relied_on_by: [], marks: [], rulings: [], cases: [], ...extra,
  });
  const plan: WebNodeView = {
    node: node('accounts-api-plan', 'plan', 'accounts-api'),
    reading: { seq: 1, state: 'committed', author: 'eng-agent', role: 'engineer', at: new Date().toISOString(), note: null, mine: true },
    versions: [], versions_next: null, queries: [], queries_next: null, compared_with: null, in_review: [], drafts: [], can_write: true,
    rulings: [], kolab: 'accounts', foreign: false,
    elements: [
      el('W1', { work_state: { state: 'in_progress', assignee: 'eng-agent', lease_until: new Date(Date.now() + 1_800_000).toISOString(), blocked: [], milestone: false } }),
      el('W2', { work: { depends_on: ['W1'] }, work_state: { state: 'todo', assignee: null, lease_until: null, blocked: [{ reason: 'depends_on', work: 'kj:accounts-api-plan#W1', state: 'in_progress' }], milestone: false } }),
    ],
  };
  globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(plan) }) as unknown as Response) as typeof fetch;
  render(<NodeView me={eng} name="accounts-api-plan" tick={0} act={runner} go={() => undefined} read={() => undefined} />);
  const states = await screen.findAllByLabelText('Work package');
  expect(states[0].textContent).toMatch(/^StateIn progress · eng-agent, lease until /);
  expect(states[1].textContent).toMatch(/^StateTo do · Blocked by W1 \(In progress\)/);
});

test('the page marks a re-read a pushed event prompted, and only that one, so it renews no lease (D100)', async () => {
  const plan: WebNodeView = {
    node: node('accounts-api-plan', 'plan', 'accounts-api'),
    reading: { seq: 1, state: 'committed', author: 'eng-agent', role: 'engineer', at: new Date().toISOString(), note: null, mine: true },
    versions: [], versions_next: null, elements: [], queries: [], queries_next: null, compared_with: null, in_review: [], drafts: [], can_write: true,
    rulings: [], kolab: 'accounts', foreign: false,
  };
  const seen: (string | undefined)[] = [];
  globalThis.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.[REFRESH_HEADER]);
    return { ok: true, status: 200, text: async () => JSON.stringify(plan) } as unknown as Response;
  }) as typeof fetch;
  const view = (tick: number) => <NodeView me={eng} name="accounts-api-plan" tick={tick} act={runner} go={() => undefined} read={() => undefined} />;
  const { rerender } = render(view(500));
  await screen.findByText('Plan');
  // A push moved the tick: the re-read says so.
  markPushTick(501);
  await act(async () => { rerender(view(501)); });
  // A person's action moved it: no mark.
  await act(async () => { rerender(view(502)); });
  expect(seen).toStrictEqual([undefined, 'push', undefined]);
});

test('a plan\'s page says which binding it plans', async () => {
  const plan: WebNodeView = {
    node: node('accounts-api-plan', 'plan', 'accounts-api'),
    reading: { seq: 1, state: 'committed', author: 'eng-agent', role: 'engineer', at: new Date().toISOString(), note: null, mine: true },
    versions: [], versions_next: null, elements: [], queries: [], queries_next: null, compared_with: null, in_review: [], drafts: [], can_write: true,
    rulings: [], kolab: 'accounts', foreign: false,
  };
  globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(plan) }) as unknown as Response) as typeof fetch;
  render(<NodeView me={eng} name="accounts-api-plan" tick={0} act={runner} go={() => undefined} read={() => undefined} />);
  expect(await screen.findByText('Plan')).toBeTruthy();
  expect(screen.getByText(/^plans/).textContent).toBe('plans kj:accounts-api');
});
