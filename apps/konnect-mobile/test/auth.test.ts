import { describe, expect, test } from '@jest/globals';
import { LoginStore, type SecureKV, type TeamLogin } from '../src/auth/store';
import { SignedOut, Tokens } from '../src/auth/tokens';

const URL_ = 'http://127.0.0.1:7432/mcp';

/** The secure store, as a Map. */
function memoryKV() {
  const m = new Map<string, string>();
  const kv: SecureKV = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { if (!/^[A-Za-z0-9._-]+$/.test(k)) throw new Error(`bad key ${k}`); m.set(k, v); },
    remove: async (k) => { m.delete(k); },
  };
  return { m, kv };
}

const login = (team: string, over: Partial<TeamLogin> = {}): TeamLogin => ({
  team, actor: 'ann', role: 'product', url: URL_, clientId: `kjcl_${team}`,
  accessToken: `access-${team}-0`, refreshToken: `refresh-${team}-0`, expiresAt: 0, ...over,
});

/** Kolab's token and revocation endpoints: each refresh token works once, and rotates. */
function kolab(opts: { delayMs?: number } = {}) {
  const live = new Map<string, number>();
  const calls: { url: string; body: Record<string, string> }[] = [];
  let n = 0;
  const fetch = async (url: string, init: { body: string }) => {
    const body = Object.fromEntries(new URLSearchParams(init.body)) as Record<string, string>;
    calls.push({ url, body });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const reply = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json });
    if (url.endsWith('/revoke')) { live.delete(body.token!); return reply(200, {}); }
    if (!live.has(body.refresh_token!)) return reply(400, { error: 'invalid_grant', error_description: 'the refresh token was used or revoked' });
    live.delete(body.refresh_token!);
    n++;
    const refresh = `refresh-${n}`;
    live.set(refresh, n);
    return reply(200, { access_token: `access-${n}`, refresh_token: refresh, expires_in: 900, token_type: 'Bearer' });
  };
  return { live, calls, fetch, endpoints: async () => ({ tokenEndpoint: 'http://k/oauth/token', revocationEndpoint: 'http://k/oauth/revoke' }) };
}

describe('the sign-in store', () => {
  test('keeps each team\'s sign-in under keys the secure store allows, per Kolab', async () => {
    const { m, kv } = memoryKV();
    const store = new LoginStore(kv, URL_);
    await store.put(login('hub'));
    await store.put(login('side'));
    expect(await store.teams()).toEqual(['hub', 'side']);
    expect(await store.current()).toBe('hub');
    await store.setCurrent('side');
    expect(await store.current()).toBe('side');
    expect(await store.summaries()).toEqual([{ team: 'hub', actor: 'ann', role: 'product' }, { team: 'side', actor: 'ann', role: 'product' }]);
    // Another Kolab's store sees none of them.
    expect(await new LoginStore(kv, 'https://kolab.konjir.com/mcp').teams()).toEqual([]);
    await store.remove('side');
    expect(await store.teams()).toEqual(['hub']);
    expect(await store.current()).toBe('hub');
    expect([...m.keys()].every((k) => k.startsWith('konnect.127.0.0.1_7432_mcp.'))).toBe(true);
  });

  test('loses no team when two are added at once', async () => {
    const store = new LoginStore(memoryKV().kv, URL_);
    await Promise.all(['a', 'b', 'c', 'd'].map((t) => store.put(login(t))));
    expect((await store.teams()).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('access tokens', () => {
  test('a token with time left is used as it is', async () => {
    const k = kolab();
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login('hub', { expiresAt: 10 * 60_000 }));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 0 });
    expect(await tokens.accessToken('hub')).toBe('access-hub-0');
    expect(k.calls).toEqual([]);
  });

  test('one refresh per team at a time, the rotated refresh token saved before anyone gets the new access token', async () => {
    const k = kolab({ delayMs: 20 });
    k.live.set('refresh-hub-0', 0);
    const { kv } = memoryKV();
    const store = new LoginStore(kv, URL_);
    await store.put(login('hub'));
    const saved: string[] = [];
    const put = store.put.bind(store);
    store.put = async (l) => { await put(l); saved.push(l.refreshToken); };
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 1_000 });

    const got = await Promise.all([1, 2, 3, 4, 5].map(() => tokens.accessToken('hub')));
    expect(new Set(got)).toEqual(new Set(['access-1']));
    expect(k.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    expect(k.calls[0]!.body).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-hub-0', client_id: 'kjcl_hub' });
    expect(saved).toEqual(['refresh-1']);
    expect(await store.get('hub')).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_000 + 900_000 });
  });

  test('teams refresh apart: one team\'s refresh never waits for another\'s', async () => {
    const k = kolab();
    k.live.set('refresh-hub-0', 0); k.live.set('refresh-side-0', 0);
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login('hub')); await store.put(login('side'));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 1_000 });
    await Promise.all([tokens.accessToken('hub'), tokens.accessToken('side')]);
    expect(k.calls.map((c) => c.body.client_id).sort()).toEqual(['kjcl_hub', 'kjcl_side']);
  });

  test('a token Kolab refused is renewed once, however many requests saw it refused', async () => {
    const k = kolab();
    k.live.set('refresh-hub-0', 0);
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login('hub', { expiresAt: 10 * 60_000 }));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 0 });
    const renewed = await Promise.all([tokens.renew('hub', 'access-hub-0'), tokens.renew('hub', 'access-hub-0')]);
    expect(renewed).toEqual(['access-1', 'access-1']);
    // Refused again with the old one after the renewal: the newer token is kept, so no refresh.
    expect(await tokens.renew('hub', 'access-hub-0')).toBe('access-1');
    expect(k.calls).toHaveLength(1);
  });

  test('a refused refresh signs the team out, and says so', async () => {
    const k = kolab();
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login('hub'));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 1_000 });
    await expect(tokens.accessToken('hub')).rejects.toBeInstanceOf(SignedOut);
    expect(await store.teams()).toEqual([]);
    await expect(tokens.accessToken('hub')).rejects.toThrow('hub: not signed in');
  });

  test('a failure that isn\'t a refusal keeps the sign-in, to try again', async () => {
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login('hub'));
    const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const tokens = new Tokens({ store, endpoints: kolab().endpoints, fetch: down, now: () => 1_000 });
    await expect(tokens.accessToken('hub')).rejects.toThrow('503');
    expect(await store.teams()).toEqual(['hub']);
  });

  test('signing out revokes the refresh token at Kolab and forgets the sign-in, even when Kolab can\'t be reached', async () => {
    const k = kolab();
    k.live.set('refresh-hub-0', 0);
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login('hub')); await store.put(login('side'));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch });
    expect(await tokens.signOut('hub')).toEqual({ revoked: true });
    expect(k.calls.at(-1)).toEqual({ url: 'http://k/oauth/revoke', body: { token: 'refresh-hub-0', token_type_hint: 'refresh_token', client_id: 'kjcl_hub' } });
    expect(k.live.has('refresh-hub-0')).toBe(false);
    const offline = new Tokens({ store, endpoints: k.endpoints, fetch: async () => { throw new TypeError('Network request failed'); } });
    expect(await offline.signOut('side')).toEqual({ revoked: false });
    expect(await store.teams()).toEqual([]);
  });
});
