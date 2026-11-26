import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

// The auth session, as a person who closes Kolab's page: what matters here is which registration
// the page was opened with, and what the app kept before it opened.
const mockOpened: string[] = [];
const mockEvents: string[] = [];
const opened = mockOpened;
// What the page answers: closed, by default; a test sets a redirect back instead.
let mockResult: unknown = { type: 'dismiss' };
const events = mockEvents;
jest.mock('expo-auth-session', () => ({
  ResponseType: { Code: 'code' },
  CodeChallengeMethod: { S256: 'S256' },
  exchangeCodeAsync: jest.fn(),
  AuthRequest: class {
    clientId: string;
    constructor(o: { clientId: string }) { this.clientId = o.clientId; }
    codeVerifier = 'v';
    async promptAsync() { mockOpened.push(this.clientId); mockEvents.push(`page ${this.clientId}`); return mockResult; }
  },
}));

// eslint-disable-next-line import/first
import { exchangeCodeAsync } from 'expo-auth-session';
// eslint-disable-next-line import/first
import { clientKnown, discover, signIn, SignInStopped } from '../src/auth/sign-in';

const URL_ = 'http://127.0.0.1:7432/mcp';
const reply = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json }) as unknown as Response;

/** Kolab's discovery, token and registration endpoints, knowing the registrations in `known`. */
const kolab = (known: Set<string>) => {
  const probes: string[] = [];
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      const k = 'http://127.0.0.1:7432';
      return reply(200, { issuer: k, authorization_endpoint: `${k}/oauth/authorize`, token_endpoint: `${k}/oauth/token`, registration_endpoint: `${k}/oauth/register`, revocation_endpoint: `${k}/oauth/revoke` });
    }
    if (url.endsWith('/oauth/token')) {
      const body = new URLSearchParams(init?.body);
      probes.push(`${body.get('grant_type')} ${body.get('client_id')}`);
      events.push(`probe ${body.get('client_id')}`);
      // As oauth.controller.ts's token: an unknown client first, then the token.
      if (!known.has(body.get('client_id')!)) return reply(401, { error: 'invalid_client', error_description: 'unknown client: register it first' });
      return reply(400, { error: 'invalid_grant', error_description: 'the refresh token is not valid' });
    }
    if (url.endsWith('/oauth/register')) { known.add('kjcl_new'); events.push('register'); return reply(201, { client_id: 'kjcl_new' }); }
    throw new Error(`unexpected ${url}`);
  };
  return { probes, fetch };
};

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; opened.length = 0; events.length = 0; mockResult = { type: 'dismiss' }; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('a kept client registration', () => {
  test('Kolab answers invalid_client for one it forgot, and invalid_grant for one it knows', async () => {
    const k = kolab(new Set(['kjcl_known']));
    expect(await clientKnown('http://k/oauth/token', 'kjcl_known', k.fetch as typeof fetch)).toBe(true);
    expect(await clientKnown('http://k/oauth/token', 'kjcl_pruned', k.fetch as typeof fetch)).toBe(false);
    expect(k.probes).toEqual(['refresh_token kjcl_known', 'refresh_token kjcl_pruned']);
  });

  test('one Kolab pruned is forgotten, and a new one registered and kept, before Kolab\'s page opens', async () => {
    const k = kolab(new Set());
    globalThis.fetch = k.fetch as typeof fetch;
    const kept: string[] = [];
    await expect(signIn({
      url: URL_, scheme: 'com.konjir.konnect.dev', variant: 'development', ask: { kind: 'choose' }, clientName: 'konnect (development)', clientId: 'kjcl_pruned',
      onClientGone: async () => { kept.push('forgot kjcl_pruned'); events.push('forget'); },
      onRegistered: async (id) => { kept.push(`kept ${id}`); events.push(`keep ${id}`); },
    })).rejects.toBeInstanceOf(SignInStopped);
    expect(opened).toEqual(['kjcl_new']);
    expect(kept).toEqual(['forgot kjcl_pruned', 'kept kjcl_new']);
    expect(events).toEqual(['probe kjcl_pruned', 'forget', 'register', 'keep kjcl_new', 'page kjcl_new']);
  });

  test('one Kolab knows is used as it is, with no new registration', async () => {
    const k = kolab(new Set(['kjcl_known']));
    globalThis.fetch = k.fetch as typeof fetch;
    const changed: string[] = [];
    await expect(signIn({
      url: URL_, scheme: 'com.konjir.konnect.dev', variant: 'development', ask: { kind: 'choose' }, clientName: 'konnect (development)', clientId: 'kjcl_known',
      onClientGone: async () => { changed.push('forgot'); }, onRegistered: async (id) => { changed.push(id); },
    })).rejects.toBeInstanceOf(SignInStopped);
    expect(opened).toEqual(['kjcl_known']);
    expect(changed).toEqual([]);
    expect(events).toEqual(['probe kjcl_known', 'page kjcl_known']);
  });
});

describe('a server that isn\'t its own sign-in (a mix-up)', () => {
  const doc = (over: Record<string, string>) => async (url: string) => {
    const o = new URL(url).origin;
    return reply(200, { issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register`, ...over });
  };

  test('one whose issuer or any endpoint is on another origin is refused', async () => {
    globalThis.fetch = doc({ authorization_endpoint: 'https://kolab.konjir.com/oauth/authorize' }) as unknown as typeof fetch;
    await expect(discover('https://kolab.evil.example/mcp')).rejects.toThrow(/names another as its sign-in/);
    globalThis.fetch = doc({ issuer: 'https://kolab.konjir.com' }) as unknown as typeof fetch;
    await expect(discover('https://kolab.evil.example/mcp')).rejects.toThrow(/names another as its sign-in/);
    globalThis.fetch = doc({ revocation_endpoint: 'https://elsewhere.example/revoke' }) as unknown as typeof fetch;
    await expect(discover('https://kolab.evil.example/mcp')).rejects.toThrow(/names another as its sign-in/);
    globalThis.fetch = doc({}) as unknown as typeof fetch;
    await expect(discover('https://kolab.example.com/mcp')).resolves.toMatchObject({ issuer: 'https://kolab.example.com' });
  });

  test('a code that came back from another server is never sent to this one\'s token endpoint', async () => {
    const k = kolab(new Set(['kjcl_known']));
    globalThis.fetch = k.fetch as typeof fetch;
    const exchange = jest.mocked(exchangeCodeAsync);
    exchange.mockClear();
    for (const iss of ['https://kolab.konjir.com', undefined]) {
      mockResult = { type: 'success', params: { code: 'c', ...(iss ? { iss } : {}) } };
      await expect(signIn({ url: URL_, scheme: 'com.konjir.konnect.dev', variant: 'development', ask: { kind: 'choose' }, clientName: 'konnect (development)', clientId: 'kjcl_known' }))
        .rejects.toThrow(/came back from/);
    }
    expect(exchange).not.toHaveBeenCalled();
  });
});
