// Case files and rulings in the page, and another kolab read in place (W3.2): each action a call
// to Kolab's web API, offered only to whom Kolab would allow it. Kolab's own rules are
// apps/server/test/web.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WebCase, WebMark, WebMe, WebNodeView, WebQuery, WebRuling } from '@konjir/types';
import { NodeView } from '../src/components/NodeView.js';
import { CasesView } from '../src/components/Cases.js';
import type { Act } from '../src/components/Marks.js';
import { parseRoute } from '../src/App.js';
import { parseKj, routeOf } from '../src/util.js';

const lee: WebMe = { actor: 'lee', name: 'Lee', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'accounts', access: { level: 'admin', layers: ['functional', 'technical'] } };
const eli: WebMe = { ...lee, actor: 'eli', name: 'Eli', role: 'engineer', layer: 'technical', access: { level: 'write', layers: ['technical'] } };
const reader: WebMe = { ...lee, actor: 'rae', name: 'Rae', access: { level: 'read', layers: [] } };
const at = new Date().toISOString();

const position = (p: Partial<WebCase['positions'][number]>): WebCase['positions'][number] => ({
  position: 'p1', actor: 'eli', claim: 'Timing can’t be equalized without a queue.', evidence: ['kj:password-reset-pg@2#B10', 'load test run 812'],
  seeks: 'change_intent', verdict: null, taken_at: at, ...p,
});
const caseFile = (over: Partial<WebCase> = {}): WebCase => ({
  case: 'c1', on: 'kj:password-reset@3#PR3', node: 'password-reset', seq: 3, element: 'PR3', layer: 'functional',
  question: 'Must the response time be indistinguishable too?', state: 'open', opened_by: 'eli', opened_at: at,
  positions: [position({})], ruling: null, superseded_by: null, next: '',
  you: { party: false, can_argue: true, can_rule: false }, ...over,
});
const ruling: WebRuling = {
  ruling: 'r1', on: 'kj:password-reset@2#PR7', node: 'password-reset', seq: 2, element: 'PR7', case: null,
  text: 'A reset signs the user in with a new session.', effect: 'change_intent', replaces: null, ruled_by: 'lee', ruled_at: at,
};
const ruled: WebMark = {
  id: 'm9', reason: 'ruled', node: 'password-reset', seq: 3, element: 'PR7', layer: 'functional', because: 'ruling r1 changes the intent of kj:password-reset#PR7',
  next: '', at, target: null, override: null, question: 'q9',
};
const ruledQuestion: WebQuery = {
  id: 'q9', kind: 'question', state: 'open', address: 'kj:password-reset@3#PR7', node: 'password-reset', seq: 3, element: 'PR7', quote: null, layer: 'functional',
  question: 'Ruling r1 changes the intent of kj:password-reset#PR7. Amend it.', raised_by: null, at, answer: null, answered_by: null, from: null, mark: 'm9', mark_reason: 'ruled',
};
const el = (id: string, text: string, over: Partial<WebNodeView['elements'][number]> = {}): WebNodeView['elements'][number] => ({
  id, parent: null, text, address: `kj:password-reset@3#${id}`, queries: [], relies_on: [], relied_on_by: [], marks: [], rulings: [], cases: [], ...over,
});
const spec = (over: Partial<WebNodeView> = {}, els: WebNodeView['elements'] = [el('PR3', 'The request page shows the same response either way.', { cases: [caseFile()] })]): WebNodeView => ({
  node: { name: 'password-reset', kind: 'spec', layer: 'functional', title: 'Password reset', latest: 3, drafts: 0, in_review: 0 },
  reading: { seq: 3, state: 'committed', author: 'Lee', role: 'product', at, note: null, mine: true },
  versions: [1, 2, 3].map((seq) => ({ seq, state: 'committed' as const, author: 'pm-agent', role: 'product', at, note: null, mine: false })), versions_next: null,
  elements: els, queries: [], queries_next: null, compared_with: null, in_review: [], drafts: [], can_write: true, rulings: [], kolab: 'accounts', foreign: false, ...over,
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
    return { ok: true, status: 200, text: async () => JSON.stringify(key ? replies[key] : {}) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);

const said: string[] = [];
const runner: Act = { async run(what, done) { await what(); said.push(done); return true; } };
const routes: string[] = [];
const view = (me: WebMe, data: WebNodeView, opts: { kolab?: string } = {}) => {
  replies[opts.kolab ? `/api/kolabs/${opts.kolab}/nodes/${data.node.name}` : `/api/nodes/${data.node.name}`] = data;
  return render(<NodeView me={me} name={data.node.name} kolab={opts.kolab} tick={0} act={runner} go={(r) => routes.push(r)} read={() => undefined} />);
};
const posts = () => calls.filter((c) => c.method === 'POST');

test('an open case file shows beside its element, with its position and evidence; the other side is taken there', async () => {
  view(lee, spec());
  expect(await screen.findByText('Must the response time be indistinguishable too?')).toBeTruthy();
  expect(screen.getByText('Seeks to change the intent')).toBeTruthy();
  expect(screen.getByText('load test run 812')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'kj:password-reset-pg@2#B10' }));
  expect(routes.at(-1)).toBe('node/password-reset-pg@2#B10');
  expect(screen.getByText(/Your position will seek to keep the intent/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Take the other side' }));
  fireEvent.change(screen.getByLabelText('Your position: the other side'), { target: { value: 'Pad both to 300 ms.' } });
  fireEvent.change(screen.getByLabelText('Evidence, one per line'), { target: { value: 'kj:password-reset#PR3\n\n  OWASP ASVS 2.5.2  ' } });
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Take the other side' }).at(-1)!); });
  expect(posts()).toStrictEqual([{ url: '/api/cases/c1/positions', method: 'POST', body: { claim: 'Pad both to 300 ms.', evidence: ['kj:password-reset#PR3', 'OWASP ASVS 2.5.2'] } }]);
});

test('a person who may rule sustains exactly one position; a party is told someone else rules', async () => {
  const both = caseFile({ positions: [position({}), position({ position: 'p2', actor: 'pat', seeks: 'keep_intent', claim: 'Keep it as written.' })], you: { party: false, can_argue: false, can_rule: true } });
  view(lee, spec({}, [el('PR3', 'Same response.', { cases: [both] })]));
  await screen.findByText('Keep it as written.');
  const rule = () => document.querySelector<HTMLButtonElement>('.casebox button[type=submit]')!;
  expect([rule().textContent, rule().disabled]).toStrictEqual(['Rule', true]);
  fireEvent.click(screen.getByLabelText(/Sustain pat’s: keep the intent/));
  fireEvent.change(screen.getByLabelText('The ruling, as agents will be served it'), { target: { value: 'Pad both responses to the same time.' } });
  expect(screen.getByText(/It keeps the intent/)).toBeTruthy();
  await act(async () => { fireEvent.click(rule()); });
  expect(posts()).toStrictEqual([{ url: '/api/cases/c1/rule', method: 'POST', body: { text: 'Pad both responses to the same time.', verdicts: { p1: 'overruled', p2: 'sustained' } } }]);
  cleanup();

  view(eli, spec({ can_write: false }, [el('PR3', 'Same response.', { cases: [{ ...both, you: { party: true, can_argue: false, can_rule: false } }] })]));
  expect(await screen.findByText(/one person and their agents are one side/)).toBeTruthy();
  expect(document.querySelector('.casebox form')).toBeNull();
});

test('a ruling is precedent beside its element, and a ruled mark settles only with a version that amends it', async () => {
  view(lee, spec({}, [el('PR7', 'A reset signs the user in.', { rulings: [ruling], marks: [ruled], queries: [ruledQuestion] })]));
  expect(await screen.findByText('A reset signs the user in with a new session.')).toBeTruthy();
  expect(screen.getByText(/Changes the intent/)).toBeTruthy();
  expect(screen.getByText(/lee ruled .*directly/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Still holds' })).toBeNull();
  expect(screen.getByText(/It can’t be cleared by hand/)).toBeTruthy();
  expect(screen.getByText('It settles when a version amends the element.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Revise PR7' }));
  expect(screen.getByLabelText('Edit PR7')).toBeTruthy();
});

test('a case file is opened from its element, and a ruling given directly, on it or the whole node', async () => {
  view(lee, spec({}, [el('PR3', 'Same response.')]));
  fireEvent.click(await screen.findByRole('button', { name: 'Dispute' }));
  fireEvent.change(screen.getByLabelText('The question in dispute'), { target: { value: 'Timing too?' } });
  fireEvent.click(screen.getByLabelText('Keep the intent as written'));
  fireEvent.change(screen.getByLabelText('Your claim'), { target: { value: 'It already says the same response.' } });
  expect((screen.getByLabelText('Evidence, one per line') as HTMLTextAreaElement).value).toBe('kj:password-reset@3#PR3');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open case file' })); });
  expect(posts().at(-1)).toStrictEqual({ url: '/api/cases', method: 'POST', body: {
    node: 'password-reset', seq: 3, element: 'PR3', question: 'Timing too?', claim: 'It already says the same response.', evidence: ['kj:password-reset@3#PR3'], seeks: 'keep_intent',
  } });

  fireEvent.click(screen.getByRole('button', { name: 'Rule' }));
  fireEvent.click(screen.getByLabelText(/^Changes the intent/));
  fireEvent.change(screen.getByLabelText('What it says, as agents will be served it'), { target: { value: 'Timing must match too.' } });
  fireEvent.change(screen.getByLabelText(/What it replaces/), { target: { value: 'q3’s answer' } });
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Rule' }).at(-1)!); });
  expect(posts().at(-1)).toStrictEqual({ url: '/api/rulings', method: 'POST', body: {
    node: 'password-reset', seq: 3, element: 'PR3', text: 'Timing must match too.', effect: 'change_intent', replaces: 'q3’s answer',
  } });

  fireEvent.click(screen.getByRole('button', { name: 'Rule on kj:password-reset' }));
  expect(screen.getByRole('form', { name: 'Rule directly on kj:password-reset@3' })).toBeTruthy();
});

test('who may not: an engineer can dispute the spec but not rule on it, and a reader sees no case files', async () => {
  view(eli, spec({ can_write: false }, [el('PR3', 'Same response.')]));
  expect(await screen.findByRole('button', { name: 'Dispute' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Rule' })).toBeNull();
  cleanup();
  view(reader, spec({ can_write: false }, [el('PR3', 'Same response.')]));
  await screen.findByText('Same response.');
  expect(screen.queryByRole('button', { name: 'Dispute' })).toBeNull();
  cleanup();
  replies['/api/cases'] = { cases: [], belongs: false };
  replies['/api/rulings'] = { rulings: [] };
  render(<CasesView me={reader} tick={0} act={runner} go={() => undefined} />);
  expect(await screen.findByText(/only those with Write on a layer of it see them \(D49\)/)).toBeTruthy();
});

test('the cases page lists open case files, the rulings, and settled case files', async () => {
  replies['/api/cases'] = { belongs: true, cases: [caseFile(), caseFile({ case: 'c2', state: 'ruled', ruling: { ...ruling, case: 'c2' }, you: { party: false, can_argue: false, can_rule: false } })] };
  replies['/api/rulings'] = { rulings: [ruling] };
  render(<CasesView me={lee} tick={0} act={runner} go={() => undefined} />);
  expect(await screen.findByRole('heading', { name: 'Open case files' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Settled case files' })).toBeTruthy();
  expect(screen.getAllByText('A reset signs the user in with a new session.')).toHaveLength(2);
  expect(calls.map((c) => c.url)).toStrictEqual(['/api/cases?state=all', '/api/rulings']);
});

test('another kolab\'s node reads in place, read only: no edits, questions, disputes or rulings from here', async () => {
  const q: WebQuery = { ...ruledQuestion, id: 'q1', address: 'kj:checkout/checkout@2#R5', node: 'checkout', seq: 2, element: 'R5', question: 'Retry the receipt?', mark: null, mark_reason: null, raised_by: 'eng-agent' };
  const foreign = spec({ kolab: 'checkout', foreign: true, can_write: false, node: { name: 'checkout', kind: 'spec', layer: 'functional', title: 'Checkout', latest: 2, drafts: 0, in_review: 0 },
    reading: { seq: 2, state: 'committed', author: 'Lee', role: 'product', at, note: null, mine: true } },
  [{ ...el('R5', 'A receipt email is sent within a minute.', { queries: [q] }), address: 'kj:checkout/checkout@2#R5' }]);
  view(lee, foreign, { kolab: 'checkout' });
  expect(await screen.findByText(/Read in place from kolab/)).toBeTruthy();
  expect(calls[0].url).toBe('/api/kolabs/checkout/nodes/checkout');
  expect(screen.getByText('kj:checkout/checkout@2')).toBeTruthy();
  expect(screen.getByText('Retry the receipt?')).toBeTruthy();
  expect(screen.getByText('Open, in its own kolab.')).toBeTruthy();
  for (const name of ['Edit', 'Ask', 'Dispute', 'Rule', 'Answer', 'Add a requirement']) expect(screen.queryByRole('button', { name })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All of checkout' }));
  expect(routes.at(-1)).toBe('read/checkout');
  await waitFor(() => expect(screen.getByTitle('Copy kj:checkout/checkout@2#R5')).toBeTruthy());
});

test('routes and addresses: another kolab is read in place, the session\'s own is its page', () => {
  expect(parseRoute('#/read/checkout/checkout@2#R5')).toStrictEqual({ view: 'node', kolab: 'checkout', name: 'checkout', version: 2, focus: 'checkout#R5' });
  expect(parseRoute('#/read/checkout')).toStrictEqual({ view: 'read', kolab: 'checkout' });
  expect(parseRoute('#/cases')).toStrictEqual({ view: 'cases' });
  expect(parseKj('kj:checkout/checkout@2#R5')).toStrictEqual({ kolab: 'checkout', node: 'checkout', version: 2, element: 'R5' });
  expect(parseKj('kj:password-reset#PR3~q({"exact":"same"})')).toStrictEqual({ node: 'password-reset', element: 'PR3' });
  expect(parseKj('not an address')).toBeUndefined();
  expect(routeOf({ kolab: 'checkout', node: 'checkout', element: 'R5' }, 'accounts')).toBe('read/checkout/checkout#R5');
  expect(routeOf({ kolab: 'accounts', node: 'password-reset', version: 3 }, 'accounts')).toBe('node/password-reset@3');
});
