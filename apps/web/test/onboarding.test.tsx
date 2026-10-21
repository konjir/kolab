// A person's first session with no admin, in the page (W3.4): connecting a harness with one command,
// inviting a teammate with a link shown once, an invite opened from its link, and the routes. Kolab's
// own rules are apps/server/test/onboarding.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { InvitePreview, InviteView, WebMe, WebOverview } from '@konjir/types';
import { ConnectView, GettingStarted, InviteCard, PeopleView, accessWords, inviteLink } from '../src/components/Onboarding.js';
import type { Act } from '../src/components/Marks.js';
import { inviteOf, parseRoute } from '../src/App.js';

const ann: WebMe = { actor: 'ann', name: 'Ann', kind: 'person', owner: null, role: 'product', layer: 'functional', kolab: 'anns', access: { level: 'admin', layers: ['functional', 'technical'] } };
const eli: WebMe = { ...ann, actor: 'eli', name: 'Eli', role: 'engineer', layer: 'technical', access: { level: 'write', layers: ['technical'] } };
const overview = (me: WebMe): WebOverview => ({
  me, kolab: { id: 'anns', title: 'Ann’s', owner: 'ann', visibility: 'private', current: true, access: me.access },
  kolabs: [], nodes: [], counts: { stale: 0, waiting: 0, reviews: 0, open: 0, cases: 0 },
});
const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
const invite = (over: Partial<InviteView> = {}): InviteView => ({
  id: 'inv_aaaaaaaaaaaaaaaa', kolab: 'anns', level: 'write', layers: ['technical'], invited_by: 'ann', created_at: new Date().toISOString(), expires_at: at,
  state: 'open', accepted_by: null, accepted_at: null, ...over,
});
const TOKEN = `kji_${'A'.repeat(43)}`;

let calls: { url: string; method: string; body: unknown }[];
let replies: Record<string, unknown>;
beforeEach(() => {
  calls = [];
  replies = {};
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies[`${method} ${u}`];
    return { ok: true, status: 200, text: async () => JSON.stringify(reply ?? {}) } as unknown as Response;
  }) as typeof fetch;
  Object.assign(navigator, { clipboard: { writeText: jest.fn(async () => undefined) } });
});
afterEach(cleanup);

const said: string[] = [];
const runner: Act = { async run(what, done) { await what(); said.push(done); return true; } };

test('connecting a harness is one command each, naming this Kolab, the kolab and the role', async () => {
  render(<ConnectView me={eli} cli={{ npm: 'konjir@1.2.3' }} origin="https://kolab.example.com" />);
  expect(screen.getByLabelText('Add Kolab to Claude Code').textContent).toBe('claude mcp add --transport http konjir https://kolab.example.com/mcp');
  expect(screen.getByLabelText('Sign the konjir CLI in').textContent).toBe('npx konjir@1.2.3 login --url https://kolab.example.com/mcp --kolab anns --role engineer');
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]); });
  expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('npx konjir@1.2.3 connect opencode --url https://kolab.example.com --kolab anns');
});

test('the page shows konjir connect first: one command per harness, naming this Kolab and the kolab, and the agents it makes (W3.7)', () => {
  render(<ConnectView me={eli} cli={{ npm: 'konjir@1.2.3' }} origin="https://kolab.example.com" />);
  const one = screen.getByRole('region', { name: 'One command: konjir connect' });
  expect(within(one).getByLabelText('Connect OpenCode with konjir connect').textContent).toBe('npx konjir@1.2.3 connect opencode --url https://kolab.example.com --kolab anns');
  // Claude Code's entry is the Konjir channel (W3.8), which runs from a checkout even when the CLI is published; --http is the plain entry.
  expect(within(one).getByLabelText('Connect Claude Code with konjir connect').textContent).toBe('~/kolab/bin/konjir connect claude --url https://kolab.example.com --kolab anns');
  expect(within(one).getByLabelText('Get the Konjir channel from its repository').textContent).toBe('git clone https://github.com/konjir/kolab ~/kolab && (cd ~/kolab && npm ci)');
  expect(within(one).getByLabelText('Start Claude Code with the Konjir channel').textContent).toBe('claude --dangerously-load-development-channels server:konjir-product server:konjir-engineer');
  expect(within(one).getByLabelText('Connect Claude Code over HTTP, with no channel').textContent).toBe('npx konjir@1.2.3 connect claude --url https://kolab.example.com --kolab anns --http');
  expect(one.textContent).toMatch(/one Konjir server with Kolab’s tools, which also pushes your inbox into the session/);
  expect(one.textContent).toMatch(/Channels need Claude Code signed in with a claude.ai account/);
  expect(within(one).getByText(`${eli.actor}-product`)).toBeTruthy();
  expect(one.textContent).toMatch(/then revokes that sign-in and keeps none of it\..*writes no token/);
});

test('until this Kolab names a published, pinned CLI, the page never shows npx: a checkout\'s bin/konjir, and says npm publishing is pending (W3.7)', () => {
  for (const cli of [undefined, { npm: null }]) {
    const { container, unmount } = render(<ConnectView me={eli} cli={cli} origin="https://kolab.example.com" />);
    expect(container.textContent).not.toMatch(/npx/);
    expect(screen.getByText(/The konjir CLI isn’t published on npm yet/)).toBeTruthy();
    expect(screen.getByLabelText('Get the konjir CLI from its repository').textContent).toBe('git clone https://github.com/konjir/kolab ~/kolab && (cd ~/kolab && npm ci)');
    expect(screen.getByLabelText('Connect OpenCode with konjir connect').textContent).toBe('~/kolab/bin/konjir connect opencode --url https://kolab.example.com --kolab anns');
    expect(screen.getByLabelText('Sign the konjir CLI in').textContent).toBe('~/kolab/bin/konjir login --url https://kolab.example.com/mcp --kolab anns --role engineer');
    expect(screen.getByLabelText('Read the instructions with the konjir CLI').textContent).toBe('~/kolab/bin/konjir instructions');
    unmount();
  }
});

test('the MCP route (Claude Code, OpenCode, then konjir_instructions) is apart from the CLI route (konjir login, then konjir instructions)', () => {
  render(<ConnectView me={eli} cli={{ npm: 'konjir@1.2.3' }} origin="https://kolab.example.com" />);
  const mcpRoute = screen.getByRole('region', { name: 'Over MCP: Claude Code, OpenCode' });
  const cliRoute = screen.getByRole('region', { name: 'In a shell: the konjir CLI, for Codex or you' });
  expect(within(mcpRoute).getByLabelText('Add Kolab to Claude Code')).toBeTruthy();
  expect(JSON.parse(within(mcpRoute).getByLabelText('OpenCode\'s opencode.json').textContent!).mcp)
    .toStrictEqual({ konjir: { type: 'remote', url: 'https://kolab.example.com/mcp' } });
  expect(within(mcpRoute).getByText(/Merge this .* into your .*, keeping what is already there/)).toBeTruthy();
  expect(within(mcpRoute).getByLabelText('Sign OpenCode in').textContent).toBe('opencode mcp auth konjir');
  expect(within(mcpRoute).getByText('konjir_instructions')).toBeTruthy();
  expect(within(mcpRoute).queryByText(/konjir login/)).toBeNull();
  expect(within(cliRoute).getByLabelText('Sign the konjir CLI in').textContent).toMatch(/^npx konjir@1.2.3 login /);
  expect(within(cliRoute).getByLabelText('Read the instructions with the konjir CLI').textContent).toBe('npx konjir@1.2.3 instructions');
  expect(within(cliRoute).queryByText('konjir_instructions')).toBeNull();
});

test('an admin makes an invite link, shown once, and revokes an open one; anyone else is told who invites', async () => {
  replies['GET /api/invites'] = { invites: [invite(), invite({ id: 'inv_bbbbbbbbbbbbbbbb', state: 'accepted', accepted_by: 'fay', level: 'read', layers: [] })] };
  replies['POST /api/invites'] = { token: TOKEN, invite: invite({ id: 'inv_cccccccccccccccc' }) };
  replies['GET /api/access'] = { kolab: { id: 'anns', owner: 'ann', owner_kind: 'user', visibility: 'private', base_permission: null }, holders: [], teams: [] };
  render(<PeopleView me={ann} overview={overview(ann)} tick={0} act={runner} />);
  expect(await screen.findByText(/joined by fay/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'write-technical' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make an invite link' })); });
  expect(calls.find((c) => c.method === 'POST')).toStrictEqual({ url: '/api/invites', method: 'POST', body: { level: 'write', layers: ['technical'] } });
  expect(screen.getByLabelText('The invite link').textContent).toBe(`${location.origin}/#/invite/${TOKEN}`);
  expect(screen.getByText(/It is shown only now/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]); });
  expect(calls.filter((c) => c.method === 'POST').at(-1)).toMatchObject({ url: '/api/invites/inv_aaaaaaaaaaaaaaaa/revoke' });
  cleanup();

  render(<PeopleView me={eli} overview={overview(eli)} tick={0} act={runner} />);
  expect(screen.getByText(/Those with Admin in anns invite people to it; you hold Write on the technical layer. Ask its owner, ann./)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Make an invite link' })).toBeNull();
});

test('an invite opened from its link says what it offers; signed in, it joins; signed out, the sign-in offers it', () => {
  const preview: InvitePreview = { kolab: 'anns', title: 'Ann’s', owner: 'ann', level: 'write', layers: ['technical'], invited_by: 'ann', expires_at: at };
  const join = jest.fn();
  render(<InviteCard invite={preview} signedIn onJoin={join} />);
  expect(screen.getByText('ann invites you to Ann’s')).toBeTruthy();
  expect(screen.getByText(/with Write on the technical layer/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Join anns' }));
  expect(join).toHaveBeenCalled();
  cleanup();
  render(<InviteCard invite={preview} signedIn={false} />);
  expect(screen.getByText(/Kolab’s sign-in page offers to join it/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Join anns' })).toBeNull();
});

test('an empty kolab says what to do first; only an admin is offered to invite', () => {
  const go = jest.fn();
  render(<GettingStarted me={ann} go={go} />);
  fireEvent.click(screen.getByRole('button', { name: 'Invite a teammate' }));
  expect(go).toHaveBeenCalledWith('people');
  cleanup();
  render(<GettingStarted me={eli} go={go} />);
  expect(screen.queryByRole('button', { name: 'Invite a teammate' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Connect a harness' }));
  expect(go).toHaveBeenLastCalledWith('connect');
});

test('routes: #/people and #/connect; an invite\'s link carries only a well-formed secret, and is no route', () => {
  expect(parseRoute('#/people')).toStrictEqual({ view: 'people' });
  expect(parseRoute('#/connect')).toStrictEqual({ view: 'connect' });
  expect(inviteOf(`#/invite/${TOKEN}`)).toBe(TOKEN);
  expect(inviteOf('#/invite/kji_short')).toBeUndefined();
  expect(inviteOf(`#/invite/${TOKEN}/x`)).toBeUndefined();
  expect(parseRoute(`#/invite/${TOKEN}`)).toStrictEqual({ view: 'home' });
  expect(inviteLink(TOKEN, 'https://kolab.example.com')).toBe(`https://kolab.example.com/#/invite/${TOKEN}`);
  expect(accessWords({ level: 'maintain', layers: ['functional', 'technical'] })).toBe('Maintain');
});
