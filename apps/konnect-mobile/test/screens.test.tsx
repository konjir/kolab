import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { SecureKV } from '../src/auth/store';

// The phone's kv-store, as a Map.
const mockKept = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    // The team's cached prefs come back late, after Kolab's answer, as they may on a busy phone.
    getItem: async (k: string) => { if (k.startsWith('konnect.notify.')) await new Promise((r) => setTimeout(r, 50)); return mockKept.get(k) ?? null; },
    setItem: async (k: string, v: string) => { mockKept.set(k, v); },
    removeItem: async (k: string) => { mockKept.delete(k); },
  },
}));
jest.mock('expo-device', () => ({ isDevice: false }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), AndroidImportance: {} }));
// The screens are rendered alone: no navigator, only what they ask of expo-router.
const mockRedirects: unknown[] = [];
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  Redirect: ({ href }: { href: unknown }) => { mockRedirects.push(href); return null; },
}));

/** Kolab, as the app's MCP client sees it: each tool call recorded, and answered as hub's would be. */
const mockCalls: { name: string; args: Record<string, unknown> }[] = [];
let mockPrefs: { kolab: string; level: string; muted_channels: string[]; hide_preview: boolean; agents: Record<string, string> };
jest.mock('../src/auth/mcp', () => ({
  teamClient: async () => ({
    close: async () => undefined,
    listTools: async () => ({ tools: ['konjir_register_push_device', 'konjir_list_my_agents_status', 'konjir_agent_activity', 'konjir_list_agent_conversations'].map((name) => ({ name, inputSchema: { properties: {} } })) }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      mockCalls.push({ name, args });
      const ok = (structuredContent: unknown) => ({ structuredContent });
      switch (name) {
        case 'konjir_list_members': return ok({ members: [
          { actor: 'ann', kind: 'person', owner: null, here: true, you: true },
          { actor: 'ann-helper', kind: 'agent', owner: 'ann', label: 'helper', here: false, owner_reads: true },
          { actor: 'bo', kind: 'person', owner: null, here: true },
          { actor: 'bo-builder', kind: 'agent', owner: 'bo', label: 'builder', here: false, owner_reads: true },
        ] });
        case 'konjir_list_channels': return ok({ channels: [] });
        case 'konjir_get_notification_prefs': return ok(mockPrefs);
        case 'konjir_set_notification_prefs': {
          mockPrefs = { ...mockPrefs, level: args.level as string, agents: { ...mockPrefs.agents, ...(args.agents as Record<string, string> | undefined) } };
          return ok(mockPrefs);
        }
        default: return ok({ agents: [], items: [], conversations: [] });
      }
    },
  }),
}));

/* eslint-disable import/first */
import { AuthProvider } from '../src/auth/AuthProvider';
import NotificationSettings from '../app/notifications';
import YourAgent from '../app/agent/[actor]';
/* eslint-enable import/first */

const NS = 'konnect.kolab.konjir.com_mcp';
const signedIn = (): SecureKV => {
  const m = new Map<string, string>([[`${NS}.login`, JSON.stringify({ actor: 'ann', team: 'hub', role: 'product', url: 'https://kolab.konjir.com/mcp', clientId: 'kjcl_x', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 600_000 })]]);
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } };
};
let qc: QueryClient | undefined;
const app = (children: ReactNode) => (
  <QueryClientProvider client={(qc = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'always', gcTime: Infinity } } }))}>
    <AuthProvider kv={signedIn()}>{children}</AuthProvider>
  </QueryClientProvider>
);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

// Whole screens render slowly on a busy CI runner; past Jest's 5 s a timed-out test's work runs on into the next.
jest.setTimeout(30_000);

afterEach(async () => { await cleanup(); qc?.clear(); });
beforeEach(() => {
  mockKept.clear();
  mockCalls.length = 0;
  mockRedirects.length = 0;
  mockParams = {};
  mockPrefs = { kolab: 'hub', level: 'all', muted_channels: [], hide_preview: false, agents: { 'ann-helper': 'stuck' } };
});

describe('Notifications', () => {
  test('what the phone kept never replaces Kolab\'s answer, even when it comes back later', async () => {
    // A stale copy on the phone says none; Kolab says all.
    mockKept.set('konnect.notify.hub', JSON.stringify({ level: 'none', muted: [], hidePreview: false, agents: {} }));
    await render(app(<NotificationSettings />));
    await settle();
    expect(mockCalls.some((c) => c.name === 'konjir_get_notification_prefs')).toBe(true);
    // The next save starts from Kolab's prefs, not the phone's.
    await fireEvent.press(screen.getByTestId('hide-preview'));
    await settle();
    expect(mockCalls.filter((c) => c.name === 'konjir_set_notification_prefs').at(-1)?.args).toMatchObject({ level: 'all', hide_preview: true });
  });

  test('changing one agent sends that agent alone, so one since removed never fails the save', async () => {
    mockPrefs.agents = { 'ann-helper': 'stuck', 'ann-gone': 'never' };
    await render(app(<NotificationSettings />));
    await settle();
    await fireEvent.press(screen.getByTestId('agent-notify-ann-helper-all'));
    await settle();
    const set = mockCalls.filter((c) => c.name === 'konjir_set_notification_prefs');
    expect(set).toHaveLength(1);
    expect(set[0]!.args.agents).toEqual({ 'ann-helper': 'all' });
    // A change that isn't an agent's sends no agents at all.
    await fireEvent.press(screen.getByTestId('hide-preview'));
    await settle();
    expect(mockCalls.filter((c) => c.name === 'konjir_set_notification_prefs').at(-1)?.args).not.toHaveProperty('agents');
  });

  test('settings an earlier build kept on the phone move to Kolab once, for the team shown, then leave the phone', async () => {
    mockKept.set('konnect.agent-notify.hub', JSON.stringify({ 'ann-helper': 'all', 'ann-gone': 'never' }));
    await render(app(<NotificationSettings />));
    await settle();
    const set = mockCalls.filter((c) => c.name === 'konjir_set_notification_prefs');
    expect(set).toHaveLength(1);
    expect(set[0]!.args.agents).toEqual({ 'ann-helper': 'all' });
    expect(mockPrefs.agents['ann-helper']).toBe('all');
    expect(mockKept.has('konnect.agent-notify.hub')).toBe(false);
  });
});

describe('the agent screen', () => {
  test('someone else\'s agent goes to its profile, and Kolab\'s owner tools are never asked about it', async () => {
    mockParams = { actor: 'bo-builder' };
    await render(app(<YourAgent />));
    await settle();
    expect(mockRedirects).toContainEqual({ pathname: '/profile/[actor]', params: { actor: 'bo-builder' } });
    expect(mockCalls.filter((c) => ['konjir_agent_activity', 'konjir_list_agent_conversations'].includes(c.name))).toEqual([]);
  });

  test('your own agent\'s are asked once the members list says it is yours', async () => {
    mockParams = { actor: 'ann-helper' };
    await render(app(<YourAgent />));
    await settle();
    expect(mockRedirects).toEqual([]);
    expect(mockCalls.find((c) => c.name === 'konjir_agent_activity')?.args).toMatchObject({ agent: 'ann-helper' });
  });
});
