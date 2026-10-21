// Who holds access, in the People page (W3.6): an Admin sees each person and agent with their access
// and its sources, changes a direct grant's level or removes it, each only after confirming, and is
// told where access from a team or the organization is changed instead. Kolab's own rules are
// apps/server/test/access.test.ts's and libs/engine/test/access-list.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AccessHolder, KolabAccessView, WebMe, WebOverview } from '@konjir/types';
import { AccessList, PeopleView, levelValue, sourceWords, whereToChange } from '../src/components/Onboarding.js';
import type { Act } from '../src/components/Marks.js';

const olga: WebMe = { actor: 'olga', name: 'Olga', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'shop', access: { level: 'admin', layers: ['functional', 'technical'] } };
const both = ['functional', 'technical'] as const;
const holder = (over: Partial<AccessHolder> & Pick<AccessHolder, 'actor'>): AccessHolder => ({
  kind: 'person', owner: null, access: { level: 'read', layers: [] }, sources: [], grant: null, outside: false, ...over,
});
const view: KolabAccessView = {
  kolab: { id: 'shop', owner: 'acme', owner_kind: 'organization', visibility: 'private', base_permission: null },
  holders: [
    holder({ actor: 'olga', access: { level: 'admin', layers: [...both] }, sources: [{ kind: 'org_owner', level: 'admin', layers: [...both], org: 'acme' }] }),
    holder({ actor: 'fay', access: { level: 'admin', layers: [...both] }, sources: [{ kind: 'grant', level: 'admin', layers: [...both] }], grant: { level: 'admin', layers: [...both] } }),
    holder({ actor: 'ben', access: { level: 'write', layers: ['technical'] }, sources: [{ kind: 'team', level: 'write', layers: ['technical'], team: 'acme/eng' }] }),
    holder({ actor: 'ben-claude', kind: 'agent', owner: 'ben', access: { level: 'read', layers: [] }, sources: [{ kind: 'grant', level: 'write', layers: ['technical'] }],
      grant: { level: 'write', layers: ['technical'] }, cap: { level: 'read', layers: [] }, capped: true }),
    holder({ actor: 'old-bot', kind: 'agent', owner: null, access: { level: null, layers: [] }, sources: [{ kind: 'grant', level: 'read', layers: [] }],
      grant: { level: 'read', layers: [] }, cap: { level: null, layers: [] }, capped: true }),
    holder({ actor: 'otto', sources: [{ kind: 'grant', level: 'read', layers: [] }], grant: { level: 'read', layers: [] }, outside: true }),
  ],
  teams: [{ team: 'acme/eng', level: 'write', layers: ['technical'], members: 3 }],
};

let calls: { url: string; method: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = method === 'GET' && u === '/api/access' ? view : method === 'GET' ? { invites: [] } : { ended: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);

const said: string[] = [];
const runner: Act = { async run(what, done) { await what(); said.push(done); return true; } };
const posts = () => calls.filter((c) => c.method === 'POST');

test('the list shows each holder\'s access and its sources; only a direct grant can be changed, and the rest say where they are changed', async () => {
  render(<AccessList me={olga} tick={0} act={runner} />);
  const ben = await screen.findByRole('listitem', { name: 'ben' });
  expect(within(ben).getByText('team acme/eng: Write on the technical layer')).toBeTruthy();
  expect(within(ben).getByText('Change it in team acme/eng\'s grant or members.')).toBeTruthy();
  expect(within(ben).queryByRole('button', { name: 'Remove access' })).toBeNull();
  const me = screen.getByRole('listitem', { name: 'olga' });
  expect(within(me).getByText('you')).toBeTruthy();
  expect(within(me).getByText('an owner of acme: Admin')).toBeTruthy();
  expect(within(me).queryByRole('combobox')).toBeNull();
  const agent = screen.getByRole('listitem', { name: 'ben-claude' });
  expect(within(agent).getByText('agent of ben, capped at Read by what its owner holds')).toBeTruthy();
  expect((within(agent).getByLabelText('Grant for ben-claude') as HTMLSelectElement).value).toBe('write-technical');
  expect(within(screen.getByRole('listitem', { name: 'old-bot' })).getByText('an agent whose owner holds nothing here')).toBeTruthy();
  expect(within(screen.getByRole('listitem', { name: 'otto' })).getByText('outside collaborator, granted Read')).toBeTruthy();
  const teams = screen.getByRole('list', { name: 'Teams granted access' });
  expect(within(teams).getByText('3 people, its sub-teams\' members included')).toBeTruthy();
  expect(screen.getByText(/through Konjir's admin for now/)).toBeTruthy();
});

test('changing a level asks first, then posts it; cancelling posts nothing', async () => {
  render(<AccessList me={olga} tick={0} act={runner} />);
  const otto = await screen.findByRole('listitem', { name: 'otto' });
  const change = within(otto).getByRole('button', { name: 'Change' }) as HTMLButtonElement;
  expect(change.disabled).toBe(true);   // nothing chosen yet
  fireEvent.change(within(otto).getByLabelText('Grant for otto'), { target: { value: 'write-functional' } });
  expect(change.disabled).toBe(false);
  fireEvent.click(change);
  const ask = screen.getByRole('alertdialog', { name: 'Change otto\'s access?' });
  expect(within(ask).getByText(/From Read to Write on the functional layer\. Their agents hold no more than they do/)).toBeTruthy();
  fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(posts()).toStrictEqual([]);

  fireEvent.click(change);
  await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Change access' })); });
  expect(posts()).toStrictEqual([{ url: '/api/access/otto', method: 'POST', body: { level: 'write', layers: ['functional'] } }]);
  expect(said.at(-1)).toBe('otto\'s access changed');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  // Read again after the change.
  expect(calls.filter((c) => c.url === '/api/access' && c.method === 'GET').length).toBeGreaterThanOrEqual(2);

  fireEvent.change(within(otto).getByLabelText('Grant for otto'), { target: { value: 'maintain' } });
  fireEvent.click(within(otto).getByRole('button', { name: 'Change' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Change access' })); });
  expect(posts().at(-1)).toStrictEqual({ url: '/api/access/otto', method: 'POST', body: { level: 'maintain' } });
});

test('removing access asks first, says what follows, and warns an admin removing their own', async () => {
  render(<AccessList me={{ ...olga, actor: 'fay' }} tick={0} act={runner} />);
  const fay = await screen.findByRole('listitem', { name: 'fay' });
  fireEvent.click(within(fay).getByRole('button', { name: 'Remove access' }));
  const ask = screen.getByRole('alertdialog', { name: 'Remove fay\'s access?' });
  expect(within(ask).getByText(/Their direct grant on shop, Admin, goes\. .*any session, theirs or their agents', that can no longer reach shop ends\. This is your own access: you may lose Admin here\./)).toBeTruthy();
  await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: 'Remove access' })); });
  expect(posts()).toStrictEqual([{ url: '/api/access/fay/remove', method: 'POST', body: {} }]);

  const agent = screen.getByRole('listitem', { name: 'ben-claude' });
  fireEvent.click(within(agent).getByRole('button', { name: 'Remove access' }));
  expect(screen.getByText(/Its sessions end if it can no longer reach shop\./)).toBeTruthy();
  await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove access' })); });
  expect(posts().at(-1)).toMatchObject({ url: '/api/access/ben-claude/remove' });
});

test('the People page shows the list to an Admin, beside the invites; words for every source', async () => {
  const overview: WebOverview = {
    me: olga, kolab: { id: 'shop', title: 'Shop', owner: 'acme', visibility: 'private', current: true, access: olga.access },
    kolabs: [], nodes: [], counts: { stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0 },
  };
  render(<PeopleView me={olga} overview={overview} tick={0} act={runner} />);
  expect(await screen.findByRole('heading', { name: 'Who holds access' })).toBeTruthy();
  expect(await screen.findByRole('listitem', { name: 'fay' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Invites' })).toBeTruthy();

  expect(sourceWords({ kind: 'owner', level: 'admin', layers: [...both] }, 'anns', false)).toBe('owns anns: Admin');
  expect(sourceWords({ kind: 'base', level: 'triage', layers: [], org: 'acme' }, 'shop', false)).toBe('acme\'s base permission: Triage');
  expect(whereToChange({ kind: 'base', level: 'triage', layers: [], org: 'acme' }, 'shop')).toBe('Change it in acme\'s base permission for shop.');
  expect(whereToChange({ kind: 'internal', level: 'read', layers: [], org: 'acme' }, 'shop')).toBe('Change it in acme\'s members, or shop\'s visibility.');
  expect(whereToChange({ kind: 'grant', level: 'read', layers: [] }, 'shop')).toBeUndefined();
  expect(levelValue({ level: 'write', layers: [...both] })).toBe('write');
  expect(levelValue({ level: 'admin', layers: [...both] })).toBe('admin');
});
