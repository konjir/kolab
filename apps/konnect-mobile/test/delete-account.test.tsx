// Delete account, from You (App Store guideline 5.1.1(v); Lee's decision of 2026-11-23): the screen
// says what deleting does, runs only once the person's name is typed, lists the teams Kolab names
// when it refuses, with what works (archive the team, or remove its other members), and once Kolab
// has deleted the account, signs the phone out and forgets its app registration. And wherever
// someone is shown, one whose account is deleted (re-keyed to `deleted-<random>`, or so flagged) is
// "a deleted account", with no profile to open and no one to write to.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { Member } from '@konjir/types';
import type { SecureKV } from '../src/auth/store';

jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
jest.mock('expo-device', () => ({ isDevice: false }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), AndroidImportance: {} }));
jest.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));

/** Kolab, as the app's MCP client sees it: each call recorded, and konjir_delete_my_account answered with `mockAnswer`. */
const mockCalls: { name: string; args: Record<string, unknown> }[] = [];
let mockAnswer: { isError?: boolean; content?: { type: 'text'; text: string }[]; structuredContent?: unknown } = {};
let mockTools = ['konjir_delete_my_account'];
jest.mock('../src/auth/mcp', () => ({
  teamClient: async () => ({
    close: async () => undefined,
    listTools: async () => ({ tools: mockTools.map((name) => ({ name, inputSchema: { properties: {} } })) }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      mockCalls.push({ name, args });
      return name === 'konjir_delete_my_account' ? mockAnswer : { structuredContent: {} };
    },
  }),
}));

/* eslint-disable import/first */
import { AuthProvider } from '../src/auth/AuthProvider';
import DeleteAccount from '../app/delete-account';
import { homeOf } from '../src/kolab/home';
import { forwardText } from '../src/kolab/forward';
import { displayName, isGone, partnerDeleted, senderName } from '../src/kolab/names';
import { opensTo } from '../src/kolab/unread';
import { at } from '../src/kolab/your-agents';
/* eslint-enable import/first */

const NS = 'konnect.kolab.konjir.com_mcp';
let kept: Map<string, string>;
const kv = (): SecureKV => ({ get: async (k) => kept.get(k) ?? null, set: async (k, v) => { kept.set(k, v); }, remove: async (k) => { kept.delete(k); } });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
const BLOCKED = {
  isError: true,
  content: [{ type: 'text' as const, text: 'TenancyError: your account can\'t be deleted yet: kolab hub is yours and has 2 other members: archive it (konjir_archive_kolab), which you can do with them in it, or remove them (konjir_remove_member); kolab code is yours and has a repository registered to it, which is never removed: archive it (konjir_archive_kolab), which keeps it. Deal with each first, then delete your account again.' }],
  structuredContent: { blocked: [
    { name: 'hub', kind: 'kolab', reason: 'members', why: 'kolab hub is yours and has 2 other members: archive it (konjir_archive_kolab), which you can do with them in it, or remove them (konjir_remove_member)' },
    { name: 'code', kind: 'kolab', reason: 'repository', why: 'kolab code is yours and has a repository registered to it, which is never removed: archive it (konjir_archive_kolab), which keeps it' },
  ] },
};
const GONE = 'deleted-0123456789ab';
const DELETED = { structuredContent: { deleted: 'ann', left: [], erased: ['solo'], agents: 1, revoked: 1, ended: 1, devices: 1 } };

// Whole screens render slowly on a busy runner; past Jest's 5 s a timed-out test's work runs on into the next.
jest.setTimeout(30_000);

let realFetch: typeof fetch;
beforeEach(() => {
  kept = new Map([
    [`${NS}.login`, JSON.stringify({ actor: 'ann', team: 'hub', role: 'product', url: 'https://kolab.konjir.com/mcp', clientId: 'kjcl_x', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 600_000 })],
    [`${NS}.client`, JSON.stringify({ id: 'kjcl_x', redirect: 'https://www.konjir.com/konnect/app/oauth' })],
  ]);
  mockCalls.length = 0;
  mockAnswer = DELETED;
  mockTools = ['konjir_delete_my_account'];
  // Kolab can't be reached for anything else: the revoke that signing out sends goes nowhere.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
});
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; });

describe('Delete account', () => {
  test('it says what deleting does, and runs nothing until the person types their own name', async () => {
    await render(<AuthProvider kv={kv()}><DeleteAccount /></AuthProvider>);
    await settle();
    expect(screen.getByText(/You leave every team you are in/)).toBeTruthy();
    expect(screen.getByText(/shown as from "a deleted account"/)).toBeTruthy();
    expect(screen.getByText(/an id that says nothing about you/)).toBeTruthy();
    expect(screen.getByText(/Kolab keeps a one-way digest of it, not the name itself; but anyone who guesses your username could check it/)).toBeTruthy();
    expect(screen.getByText(/What others wrote stays as they wrote it, even where it names you/)).toBeTruthy();
    expect(screen.getByText(/must be archived first, or its other members removed/)).toBeTruthy();
    expect(screen.queryByText(/handed over/)).toBeNull();
    expect(screen.getByText('Type your name, ann, to confirm.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await fireEvent.changeText(screen.getByTestId('confirm-account'), 'bo');
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await settle();
    expect(screen.getByText('Type ann to delete your account.')).toBeTruthy();
    expect(mockCalls.filter((c) => c.name === 'konjir_delete_my_account')).toEqual([]);
    expect(kept.has(`${NS}.login`)).toBe(true);
  });

  test('refused, it lists each team Kolab names, and the phone stays signed in', async () => {
    mockAnswer = BLOCKED;
    await render(<AuthProvider kv={kv()}><DeleteAccount /></AuthProvider>);
    await settle();
    await fireEvent.changeText(screen.getByTestId('confirm-account'), ' @ann ');
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await settle();
    expect(mockCalls.filter((c) => c.name === 'konjir_delete_my_account').map((c) => c.args)).toEqual([{ account: 'ann' }]);
    expect(screen.getByTestId('blocker-hub')).toBeTruthy();
    expect(screen.getByTestId('blocker-code')).toBeTruthy();
    // What to do is what works: archive it, or remove its other members; never "hand it over".
    expect(screen.getByText(/^Kolab won't delete your account yet\. Archive each team below \(its team menu: Archive\), which you can do with its members still in it, or remove its other members; then try again\./)).toBeTruthy();
    expect(screen.getByText('Kolab hub is yours and has 2 other members: archive it (konjir_archive_kolab), which you can do with them in it, or remove them (konjir_remove_member).')).toBeTruthy();
    expect(screen.getByText('Has other members')).toBeTruthy();
    expect(screen.getByText('Has a repository')).toBeTruthy();
    expect(screen.queryByText(/hand it over/)).toBeNull();
    expect(kept.has(`${NS}.login`)).toBe(true);
  });

  test('deleted, the phone is signed out, as Sign out does, and forgets its app registration', async () => {
    await render(<AuthProvider kv={kv()}><DeleteAccount /></AuthProvider>);
    await settle();
    await fireEvent.changeText(screen.getByTestId('confirm-account'), 'ann');
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await settle();
    expect(mockCalls.filter((c) => c.name === 'konjir_delete_my_account').map((c) => c.args)).toEqual([{ account: 'ann' }]);
    expect(kept.has(`${NS}.login`)).toBe(false);
    expect(kept.has(`${NS}.client`)).toBe(false);
  });

  test('a Kolab without the tool says so, and nothing changes', async () => {
    mockTools = [];
    await render(<AuthProvider kv={kv()}><DeleteAccount /></AuthProvider>);
    await settle();
    await fireEvent.changeText(screen.getByTestId('confirm-account'), 'ann');
    await fireEvent.press(screen.getByTestId('delete-account-confirm'));
    await settle();
    expect(screen.getByText(/This Kolab can't delete accounts yet/)).toBeTruthy();
    expect(kept.has(`${NS}.login`)).toBe(true);
  });
});

describe('a deleted account, wherever a sender is shown', () => {
  const members: Member[] = [{ actor: 'ann', kind: 'person', owner: null, login: 'ann', github_id: '1', here: true, you: true }];
  test('a message from one is from "a deleted account", by its re-keyed id or Kolab\'s flag; anyone else\'s, as before', () => {
    expect(senderName({ from: GONE }, members)).toBe('a deleted account');
    expect(senderName({ from: `${GONE}-1` }, members)).toBe('a deleted account');
    expect(senderName({ from: 'bo', from_deleted: true }, members)).toBe('a deleted account');
    expect(senderName({ from: 'ann' }, members)).toBe('ann');
    expect(senderName({ from: 'cy' }, members)).toBe('cy');
    // Its id is never shown, wherever the app names someone: as a name, or as an @handle.
    expect(displayName(GONE, members)).toBe('a deleted account');
    expect(at(`${GONE}-1`, members)).toBe('a deleted account');
    expect(at('ann', members)).toBe('@ann');
    expect([isGone(GONE), isGone('bo', true), isGone('bo')]).toEqual([true, true, false]);
  });

  test('forwarded, it is "Forwarded from a deleted account"', () => {
    expect(forwardText('', { from: displayName(GONE, members), where: 'in #general', message: 'bye' })).toBe('> Forwarded from a deleted account, in #general:\n> bye');
  });

  test('in Activity, a mention from one opens its channel, but a direct message from one opens nothing', () => {
    expect(opensTo({ id: 'c1', channel: 'general', from: GONE, message: '@ann hi', mentions_you: true })).toEqual({ kind: 'channel', name: 'general' });
    expect(opensTo({ id: 'm1', from: GONE, message: 'hi', reply_to: 'm0' })).toBeUndefined();
    expect(opensTo({ id: 'm2', from: 'bo', message: 'hi', reply_to: 'm0', from_deleted: true })).toBeUndefined();
    expect(opensTo({ id: 'm3', from: 'cy', message: 'hi', reply_to: 'm0' })).toEqual({ kind: 'dm', name: 'cy' });
  });

  test('a DM with one is named so, from whichever end of its newest message they are, on Home too', () => {
    expect(partnerDeleted({ with: 'bo', last: { from: 'bo', from_deleted: true } })).toBe(true);
    expect(partnerDeleted({ with: 'bo', last: { from: 'ann', to_deleted: true } })).toBe(true);
    expect(partnerDeleted({ with: 'bo', last: { from: 'ann' } })).toBe(false);
    expect(partnerDeleted({ with: 'bo' })).toBe(false);
    const home = homeOf({
      me: 'ann', channels: [], members, showUnreads: false, unread: { dms: new Map(), channels: new Map() },
      conversations: [
        { with: 'bo', last_at: '2026-11-23T10:00:00Z', last: { id: 'm1', from: 'ann', to: 'bo', message: 'hi', reply_to: null, sent_at: '2026-11-23T10:00:00Z', read_at: null, to_deleted: true } },
        { with: 'cy', last_at: '2026-11-23T09:00:00Z', last: { id: 'm2', from: 'cy', to: 'ann', message: 'yo', reply_to: null, sent_at: '2026-11-23T09:00:00Z', read_at: null } },
      ],
    });
    expect(home.dms.map((d) => [d.with, d.deleted ?? false])).toEqual([['bo', true], ['cy', false]]);
    // A DM Kolab hasn't listed yet, with unread only, is marked too.
    const unreadOnly = homeOf({
      me: 'ann', channels: [], members, showUnreads: false, conversations: [],
      unread: { dms: new Map([[GONE, { count: 1, mentions: 1 }], ['cy', { count: 1, mentions: 1 }]]), channels: new Map() },
    });
    expect(unreadOnly.dms.map((d) => [d.with, d.deleted ?? false])).toEqual([[GONE, true], ['cy', false]]);
  });
});
