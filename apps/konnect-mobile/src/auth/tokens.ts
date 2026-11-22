/**
 * The access token, refreshed as it runs out (access lasts 15 minutes; each refresh rotates the
 * refresh token, and a grant lasts 30 days from its last refresh), and moved between teams.
 *
 * Refreshing and switching teams take turns, one at a time: a second refresh with the same refresh
 * token would be refused (and could end the grant), and a switch changes which team the next refresh
 * is for. Every caller that needs a token while one is under way waits for it, until its first try
 * fails: then the caller is told Kolab can't be reached while the refresh retries in the background. New tokens are saved
 * (LoginStore.put) before any caller gets them, so the rotated refresh token is never only in memory.
 */
import type { Login, LoginStore } from './store';

/** No sign-in, or Kolab ended it (a refused refresh): sign in again. */
export class SignedOut extends Error { name = 'SignedOut'; }

/** A request made for one team after the sign-in moved to another: never sent to the new team. */
export class TeamChanged extends Error { name = 'TeamChanged'; }

/**
 * Kolab can't be reached to renew the sign-in just now. The sign-in is kept: the refresh goes on
 * trying in the background, and the next request tries again. Never a sign-out.
 */
export class Unreachable extends Error { name = 'Unreachable'; }

/** The team and role a token's scope names (`konjir kolab:<team> role:<role>`), if it names them. */
export function scopeTeam(scope: string | undefined): { team: string; role?: string } | undefined {
  const team = /(?:^|\s)kolab:([a-z0-9][a-z0-9-]*)(?:\s|$)/.exec(scope ?? '')?.[1];
  if (!team) return undefined;
  const role = /(?:^|\s)role:([a-z]+)(?:\s|$)/.exec(scope ?? '')?.[1];
  return { team, ...(role ? { role } : {}) };
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
  /** The first wait before a refresh whose answer was lost is sent again; it doubles each time, up to `retryMaxMs`. */
  retryMs?: number;
  retryMaxMs?: number;
  /**
   * How long a lost refresh is retried at once: 90 s, well inside Kolab's retry window (120 s),
   * within which the same refresh token gets the same successor while that successor's access token
   * hasn't been presented. Past it the tries stop and the sign-in is kept: the next request tries
   * again, and Kolab decides whether the sign-in is still good (a refresh that never reached Kolab
   * left the token valid).
   */
  retryWindowMs?: number;
  /** Told when Kolab ends the sign-in (a refused refresh), after it is forgotten. */
  onSignedOut?: () => void;
  /**
   * Told when a refresh lands in another team than the one kept: Kolab moved the sign-in, because
   * the person lost the team (removed, left, archived, erased). `from` is the team they lost.
   */
  onTeamMoved?: (from: string, to: string) => void;
  /**
   * Told when a switch asked for lands after its caller was already answered (Unreachable while its
   * new token was on the way): the kept login names `team` now, and whoever shows it reads it again.
   */
  onTeamChanged?: (team: string) => void;
}

type RefreshAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

export class Tokens {
  /** The refresh or switch under way; the next one starts after it. */
  private turn: Promise<unknown> = Promise.resolve();
  private refreshing?: Promise<Login>;
  /** A switch asked for is under way: its refresh's new team is no news. */
  private switching = false;
  private readonly now: () => number;
  private readonly earlyMs: number;
  private readonly retryMs: number;
  private readonly retryMaxMs: number;
  private readonly retryWindowMs: number;
  /** Counts interruptions: a refresh still retrying when it changes stops (signing out, or in again). */
  private generation = 0;
  private wake = new Set<() => void>();
  /** A refresh is retrying after a failed try: whoever waits for it is told so, rather than kept waiting. */
  private retrying = false;
  private failed = new Set<(e: Unreachable) => void>();

  constructor(private readonly o: TokensOptions) {
    this.now = o.now ?? Date.now;
    this.earlyMs = o.earlyMs ?? 60_000;
    this.retryMs = o.retryMs ?? 1_000;
    this.retryMaxMs = o.retryMaxMs ?? 30_000;
    this.retryWindowMs = o.retryWindowMs ?? 90_000;
  }

  /** Stops a refresh that is retrying, so what comes next (signing out, a new sign-in) needn't wait for Kolab. */
  private interrupt() {
    this.generation++;
    // What comes next isn't waiting on the refresh stopped here.
    this.retrying = false;
    for (const w of this.wake) w();
    this.wake.clear();
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.wake.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.wake.add(done);
    });
  }

  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const next = this.turn.then(f, f);
    this.turn = next.catch(() => undefined);
    return next;
  }

  private fresh = (l: Login) => l.expiresAt - this.earlyMs > this.now();

  /** A try of the refresh under way failed: everyone waiting for it hears so at once. */
  private triedAndFailed() {
    this.retrying = true;
    const e = new Unreachable('Kolab can\'t be reached just now: konnect keeps trying');
    for (const f of [...this.failed]) f(e);
  }

  /** `p`, or Unreachable as soon as the refresh under way has failed a try (at once if it has). */
  private orUnreachable<T>(p: Promise<T>): Promise<T> {
    if (this.retrying) { p.catch(() => undefined); return Promise.reject(new Unreachable('Kolab can\'t be reached just now: konnect keeps trying')); }
    return new Promise<T>((resolve, reject) => {
      const fail = (e: Unreachable) => { this.failed.delete(fail); reject(e); };
      this.failed.add(fail);
      p.then((v) => { this.failed.delete(fail); resolve(v); }, (e: unknown) => { this.failed.delete(fail); reject(e); });
    });
  }

  /** The turn, once the refresh or switch under way is done; or Unreachable once it has failed a try. */
  private waitTurn(): Promise<unknown> { return this.orUnreachable(this.turn); }

  /**
   * A working access token, refreshed first if it is about to end; after any switch under way.
   * With `team`, only one for that team: a request made for a team the sign-in has left throws
   * TeamChanged rather than reach the new team.
   */
  async accessToken(team?: string): Promise<string> {
    try {
      await this.waitTurn();
    } catch (e) {
      // A refresh is retrying: the token in hand still serves while it lasts, for every caller.
      const kept = e instanceof Unreachable ? await this.o.store.get() : undefined;
      if (kept && kept.expiresAt > this.now() && (team === undefined || kept.team === team)) return kept.accessToken;
      throw e;
    }
    let login = await this.o.store.get();
    if (!login) throw new SignedOut('not signed in');
    if (!this.fresh(login)) {
      const kept = login;
      // Kolab can't be reached: the token in hand still serves while it lasts.
      login = await this.refresh().catch((e: unknown) => { if (e instanceof Unreachable && kept.expiresAt > this.now()) return kept; throw e; });
    }
    if (team !== undefined && login.team !== team) throw new TeamChanged(`the sign-in moved from ${team} to ${login.team}`);
    return login.accessToken;
  }

  /** Kolab refused `stale`: a fresh token, refreshed unless a newer one is kept already; for `team` alone, as accessToken. */
  async renew(stale: string, team?: string): Promise<string> {
    await this.waitTurn();
    let login = await this.o.store.get();
    if (!login) throw new SignedOut('not signed in');
    if (login.accessToken === stale || !this.fresh(login)) login = await this.refresh();
    if (team !== undefined && login.team !== team) throw new TeamChanged(`the sign-in moved from ${team} to ${login.team}`);
    return login.accessToken;
  }

  /**
   * Keeps a new sign-in in place of the one kept (signing in again, or as another account), and
   * revokes the old one at Kolab, with no refresh or switch in between.
   */
  replace(next: Login): Promise<void> {
    this.interrupt();
    return this.exclusive(async () => {
      const before = await this.o.store.get();
      await this.o.store.put(next);
      if (before && before.refreshToken !== next.refreshToken) void this.revoke(before);
    });
  }

  /**
   * Refreshes the sign-in, or joins the refresh already under way. Once a try has failed, the
   * caller gets Unreachable and the refresh goes on in the background.
   */
  refresh(): Promise<Login> {
    this.refreshing ??= this.exclusive(() => this.exchange()).finally(() => { this.refreshing = undefined; });
    return this.orUnreachable(this.refreshing);
  }

  /**
   * Moves the sign-in to `team`: `ask` tells Kolab (konjir_switch_team, with the access token in
   * use, which Kolab ends), then the same refresh token gets an access token for the new team.
   * Nothing else refreshes or switches meanwhile: a refresh retrying is stopped, and the switch
   * makes its own. Unreachable once a try of that fails, the switch going on in the background: Kolab
   * has moved the sign-in already if `ask` answered (the kept login names the new team).
   */
  switchTeam(team: string, ask: (accessToken: string) => Promise<{ kolab: string; role: string }>): Promise<Login> {
    this.interrupt();
    // Whether the caller has been answered already, and whether Kolab has been asked.
    const run = { answered: false, asked: false };
    const work = this.exclusive(async () => {
      this.switching = true;
      try {
        const login = await this.move(team, ask, run);
        // Landed after its caller heard Unreachable: whoever shows the team reads it again.
        if (run.answered) this.o.onTeamChanged?.(login.team);
        return login;
      } finally { this.switching = false; }
    });
    return this.orUnreachable(work).catch((e: unknown) => { run.answered = true; throw e; });
  }

  /**
   * The switch itself. A switch whose caller was answered (Unreachable) before Kolab was asked is
   * given up there: its caller was told it failed, so it never moves the sign-in later on its own.
   */
  private async move(team: string, ask: (accessToken: string) => Promise<{ kolab: string; role: string }>, run: { answered: boolean; asked: boolean }): Promise<Login> {
    let login = await this.o.store.get();
    if (!login) throw new SignedOut('not signed in');
    if (!this.fresh(login)) login = await this.exchange();
    if (run.answered) throw new Unreachable(`The switch to ${team} was given up: Kolab couldn't be reached`);
    run.asked = true;
    const moved = await ask(login.accessToken);
    await this.o.store.put({ ...login, team: moved.kolab, role: moved.role, expiresAt: 0 });
    return this.exchange();
  }

  /** One refresh at Kolab's token endpoint; the caller holds the turn. */
  private async exchange(): Promise<Login> {
    const login = await this.o.store.get();
    if (!login) throw new SignedOut('not signed in');
    const { tokenEndpoint } = await this.o.endpoints();
    const send = () => this.o.fetch(tokenEndpoint, {
      method: 'POST', headers: FORM,
      body: form({ grant_type: 'refresh_token', refresh_token: login.refreshToken, client_id: login.clientId }),
    });
    const answered = await this.answer(send);
    // 90 s of tries with no answer: stop, and keep the sign-in. A refresh that never reached Kolab
    // left the token as it was; the next request tries again, and Kolab decides.
    if (!answered) throw new Unreachable('Kolab couldn\'t be reached to renew the sign-in: konnect tries again with your next request');
    const { res, body } = answered;
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
    // The token's own scope says which team it is for: the one kept, unless Kolab moved the sign-in.
    const scoped = scopeTeam(body.scope);
    const next: Login = {
      ...login, accessToken: body.access_token, refreshToken: body.refresh_token ?? login.refreshToken, expiresAt: this.now() + body.expires_in * 1000,
      ...(scoped ? { team: scoped.team, role: scoped.role ?? login.role } : {}),
    };
    await this.o.store.put(next);
    if (scoped && scoped.team !== login.team && !this.switching) this.o.onTeamMoved?.(login.team, scoped.team);
    return next;
  }

  /**
   * Kolab's answer to a refresh, sent again until one comes back that can be read. An answer lost on
   * the way (no connection, a timeout, a body cut off, Kolab busy or restarting) never ends the
   * sign-in: the same refresh token, kept as it was, is sent again, waiting longer each time (1 s,
   * doubling to 30 s), because for 120 s (Kolab's refreshRetryS) Kolab gives a retried refresh the
   * same successor tokens until the successor's access token is presented. Kolab's own refusal, or
   * an interruption, ends it; so do 90 s of tries with no answer (retryWindowMs: nothing, and the
   * caller keeps the sign-in). Each wait is followed by a try, so a phone that slept through the
   * window still asks once on waking.
   */
  private async answer(send: () => ReturnType<Fetch>): Promise<{ res: { ok: boolean; status: number }; body: RefreshAnswer } | undefined> {
    const generation = this.generation;
    const until = this.now() + this.retryWindowMs;
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) {
          // Stopped while that try was on its way: its failure is no news to whoever comes next.
          if (generation !== this.generation) throw new Error('The refresh was stopped');
          this.triedAndFailed();
          if (this.now() >= until) return undefined;
          await this.pause(Math.min(this.retryMs * 2 ** (attempt - 1), this.retryMaxMs));
        }
        if (generation !== this.generation) throw new Error('The refresh was stopped');
        let res;
        try { res = await send(); } catch { continue; }
        if (res.status >= 500 || res.status === 429) continue;
        let body: RefreshAnswer;
        try { body = (await res.json() ?? {}) as RefreshAnswer; } catch {
          if (res.ok) continue;
          body = {};
        }
        return { res, body };
      }
    } finally {
      // A loop that was stopped leaves the state to the one that stopped it.
      if (generation === this.generation) this.retrying = false;
    }
  }

  /**
   * Signs out: revokes the refresh token at Kolab (RFC 7009), which ends the grant, then forgets the
   * sign-in. It is forgotten even when Kolab can't be reached; `revoked` says whether Kolab heard.
   */
  signOut(): Promise<{ revoked: boolean }> {
    this.interrupt();
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
