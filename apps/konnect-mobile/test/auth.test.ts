import { describe, expect, test } from '@jest/globals';
import { LoginStore, type Login, type SecureKV } from '../src/auth/store';
import { SignedOut, Tokens } from '../src/auth/tokens';
import { switcherOrder, type MyTeam } from '../src/kolab/teams';

const URL_ = 'http://127.0.0.1:7432/mcp';
const NS = 'konnect.127.0.0.1_7432_mcp';

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

const login = (over: Partial<Login> = {}): Login => ({
  actor: 'ann', team: 'hub', role: 'product', url: URL_, clientId: 'kjcl_one',
  accessToken: 'access-0', refreshToken: 'refresh-0', expiresAt: 0, ...over,
});

/**
 * Kolab's token, revocation and switch: each refresh token works once and rotates, and the access
 * token a refresh issues is for the team the grant is in now; a switch moves the grant and ends the
 * access token it was asked with.
 */
function kolab(opts: { delayMs?: number } = {}) {
  const live = new Set<string>(['refresh-0']);
  const access = new Map<string, string>([['access-0', 'hub']]);
  let grantTeam = 'hub';
  const calls: string[] = [];
  let n = 0;
  const wait = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
  const fetch = async (url: string, init: { body: string }) => {
    const body = Object.fromEntries(new URLSearchParams(init.body)) as Record<string, string>;
    const reply = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json });
    await wait();
    if (url.endsWith('/revoke')) { calls.push('revoke'); live.delete(body.token!); return reply(200, {}); }
    calls.push(`refresh ${body.refresh_token}`);
    if (!live.has(body.refresh_token!)) return reply(400, { error: 'invalid_grant', error_description: 'the refresh token was used or revoked' });
    live.delete(body.refresh_token!);
    n++;
    live.add(`refresh-${n}`);
    access.set(`access-${n}`, grantTeam);
    return reply(200, { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900 });
  };
  const switchTo = (team: string) => async (accessToken: string) => {
    calls.push(`switch ${team} with ${accessToken}`);
    await wait();
    if (!access.has(accessToken)) throw new Error('401');
    access.delete(accessToken);
    grantTeam = team;
    return { kolab: team, role: 'engineer' };
  };
  return { live, access, calls, fetch, switchTo, endpoints: async () => ({ tokenEndpoint: 'http://k/oauth/token', revocationEndpoint: 'http://k/oauth/revoke' }) };
}

describe('the one sign-in', () => {
  test('is kept under one key the secure store allows, per Kolab', async () => {
    const { m, kv } = memoryKV();
    const store = new LoginStore(kv, URL_);
    await store.put(login());
    expect(await store.who()).toEqual({ actor: 'ann', team: 'hub', role: 'product' });
    expect([...m.keys()]).toEqual([`${NS}.login`]);
    expect(await new LoginStore(kv, 'https://kolab.konjir.com/mcp').get()).toBeUndefined();
    await store.remove();
    expect(await store.get()).toBeUndefined();
  });

  test('an earlier build\'s per-team sign-ins are handed over to be revoked, and gone from the store', async () => {
    const { m, kv } = memoryKV();
    m.set(`${NS}.teams`, JSON.stringify(['hub', 'side']));
    m.set(`${NS}.login.hub`, JSON.stringify({ team: 'hub', clientId: 'kjcl_h', refreshToken: 'r-h' }));
    m.set(`${NS}.login.side`, JSON.stringify({ team: 'side', clientId: 'kjcl_s', refreshToken: 'r-s' }));
    m.set(`${NS}.current`, 'side');
    const store = new LoginStore(kv, URL_);
    expect(await store.takeLegacy()).toEqual([{ team: 'hub', clientId: 'kjcl_h', refreshToken: 'r-h' }, { team: 'side', clientId: 'kjcl_s', refreshToken: 'r-s' }]);
    expect([...m.keys()]).toEqual([]);
    expect(await store.takeLegacy()).toEqual([]);
  });
});

describe('tokens', () => {
  test('a token with time left is used as it is', async () => {
    const k = kolab();
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login({ expiresAt: 10 * 60_000 }));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 0 });
    expect(await tokens.accessToken()).toBe('access-0');
    expect(k.calls).toEqual([]);
  });

  test('one refresh at a time, the rotated refresh token saved before anyone gets the new access token', async () => {
    const k = kolab({ delayMs: 10 });
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login());
    const saved: string[] = [];
    const put = store.put.bind(store);
    store.put = async (l) => { await put(l); saved.push(l.refreshToken); };
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 1_000 });
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => tokens.accessToken()));
    expect(new Set(got)).toEqual(new Set(['access-1']));
    expect(k.calls).toEqual(['refresh refresh-0']);
    expect(saved).toEqual(['refresh-1']);
    expect(await store.get()).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 901_000 });
  });

  test('a token Kolab refused is renewed once, however many requests saw it refused', async () => {
    const k = kolab();
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login({ expiresAt: 10 * 60_000 }));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 0 });
    expect(await Promise.all([tokens.renew('access-0'), tokens.renew('access-0')])).toEqual(['access-1', 'access-1']);
    expect(await tokens.renew('access-0')).toBe('access-1');
    expect(k.calls).toEqual(['refresh refresh-0']);
  });

  test('switching asks Kolab with the token in use, then refreshes for the new team, with nothing in between', async () => {
    const k = kolab({ delayMs: 5 });
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login({ expiresAt: 10 * 60_000 }));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 0 });
    // A request mid-switch waits for it, and gets the new team's token, never the ended one.
    const [moved, during] = await Promise.all([tokens.switchTeam('side', k.switchTo('side')), tokens.accessToken()]);
    expect(moved).toMatchObject({ team: 'side', role: 'engineer', accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(during).toBe('access-1');
    expect(k.access.get('access-1')).toBe('side');
    expect(k.calls).toEqual(['switch side with access-0', 'refresh refresh-0']);
    expect(await store.who()).toEqual({ actor: 'ann', team: 'side', role: 'engineer' });
  });

  test('a switch and a refresh asked at once run one after the other, each with the refresh token the other left', async () => {
    const k = kolab({ delayMs: 5 });
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login());
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 1_000 });
    await Promise.all([tokens.refresh(), tokens.switchTeam('side', k.switchTo('side'))]);
    expect(k.calls).toEqual(['refresh refresh-0', 'switch side with access-1', 'refresh refresh-1']);
    expect(await store.get()).toMatchObject({ team: 'side', refreshToken: 'refresh-2' });
  });

  test('a refused switch leaves the sign-in where it was', async () => {
    const k = kolab();
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login({ expiresAt: 10 * 60_000 }));
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 0 });
    await expect(tokens.switchTeam('nope', async () => { throw new Error('not a member of nope'); })).rejects.toThrow('not a member');
    expect(await store.get()).toMatchObject({ team: 'hub', accessToken: 'access-0' });
    expect(await tokens.accessToken()).toBe('access-0');
  });

  test('a refused refresh signs out, and says so', async () => {
    const k = kolab();
    k.live.clear();
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login());
    let told = 0;
    const tokens = new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch, now: () => 1_000, onSignedOut: () => { told++; } });
    await expect(tokens.accessToken()).rejects.toBeInstanceOf(SignedOut);
    expect(told).toBe(1);
    expect(await store.get()).toBeUndefined();
  });

  test('signing out revokes the refresh token and forgets the sign-in, even when Kolab can\'t be reached', async () => {
    const k = kolab();
    const store = new LoginStore(memoryKV().kv, URL_);
    await store.put(login());
    expect(await new Tokens({ store, endpoints: k.endpoints, fetch: k.fetch }).signOut()).toEqual({ revoked: true });
    expect(k.live.has('refresh-0')).toBe(false);
    await store.put(login());
    const offline = new Tokens({ store, endpoints: k.endpoints, fetch: async () => { throw new TypeError('Network request failed'); } });
    expect(await offline.signOut()).toEqual({ revoked: false });
    expect(await store.get()).toBeUndefined();
  });
});

describe('the team switcher', () => {
  const t = (kolab: string, over: Partial<MyTeam> = {}): MyTeam => ({ kolab, role: 'engineer', owner: 'ann', current: false, unread: 0, unread_more: false, mentions: 0, mentions_more: false, ...over });
  test('lists the current team first, then mentions, then unread, then by name', () => {
    expect(switcherOrder([t('zeta'), t('alpha', { unread: 3 }), t('hub', { current: true }), t('beta', { mentions: 1, unread: 1 }), t('aaa')]).map((x) => x.kolab))
      .toEqual(['hub', 'beta', 'alpha', 'aaa', 'zeta']);
  });
});
