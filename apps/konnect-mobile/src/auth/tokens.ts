/**
 * The access token, refreshed as it runs out (access lasts 15 minutes; each refresh rotates the
 * refresh token, and a grant lasts 30 days from its last refresh), and moved between teams.
 *
 * Refreshing and switching teams take turns, one at a time: a second refresh with the same refresh
 * token would be refused (and could end the grant), and a switch changes which team the next refresh
 * is for. Every caller that needs a token while one is under way waits for it. New tokens are saved
 * (LoginStore.put) before any caller gets them, so the rotated refresh token is never only in memory.
 */
import type { Login, LoginStore } from './store';

/** No sign-in, or Kolab ended it (a refused refresh): sign in again. */
export class SignedOut extends Error { name = 'SignedOut'; }

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
  /** Told when Kolab ends the sign-in (a refused refresh), after it is forgotten. */
  onSignedOut?: () => void;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

export class Tokens {
  /** The refresh or switch under way; the next one starts after it. */
  private turn: Promise<unknown> = Promise.resolve();
  private refreshing?: Promise<Login>;
  private readonly now: () => number;
  private readonly earlyMs: number;

  constructor(private readonly o: TokensOptions) {
    this.now = o.now ?? Date.now;
    this.earlyMs = o.earlyMs ?? 60_000;
  }

  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const next = this.turn.then(f, f);
    this.turn = next.catch(() => undefined);
    return next;
  }

  private fresh = (l: Login) => l.expiresAt - this.earlyMs > this.now();

  /** A working access token, refreshed first if it is about to end; after any switch under way. */
  async accessToken(): Promise<string> {
    await this.turn;
    const login = await this.o.store.get();
    if (!login) throw new SignedOut('not signed in');
    if (this.fresh(login)) return login.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Kolab refused `stale`: a fresh token, refreshed unless a newer one is kept already. */
  async renew(stale: string): Promise<string> {
    await this.turn;
    const login = await this.o.store.get();
    if (!login) throw new SignedOut('not signed in');
    if (login.accessToken !== stale && this.fresh(login)) return login.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Refreshes the sign-in, or joins the refresh already under way. */
  refresh(): Promise<Login> {
    this.refreshing ??= this.exclusive(() => this.exchange()).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /**
   * Moves the sign-in to `team`: `ask` tells Kolab (konjir_switch_team, with the access token in
   * use, which Kolab ends), then the same refresh token gets an access token for the new team.
   * Nothing else refreshes or switches meanwhile.
   */
  switchTeam(team: string, ask: (accessToken: string) => Promise<{ kolab: string; role: string }>): Promise<Login> {
    return this.exclusive(async () => {
      let login = await this.o.store.get();
      if (!login) throw new SignedOut('not signed in');
      if (!this.fresh(login)) login = await this.exchange();
      const moved = await ask(login.accessToken);
      await this.o.store.put({ ...login, team: moved.kolab, role: moved.role, expiresAt: 0 });
      return this.exchange();
    });
  }

  /** One refresh at Kolab's token endpoint; the caller holds the turn. */
  private async exchange(): Promise<Login> {
    const login = await this.o.store.get();
    if (!login) throw new SignedOut('not signed in');
    const { tokenEndpoint } = await this.o.endpoints();
    const res = await this.o.fetch(tokenEndpoint, {
      method: 'POST', headers: FORM,
      body: form({ grant_type: 'refresh_token', refresh_token: login.refreshToken, client_id: login.clientId }),
    });
    const body = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok) {
      // The grant is over (revoked, expired, or the token already used): only a new sign-in helps.
      if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
        await this.o.store.remove();
        this.o.onSignedOut?.();
        throw new SignedOut(`Kolab ended the sign-in (${body.error_description ?? body.error})`);
      }
      throw new Error(`Kolab didn't refresh the sign-in: ${res.status} ${body.error ?? ''}`.trim());
    }
    if (!body.access_token || !body.expires_in) throw new Error('Kolab\'s refresh had no access token');
    const next: Login = { ...login, accessToken: body.access_token, refreshToken: body.refresh_token ?? login.refreshToken, expiresAt: this.now() + body.expires_in * 1000 };
    await this.o.store.put(next);
    return next;
  }

  /**
   * Signs out: revokes the refresh token at Kolab (RFC 7009), which ends the grant, then forgets the
   * sign-in. It is forgotten even when Kolab can't be reached; `revoked` says whether Kolab heard.
   */
  signOut(): Promise<{ revoked: boolean }> {
    return this.exclusive(async () => {
      const login = await this.o.store.get();
      if (!login) return { revoked: false };
      const revoked = await this.revoke(login);
      await this.o.store.remove();
      return { revoked };
    });
  }

  /** Revokes a refresh token at Kolab, ending its grant; whether Kolab heard. */
  async revoke(login: Pick<Login, 'refreshToken' | 'clientId'>): Promise<boolean> {
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
