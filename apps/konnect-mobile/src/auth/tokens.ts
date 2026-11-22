/**
 * Access tokens for each team, refreshed as they run out: access lasts 15 minutes, and each refresh
 * rotates the refresh token (a grant lasts 30 days from its last refresh). One refresh per team at a
 * time: every caller that needs a token while one is in flight waits for that one, since a second
 * refresh with the same refresh token would be refused, and could end the grant. The new tokens are
 * saved (LoginStore.put) before any caller gets them, so the rotated refresh token is never only in
 * memory.
 */
import type { LoginStore, TeamLogin } from './store';

/** The team has no sign-in, or Kolab ended it (a refused refresh): sign in again. */
export class SignedOut extends Error {
  name = 'SignedOut';
  constructor(readonly team: string, why: string) { super(`${team}: ${why}`); }
}

export interface Endpoints { tokenEndpoint: string; revocationEndpoint?: string }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TokensOptions {
  store: LoginStore;
  /** Kolab's token and revocation endpoints (its discovery document), looked up when first needed. */
  endpoints: () => Promise<Endpoints>;
  fetch: Fetch;
  now?: () => number;
  /** How long before its end an access token is renewed. */
  earlyMs?: number;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

export class Tokens {
  private readonly inFlight = new Map<string, Promise<TeamLogin>>();
  private readonly now: () => number;
  private readonly earlyMs: number;

  constructor(private readonly o: TokensOptions) {
    this.now = o.now ?? Date.now;
    this.earlyMs = o.earlyMs ?? 60_000;
  }

  /** A working access token for `team`, refreshed first if it is about to end. */
  async accessToken(team: string): Promise<string> {
    const login = await this.o.store.get(team);
    if (!login) throw new SignedOut(team, 'not signed in');
    if (login.expiresAt - this.earlyMs > this.now()) return login.accessToken;
    return (await this.refresh(team)).accessToken;
  }

  /**
   * Kolab refused `stale`: a fresh token, refreshed unless one newer than `stale` is kept already
   * (another request refreshed meanwhile).
   */
  async renew(team: string, stale: string): Promise<string> {
    const login = await this.o.store.get(team);
    if (!login) throw new SignedOut(team, 'not signed in');
    if (login.accessToken !== stale && login.expiresAt - this.earlyMs > this.now()) return login.accessToken;
    return (await this.refresh(team)).accessToken;
  }

  /** Refreshes `team`'s sign-in, or joins the refresh already under way. */
  refresh(team: string): Promise<TeamLogin> {
    const running = this.inFlight.get(team);
    if (running) return running;
    const p = this.doRefresh(team).finally(() => this.inFlight.delete(team));
    this.inFlight.set(team, p);
    return p;
  }

  private async doRefresh(team: string): Promise<TeamLogin> {
    const login = await this.o.store.get(team);
    if (!login) throw new SignedOut(team, 'not signed in');
    const { tokenEndpoint } = await this.o.endpoints();
    const res = await this.o.fetch(tokenEndpoint, {
      method: 'POST', headers: FORM,
      body: form({ grant_type: 'refresh_token', refresh_token: login.refreshToken, client_id: login.clientId }),
    });
    const body = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok) {
      // The grant is over (revoked, expired, or the token already used): only a new sign-in helps.
      if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
        await this.o.store.remove(team);
        throw new SignedOut(team, `Kolab ended the sign-in (${body.error_description ?? body.error})`);
      }
      throw new Error(`Kolab didn't refresh ${team}'s sign-in: ${res.status} ${body.error ?? ''}`.trim());
    }
    if (!body.access_token || !body.expires_in) throw new Error(`Kolab's refresh for ${team} had no access token`);
    const next: TeamLogin = {
      ...login,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? login.refreshToken,
      expiresAt: this.now() + body.expires_in * 1000,
    };
    await this.o.store.put(next);
    return next;
  }

  /**
   * Signs `team` out: revokes its refresh token at Kolab (RFC 7009), which ends the grant, then
   * forgets the sign-in. It is forgotten even when Kolab can't be reached; `revoked` says whether
   * Kolab heard, since an unrevoked grant lapses only after 30 days unused.
   */
  async signOut(team: string): Promise<{ revoked: boolean }> {
    const login = await this.o.store.get(team);
    if (!login) return { revoked: false };
    const revoked = await this.revoke(login);
    await this.o.store.remove(team);
    return { revoked };
  }

  /** Revokes a sign-in's refresh token at Kolab, ending its grant; whether Kolab heard. */
  async revoke(login: Pick<TeamLogin, 'refreshToken' | 'clientId'>): Promise<boolean> {
    try {
      const { revocationEndpoint } = await this.o.endpoints();
      if (!revocationEndpoint) return false;
      const res = await this.o.fetch(revocationEndpoint, {
        method: 'POST', headers: FORM,
        body: form({ token: login.refreshToken, token_type_hint: 'refresh_token', client_id: login.clientId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
