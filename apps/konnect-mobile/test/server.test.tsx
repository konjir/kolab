import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import type { Auth } from '../src/auth/AuthProvider';
import type { SecureKV } from '../src/auth/store';

const mockKv = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItem: async (k: string) => mockKv.get(k) ?? null, setItem: async (k: string, v: string) => { mockKv.set(k, v); }, removeItem: async (k: string) => { mockKv.delete(k); } } }));
jest.mock('expo-device', () => ({ isDevice: false }));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), AndroidImportance: {} }));

// eslint-disable-next-line import/first
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
// eslint-disable-next-line import/first
import { BadServer, serverName, serverUrl } from '../src/server';

describe('the address a person types for a Kolab server', () => {
  test('a host, an https origin or a whole MCP URL each mean that Kolab\'s MCP URL', () => {
    expect(serverUrl('kolab.example.com', 'production')).toBe('https://kolab.example.com/mcp');
    expect(serverUrl('  https://Kolab.Example.com/  ', 'production')).toBe('https://kolab.example.com/mcp');
    expect(serverUrl('https://kolab.example.com/mcp/', 'production')).toBe('https://kolab.example.com/mcp');
    expect(serverUrl('https://kolab.example.com:443', 'production')).toBe('https://kolab.example.com/mcp');
  });

  test('a path or a port a Kolab is never served at is refused, not kept for a sign-in that can\'t work', () => {
    expect(() => serverUrl('https://example.com/kolab/mcp', 'production')).toThrow(/always at \/mcp/);
    expect(() => serverUrl('kolab.konjir.com/app', 'production')).toThrow(BadServer);
    expect(() => serverUrl('https://kolab.example.com:8443', 'production')).toThrow(/port/);
  });

  test('only https, but a development build may reach this machine over http, on any port', () => {
    expect(() => serverUrl('http://kolab.example.com', 'production')).toThrow(BadServer);
    expect(() => serverUrl('http://127.0.0.1:7432/mcp', 'production')).toThrow(BadServer);
    expect(() => serverUrl('http://kolab.example.com', 'development')).toThrow(BadServer);
    expect(() => serverUrl('http://192.168.1.20:7432', 'development')).toThrow(BadServer);
    expect(serverUrl('http://127.0.0.1:7432/mcp', 'development')).toBe('http://127.0.0.1:7432/mcp');
    expect(serverUrl('http://localhost:7432', 'development')).toBe('http://localhost:7432/mcp');
    expect(() => serverUrl('ftp://kolab.example.com', 'development')).toThrow(BadServer);
  });

  test('nothing, a bare word, credentials, a query or a fragment is refused', () => {
    for (const t of ['', '   ', 'kolab', 'https://ann:pw@kolab.example.com', 'https://kolab.example.com/mcp?x=1', 'https://kolab.example.com/#a', 'https://']) {
      expect(() => serverUrl(t, 'production')).toThrow(BadServer);
    }
  });

  test('its name shows the host, and the path only when it isn\'t /mcp', () => {
    expect(serverName('https://kolab.konjir.com/mcp')).toBe('kolab.konjir.com');
    expect(serverName('http://127.0.0.1:7432/mcp')).toBe('127.0.0.1:7432');
  });
});

describe('choosing the server', () => {
  const NS = (host: string) => `konnect.${host}_mcp`;
  const login = (url: string, team = 'hub') => JSON.stringify({ actor: 'ann', team, role: 'product', url, clientId: 'kjcl_x', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 600_000 });
  const kv = (m: Map<string, string>): SecureKV => ({ get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } });
  let realFetch: typeof fetch;
  let asked: string[];
  beforeEach(() => {
    mockKv.clear();
    asked = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      if (String(url).startsWith('https://down.example.com')) throw new TypeError('Network request failed');
      const o = new URL(String(url)).origin;
      if (String(url).startsWith('https://slow.example.com')) await new Promise((r) => setTimeout(r, 50));
      return { ok: true, status: 200, json: async () => ({ issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register` }) } as unknown as Response;
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  const mount = async (store: Map<string, string>) => {
    const seen: { auth?: Auth } = {};
    const Probe = () => { seen.auth = useAuth(); return null; };
    await render(<AuthProvider kv={kv(store)}><Probe /></AuthProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    return seen;
  };

  test('signed out, a server where a Kolab answers is kept, and that server\'s own sign-in is read', async () => {
    const store = new Map([[`${NS('kolab.example.com')}.login`, login('https://kolab.example.com/mcp', 'ours')]]);
    const seen = await mount(store);
    expect(seen.auth?.url).toBe('https://kolab.konjir.com/mcp');
    expect(seen.auth?.server.isDefault).toBe(true);
    expect(seen.auth?.current).toBeUndefined();
    await act(async () => { await seen.auth!.server.use('kolab.example.com'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(asked).toContain('https://kolab.example.com/.well-known/oauth-authorization-server');
    expect(seen.auth?.url).toBe('https://kolab.example.com/mcp');
    expect(seen.auth?.server.isDefault).toBe(false);
    expect(seen.auth?.current?.team).toBe('ours');
    expect(mockKv.get('konnect.server')).toBe('https://kolab.example.com/mcp');
  });

  test('a server kept on the phone is the one the app starts with; Konjir\'s again forgets the choice', async () => {
    mockKv.set('konnect.server', 'https://kolab.example.com/mcp');
    const seen = await mount(new Map());
    expect(seen.auth?.url).toBe('https://kolab.example.com/mcp');
    await act(async () => { await seen.auth!.server.use(null); });
    expect(seen.auth?.url).toBe('https://kolab.konjir.com/mcp');
    expect(mockKv.has('konnect.server')).toBe(false);
  });

  test('a server where no Kolab answers isn\'t kept', async () => {
    const seen = await mount(new Map());
    await expect(seen.auth!.server.use('down.example.com')).rejects.toThrow(/No Kolab answered at down\.example\.com/);
    expect(seen.auth?.url).toBe('https://kolab.konjir.com/mcp');
    expect(mockKv.has('konnect.server')).toBe(false);
  });

  test('signed in, the server can\'t be changed', async () => {
    const seen = await mount(new Map([[`${NS('kolab.konjir.com')}.login`, login('https://kolab.konjir.com/mcp')]]));
    expect(seen.auth?.current?.team).toBe('hub');
    await expect(seen.auth!.server.use('kolab.example.com')).rejects.toThrow(/Sign out before/);
    expect(seen.auth?.url).toBe('https://kolab.konjir.com/mcp');
  });

  test('a second change while one is being checked is refused, so the last one pressed isn\'t lost to a slower check', async () => {
    const seen = await mount(new Map());
    let first: Promise<void> | undefined;
    await act(async () => {
      first = seen.auth!.server.use('slow.example.com');
      await expect(seen.auth!.server.use('kolab.example.com')).rejects.toThrow(/choosing a server/);
      await first;
    });
    expect(seen.auth?.url).toBe('https://slow.example.com/mcp');
  });

  test('a sign-in can\'t start while the server is being changed', async () => {
    const seen = await mount(new Map());
    await act(async () => {
      const change = seen.auth!.server.use('slow.example.com');
      await expect(seen.auth!.signIn({ kind: 'choose' })).rejects.toThrow(/choosing a server/);
      await change;
    });
  });
});

