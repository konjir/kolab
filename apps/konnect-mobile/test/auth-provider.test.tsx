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
/** How many times Kolab was asked to switch, by any client. */
let mockSwitches = 0;
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
const kept = (over: Record<string, unknown> = {}) => JSON.stringify({ actor: 'ann', team: 'hub', role: 'product', url: 'https://kolab.konjir.com/mcp', clientId: 'kjcl_x', accessToken: 'a-hub', refreshToken: 'r-0', expiresAt: Date.now() + 600_000, ...over });
const kv = (m = new Map<string, string>([[`${NS}.login`, kept()]])): SecureKV => (
  { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } });
const adapter = { switchTo: async (_c: unknown, kolab: string) => ({ kolab, role: 'engineer' }) } as unknown as TeamsAdapter;

let realFetch: typeof fetch;
/** Whether Kolab's token endpoint answers (else the phone has no connection to it). */
let tokenOnline = true;
/** The team the grant is in at Kolab, which a refresh's scope names. */
let grantTeam = 'side';
beforeEach(() => {
  mockClients.length = 0;
  tokenOnline = true;
  grantTeam = 'side';
  realFetch = globalThis.fetch;
  const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/.well-known/')) return reply({ authorization_endpoint: 'https://kolab.konjir.com/oauth/authorize', token_endpoint: 'https://kolab.konjir.com/oauth/token', registration_endpoint: 'https://kolab.konjir.com/oauth/register' });
    if (!tokenOnline) throw new TypeError('Network request failed');
    return reply({ access_token: `a-${grantTeam}`, refresh_token: 'r-1', expires_in: 900, scope: `konjir kolab:${grantTeam} role:engineer` });
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

  test('a push tap after the phone sat idle: stale token, network down at the switch, network back; the app stays in its team and keeps working', async () => {
    let latest: Auth | undefined;
    const Probe = () => { latest = useAuth(); return null; };
    const counting = { switchTo: async (_c: unknown, kolab: string) => { mockSwitches++; return { kolab, role: 'engineer' }; } } as unknown as TeamsAdapter;
    mockSwitches = 0;
    grantTeam = 'hub';
    const m = new Map<string, string>([[`${NS}.login`, kept({ expiresAt: 0 })]]);
    await render(<AuthProvider kv={kv(m)} adapter={counting}><Probe /></AuthProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    tokenOnline = false;
    let said = '';
    await act(async () => { await latest!.switchTeam('side').catch((e: Error) => { said = e.message; }); });
    expect(said).toMatch(/can't be reached/);
    tokenOnline = true;
    await act(async () => { await new Promise((r) => setTimeout(r, 1_500)); });
    expect(mockSwitches).toBe(0);
    expect(latest?.current?.team).toBe('hub');
    expect(JSON.parse(m.get(`${NS}.login`)!).team).toBe('hub');
    // Requests for the team shown work: no TeamChanged.
    const c = await latest!.client('hub') as unknown as { tokens: { token(): Promise<string> } };
    expect(await c.tokens.token()).toBe('a-hub');
    await act(async () => { await latest!.signOut(); });
  });

  test('a kept sign-in that moved without the app being told: the first refused request shows the kept team again', async () => {
    let latest: Auth | undefined;
    const Probe = () => { latest = useAuth(); return null; };
    const m = new Map<string, string>([[`${NS}.login`, kept()]]);
    await render(<AuthProvider kv={kv(m)} adapter={adapter}><Probe /></AuthProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const c = await latest!.client('hub') as unknown as { tokens: { token(): Promise<string> } };
    // The kept login names side now (a switch that landed late, say).
    m.set(`${NS}.login`, kept({ team: 'side', role: 'engineer' }));
    await act(async () => { await expect(c.tokens.token()).rejects.toBeInstanceOf(TeamChanged); await new Promise((r) => setTimeout(r, 10)); });
    expect(latest?.current?.team).toBe('side');
  });
});
