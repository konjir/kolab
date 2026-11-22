import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import type { Auth } from '../src/auth/AuthProvider';
import type { SecureKV } from '../src/auth/store';
import type { TeamsAdapter } from '../src/kolab/teams';

jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
jest.mock('expo-device', () => ({ isDevice: false }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), AndroidImportance: {} }));
// Each MCP client the provider makes, by the team its token is bound to, and whether it was closed.
const mockClients: { team: string; closed: boolean }[] = [];
jest.mock('../src/auth/mcp', () => ({
  teamClient: async (_url: string, tokens: { token(): Promise<string> }) => {
    const entry = { team: '', closed: false };
    mockClients.push(entry);
    return { entry, tokens, close: async () => { entry.closed = true; } };
  },
}));

// eslint-disable-next-line import/first
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
// eslint-disable-next-line import/first
import { TeamChanged } from '../src/auth/tokens';

const NS = 'konnect.kolab.konjir.com_mcp';
const kv = (): SecureKV => {
  const m = new Map<string, string>([[`${NS}.login`, JSON.stringify({ actor: 'ann', team: 'hub', role: 'product', url: 'https://kolab.konjir.com/mcp', clientId: 'kjcl_x', accessToken: 'a-hub', refreshToken: 'r-0', expiresAt: Date.now() + 600_000 })]]);
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } };
};
const adapter = { switchTo: async (_c: unknown, kolab: string) => ({ kolab, role: 'engineer' }) } as unknown as TeamsAdapter;

let realFetch: typeof fetch;
/** Whether Kolab's token endpoint answers (else the phone has no connection to it). */
let tokenOnline = true;
beforeEach(() => {
  mockClients.length = 0;
  tokenOnline = true;
  realFetch = globalThis.fetch;
  const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/.well-known/')) return reply({ authorization_endpoint: 'https://kolab.konjir.com/oauth/authorize', token_endpoint: 'https://kolab.konjir.com/oauth/token', registration_endpoint: 'https://kolab.konjir.com/oauth/register' });
    if (!tokenOnline) throw new TypeError('Network request failed');
    return reply({ access_token: 'a-side', refresh_token: 'r-1', expires_in: 900, scope: 'konjir kolab:side role:engineer' });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('the MCP client a screen gets', () => {
  test('after a switch, one asked for the old team is refused with TeamChanged, and the new team\'s client is left open', async () => {
    let latest: Auth | undefined;
    const Probe = () => { latest = useAuth(); return null; };
    await render(<AuthProvider kv={kv()} adapter={adapter}><Probe /></AuthProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(latest?.current?.team).toBe('hub');
    const before = latest!;
    await before.client('hub');

    await act(async () => { await before.switchTeam('side'); });
    expect(latest?.current?.team).toBe('side');
    const sideClient = await latest!.client('side');
    const open = mockClients.filter((c) => !c.closed).length;

    // A timer or request from before the switch, holding the old render's auth.
    await expect(before.client('hub')).rejects.toBeInstanceOf(TeamChanged);
    expect(mockClients.filter((c) => !c.closed)).toHaveLength(open);
    // Asked for no team in particular, even the old render's auth gets the team the sign-in is in now.
    expect(await before.client()).toBe(sideClient);
    expect(await latest!.client('side')).toBe(sideClient);
  });

  test('a switch Kolab made, whose new token can\'t be fetched yet, is done: the team moves, so a notification waiting for it opens', async () => {
    let latest: Auth | undefined;
    const Probe = () => { latest = useAuth(); return null; };
    await render(<AuthProvider kv={kv()} adapter={adapter}><Probe /></AuthProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    tokenOnline = false;
    await act(async () => { await latest!.switchTeam('side'); });
    expect(latest?.current?.team).toBe('side');
    await act(async () => { await latest!.signOut(); });
  });

  test('a switch Kolab refused fails, and says why: the team stays', async () => {
    let latest: Auth | undefined;
    const Probe = () => { latest = useAuth(); return null; };
    const refusing = { switchTo: async () => { throw new Error('not a member of side'); } } as unknown as TeamsAdapter;
    await render(<AuthProvider kv={kv()} adapter={refusing}><Probe /></AuthProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    let said = '';
    await act(async () => { await latest!.switchTeam('side').catch((e: Error) => { said = e.message; }); });
    expect(said).toContain('not a member of side');
    expect(latest?.current?.team).toBe('hub');
  });
});
