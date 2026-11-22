import { describe, expect, test } from '@jest/globals';
import { LoginStore, type Login, type SecureKV } from '../src/auth/store';
import { PRODUCTION_REDIRECT, redirectFor } from '../src/auth/sign-in';
import { scopeTeam, TeamChanged, Tokens } from '../src/auth/tokens';
import { badgeOf, type MyTeam } from '../src/kolab/teams';

const URL_ = 'http://127.0.0.1:7432/mcp';
const kv = (): SecureKV => { const m = new Map<string, string>(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } }; };
const login = (over: Partial<Login> = {}): Login => ({ actor: 'ann', team: 'hub', role: 'product', url: URL_, clientId: 'kjcl_one', accessToken: 'access-0', refreshToken: 'refresh-0', expiresAt: 0, ...over });
const endpoints = async () => ({ tokenEndpoint: 'http://k/oauth/token', revocationEndpoint: 'http://k/oauth/revoke' });
const reply = (json: unknown, status = 200) => ({ ok: status < 300, status, json: async () => json });

describe('the team a token is for', () => {
  test('a scope names its team and role', () => {
    expect(scopeTeam('konjir kolab:side role:engineer')).toEqual({ team: 'side', role: 'engineer' });
    expect(scopeTeam('konjir kolab:hub')).toEqual({ team: 'hub' });
    expect(scopeTeam('konjir choose:kolab')).toBeUndefined();
    expect(scopeTeam(undefined)).toBeUndefined();
  });

  test('a refresh Kolab moved to another team (the person lost theirs) is kept as that team, and said; a request for the old team never gets its token', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login());
    const moves: string[] = [];
    const fetch = async () => reply({ access_token: 'a-side', refresh_token: 'r-side', expires_in: 900, scope: 'konjir kolab:side role:engineer' });
    const tokens = new Tokens({ store, endpoints, fetch, now: () => 1_000, onTeamMoved: (from, to) => moves.push(`${from}>${to}`) });
    await expect(tokens.accessToken('hub')).rejects.toBeInstanceOf(TeamChanged);
    expect(await store.who()).toEqual({ actor: 'ann', team: 'side', role: 'engineer' });
    expect(moves).toEqual(['hub>side']);
    expect(await tokens.accessToken('side')).toBe('a-side');
    await expect(tokens.renew('a-side', 'hub')).rejects.toBeInstanceOf(TeamChanged);
  });

  test('a refresh whose answer was lost is sent again at once, and is no sign-out', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login());
    let calls = 0;
    const fetch = async () => { calls++; if (calls === 1) throw new TypeError('Network request failed'); return reply({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900, scope: 'konjir kolab:hub role:product' }); };
    const tokens = new Tokens({ store, endpoints, fetch, now: () => 1_000 });
    expect(await tokens.accessToken('hub')).toBe('access-1');
    expect(calls).toBe(2);
  });

  test('a switch asked for is no news', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login({ expiresAt: 600_000 }));
    const moves: string[] = [];
    const fetch = async () => reply({ access_token: 'a-side', refresh_token: 'r-side', expires_in: 900, scope: 'konjir kolab:side role:engineer' });
    const tokens = new Tokens({ store, endpoints, fetch, now: () => 0, onTeamMoved: (f, t) => moves.push(`${f}>${t}`) });
    await tokens.switchTeam('side', async () => ({ kolab: 'side', role: 'engineer' }));
    expect(moves).toEqual([]);
    expect(await tokens.accessToken('side')).toBe('a-side');
  });

  test('replacing the sign-in keeps the new one and revokes the old', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login());
    const revoked: string[] = [];
    const fetch = async (url: string, init: { body: string }) => { if (url.endsWith('/revoke')) revoked.push(new URLSearchParams(init.body).get('token')!); return reply({}); };
    const tokens = new Tokens({ store, endpoints, fetch });
    await tokens.replace(login({ refreshToken: 'refresh-new' }));
    await new Promise((r) => setTimeout(r, 0));
    expect((await store.get())?.refreshToken).toBe('refresh-new');
    expect(revoked).toEqual(['refresh-0']);
  });
});

describe('the redirect a variant signs in with', () => {
  test('production uses the verified https link; development and preview their own scheme', () => {
    expect(redirectFor('production', 'com.konjir.konnect')).toBe(PRODUCTION_REDIRECT);
    expect(PRODUCTION_REDIRECT).toBe('https://www.konjir.com/konnect/app/oauth');
    expect(redirectFor('development', 'com.konjir.konnect.dev')).toBe('com.konjir.konnect.dev:/oauth');
    expect(redirectFor('preview', 'com.konjir.konnect.preview')).toBe('com.konjir.konnect.preview:/oauth');
  });
});

describe('the badge', () => {
  const t = (kolab: string, unread: number, badge?: number): MyTeam => ({ kolab, role: 'r', owner: 'o', current: false, unread, unread_more: false, mentions: 0, mentions_more: false, ...(badge === undefined ? {} : { badge }) });
  test('sums each team\'s badge as Kolab counts it, or its unread', () => {
    expect(badgeOf([t('a', 3, 1), t('b', 2)])).toBe(3);
  });
});
