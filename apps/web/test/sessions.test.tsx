// Your sessions (W6.1, D103): a person sees their open sessions, one on each machine they sign in
// through, with where and when each was last used, this browser's marked; revoking one, once
// confirmed, ends it. Kolab's own rules are libs/engine/test/machine-sessions.test.ts's.
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { OwnSession, WebSessionsView } from '@konjir/types';
import { SessionsView } from '../src/components/Onboarding.js';
import type { Act } from '../src/components/Marks.js';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const session = (over: Partial<OwnSession> & Pick<OwnSession, 'session' | 'where'>): OwnSession => ({
  current: false, via: 'app', kolab: 'shop', role: 'product', started_at: at(180), last_used: at(5), expires_at: null, ...over,
});
const view: WebSessionsView = {
  sessions: [
    session({ session: 'WEBaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', where: 'Kolab\'s web page, Firefox on macOS', via: 'web', current: true, last_used: at(0) }),
    session({ session: 'CLIbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', where: 'konjir CLI', role: 'engineer' }),
    session({ session: 'TOKccccccccccccccccccccccccccccccccccccccc', where: 'a token an admin opened', via: 'token', expires_at: new Date(Date.now() + 86_400_000).toISOString() }),
  ],
};

let calls: { url: string; method: string }[];
beforeEach(() => {
  calls = [];
  globalThis.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? 'GET';
    calls.push({ url: u, method });
    const reply = method === 'GET' ? view : { ended: 'CLIbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', current: false };
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) } as unknown as Response;
  }) as typeof fetch;
});
afterEach(cleanup);

const said: string[] = [];
const runner: Act = { async run(what, done) { await what(); said.push(done); return true; } };

test('the page lists each session with where and when it was last used, this browser\'s marked and not revocable here', async () => {
  render(<SessionsView tick={0} act={runner} />);
  const web = await screen.findByRole('listitem', { name: 'Kolab\'s web page, Firefox on macOS, WEBaaaaa' });
  expect(within(web).getByText('this browser')).toBeTruthy();
  expect(within(web).queryByRole('button', { name: 'Revoke' })).toBeNull();
  const cli = screen.getByRole('listitem', { name: 'konjir CLI, CLIbbbbb' });
  expect(cli.textContent).toContain('shop as engineer · last used 5 min ago · opened 3 h ago');
  expect(within(cli).getByText('app')).toBeTruthy();
  const token = screen.getByRole('listitem', { name: 'a token an admin opened, TOKccccc' });
  expect(token.textContent).toContain('expires');
  expect(screen.getAllByRole('listitem').length).toBe(3);
});

test('revoking one asks first, then ends it, and the list is read again', async () => {
  render(<SessionsView tick={0} act={runner} />);
  const cli = await screen.findByRole('listitem', { name: 'konjir CLI, CLIbbbbb' });
  fireEvent.click(within(cli).getByRole('button', { name: 'Revoke' }));
  const ask = screen.getByRole('alertdialog');
  expect(within(ask).getByText('Revoke konjir CLI?')).toBeTruthy();
  // Keeping it posts nothing.
  fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
  expect(calls.filter((c) => c.method === 'POST')).toStrictEqual([]);
  fireEvent.click(within(cli).getByRole('button', { name: 'Revoke' }));
  const reads = calls.filter((c) => c.method === 'GET').length;
  await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' })); });
  expect(calls.filter((c) => c.method === 'POST')).toStrictEqual([{ url: '/api/sessions/CLIbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/revoke', method: 'POST' }]);
  expect(said.at(-1)).toBe('Revoked: konjir CLI is signed out');
  expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(reads);
});
