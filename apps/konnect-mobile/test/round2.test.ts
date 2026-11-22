import { describe, expect, test } from '@jest/globals';
import { LoginStore, type Login, type SecureKV } from '../src/auth/store';
import { redirectSystemPath } from '../app/+native-intent';
import { PREVIEW_REDIRECT, PRODUCTION_REDIRECT, redirectFor } from '../src/auth/sign-in';
import { scopeTeam, SignedOut, TeamChanged, Tokens } from '../src/auth/tokens';
import { badgeOf, type MyTeam } from '../src/kolab/teams';
import { nonce } from '../src/kolab/thread';

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

describe('a refresh whose answer was lost', () => {
  const ok = reply({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900, scope: 'konjir kolab:hub role:product' });
  const offline = () => { throw new TypeError('Network request failed'); };
  /** A Kolab that answers each refresh with the next of `answers`, and records the refresh token each was sent. */
  const kolab = (answers: (() => ReturnType<typeof reply>)[]) => {
    const sent: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => {
      sent.push(new URLSearchParams(init.body).get('refresh_token')!);
      return (answers[sent.length - 1] ?? answers[answers.length - 1]!)();
    };
    return { sent, fetch };
  };

  test('is sent again with the same refresh token, waiting longer each time, until Kolab answers, and is no sign-out', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login());
    const k = kolab([offline, offline, offline, () => ok]);
    let signedOut = 0;
    const kept: string[] = [];
    const tokens = new Tokens({ store, endpoints, fetch: k.fetch, now: () => 1_000, retryMs: 5, onSignedOut: () => { signedOut++; } });
    const started = Date.now();
    const got = tokens.accessToken('hub');
    await new Promise((r) => setTimeout(r, 3));
    kept.push((await store.get())!.refreshToken);
    expect(await got).toBe('access-1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(5 + 10 + 20 - 3);
    expect(k.sent).toEqual(['refresh-0', 'refresh-0', 'refresh-0', 'refresh-0']);
    expect(kept).toEqual(['refresh-0']);
    expect(signedOut).toBe(0);
    expect(await store.get()).toMatchObject({ refreshToken: 'refresh-1' });
  });

  test('an answer whose body can\'t be read, or Kolab busy, is retried, not taken as no access token', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login());
    const cutOff = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('JSON Parse error: Unexpected end of input'); } });
    const k = kolab([cutOff, () => reply({}, 503), () => reply({ error: 'slow_down' }, 429), () => ok]);
    const tokens = new Tokens({ store, endpoints, fetch: k.fetch, now: () => 1_000, retryMs: 1 });
    expect(await tokens.accessToken()).toBe('access-1');
    expect(k.sent).toHaveLength(4);
  });

  test('ends only when Kolab refuses the token itself, which signs out', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login());
    const k = kolab([offline, offline, () => reply({ error: 'invalid_grant', error_description: 'the refresh token was used or revoked' }, 400)]);
    let signedOut = 0;
    const tokens = new Tokens({ store, endpoints, fetch: k.fetch, now: () => 1_000, retryMs: 1, onSignedOut: () => { signedOut++; } });
    await expect(tokens.accessToken()).rejects.toBeInstanceOf(SignedOut);
    expect(k.sent).toEqual(['refresh-0', 'refresh-0', 'refresh-0']);
    expect(signedOut).toBe(1);
    expect(await store.get()).toBeUndefined();
  });

  test('signing out while it retries stops it, and revokes the refresh token it kept', async () => {
    const store = new LoginStore(kv(), URL_);
    await store.put(login());
    const revoked: string[] = [];
    const fetch = async (url: string, init: { body: string }) => {
      if (url.endsWith('/revoke')) { revoked.push(new URLSearchParams(init.body).get('token')!); return reply({}); }
      throw new TypeError('Network request failed');
    };
    const tokens = new Tokens({ store, endpoints, fetch, now: () => 1_000, retryMs: 60_000 });
    const refreshing = tokens.accessToken();
    await new Promise((r) => setTimeout(r, 5));
    expect(await tokens.signOut()).toEqual({ revoked: true });
    await expect(refreshing).rejects.toThrow('stopped');
    expect(revoked).toEqual(['refresh-0']);
    expect(await store.get()).toBeUndefined();
  });
});

describe('the redirect a variant signs in with', () => {
  test('preview and production each use their own verified https link; development alone its scheme', () => {
    expect(PRODUCTION_REDIRECT).toBe('https://www.konjir.com/konnect/app/oauth');
    expect(PREVIEW_REDIRECT).toBe('https://www.konjir.com/konnect/app/preview/oauth');
    expect(redirectFor('production', 'com.konjir.konnect')).toBe(PRODUCTION_REDIRECT);
    expect(redirectFor('preview', 'com.konjir.konnect.preview')).toBe(PREVIEW_REDIRECT);
    expect(redirectFor('development', 'com.konjir.konnect.dev')).toBe('com.konjir.konnect.dev:/oauth');
    expect(() => redirectFor('staging', 'x')).toThrow('no redirect');
  });

  test('every sign-in answer goes home, never to a screen', () => {
    for (const path of [
      'https://www.konjir.com/konnect/app/oauth?code=c&state=s',
      'https://www.konjir.com/konnect/app/preview/oauth?code=c',
      '/konnect/app/oauth?code=c',
      '/konnect/app/preview/oauth',
      'com.konjir.konnect.dev:/oauth?code=c',
      'com.konjir.konnect.dev://expo-development-client/?url=x',
    ]) expect(redirectSystemPath({ path, initial: false })).toBe('/');
    for (const path of ['/c/channel/general', 'https://www.konjir.com/konnect/app/oauthx', 'https://evil.example/konnect/app/oauth']) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
    }
  });

  test('a message\'s nonce fits Kolab\'s: 1 to 100 of [A-Za-z0-9._:-], one per message', () => {
    const a = nonce(), b = nonce();
    expect(a).toMatch(/^[A-Za-z0-9._:-]{1,100}$/);
    expect(a).not.toBe(b);
  });
});

describe('the badge', () => {
  const t = (kolab: string, unread: number, badge?: number): MyTeam => ({ kolab, role: 'r', owner: 'o', current: false, unread, unread_more: false, mentions: 0, mentions_more: false, ...(badge === undefined ? {} : { badge }) });
  test('sums each team\'s badge as Kolab counts it, or its unread', () => {
    expect(badgeOf([t('a', 3, 1), t('b', 2)])).toBe(3);
  });
});
