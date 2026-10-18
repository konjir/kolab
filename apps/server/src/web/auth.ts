import { createHash } from 'node:crypto';
import {
  type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Kolab, type OAuthTokens } from '@konjir/engine';
import type { WebMe } from '@konjir/types';
import { adminTokenMatcher } from '../auth.js';
import { KOLAB, WEB_OPTIONS, type WebOptions } from '../tokens.js';

/**
 * How a person signs in to the web interface (W3.1, D55). A person signs in with the identity
 * provider (GitHub), through Kolab's own authorization server, as its first-party client
 * `konjir-web` (oauth.controller.ts): one person, one kolab, one role (ENF4, ENF5), with an access
 * token that lasts 15 minutes and a refresh token that renews it. With token sign-in on (local
 * development, or no identity provider set up), a person may instead paste a session token of
 * their own that an admin opened. An agent's session is refused either way: the web interface is
 * for people, and an agent acts through MCP or the CLI, so no person clicks as their agent and no
 * verdict says an agent gave it.
 *
 * Kolab keeps the access token in an HttpOnly, SameSite=Strict session cookie, and the refresh
 * token in another, so the page's script never holds either. Behind the TLS proxy they are
 * `__Host-konjir_session` and `__Host-konjir_refresh` (Secure, Path=/, no Domain), so no other
 * host under the same domain can set one in their place; on loopback `konjir_session` and
 * `konjir_refresh`, scoped to /api. Every call checks the session again, as /mcp does; when the
 * access token has expired, the guard refreshes it, once however many calls arrive together, and
 * sets both cookies anew. A session that ends signs the page out; signing out ends the session
 * and revokes its refresh token.
 *
 * Every /api request must also name a host Kolab serves (loopback names, or its public host behind
 * the TLS proxy), as /mcp's DNS-rebinding guard requires, and a request that changes anything must
 * come from Kolab's own origin.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const cookieName = (options: WebOptions) => (options.publicHost ? '__Host-konjir_session' : 'konjir_session');
export const refreshCookieName = (options: WebOptions) => (options.publicHost ? '__Host-konjir_refresh' : 'konjir_refresh');

/** The session token a request's cookie carries, if any. */
export function tokenOf(req: Request, options: WebOptions, name = cookieName(options)): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try { return decodeURIComponent(v) || undefined; } catch { return undefined; }
    }
  }
  return undefined;
}

const hostName = (host: string) => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]).toLowerCase();

/**
 * Refuses a request whose Host isn't one Kolab serves (forwarding headers are ignored, as on
 * /mcp), and a request that changes anything unless its Origin is Kolab's own.
 */
export function checkOrigin(req: Request, options: WebOptions) {
  const host = req.headers.host ?? '';
  const name = hostName(host);
  const pub = options.publicHost?.toLowerCase();
  if (!(LOOPBACK.has(name) || (pub && name === pub))) throw new ForbiddenException({ error: 'forbidden', message: `this Kolab doesn't serve the host ${host || '(none)'}` });
  if (!UNSAFE.has(req.method)) return;
  const origin = req.headers.origin;
  let ok = false;
  if (origin) {
    try {
      const o = new URL(origin);
      ok = pub && name === pub ? o.protocol === 'https:' && o.host.toLowerCase() === pub : o.host.toLowerCase() === host.toLowerCase();
    } catch { ok = false; }
  }
  if (!ok) throw new ForbiddenException({ error: 'forbidden', message: 'a change must come from this Kolab\'s own pages' });
}

/**
 * A session cookie: the browser forgets it when it closes, and signing out ends the session
 * itself. With `refresh`, the refresh token's cookie beside it, likewise a session cookie.
 */
export function setSessionCookie(res: Response, token: string, options: WebOptions, refresh?: string) {
  const scope = options.publicHost ? 'Path=/; Secure' : 'Path=/api';
  const cookies = [`${cookieName(options)}=${encodeURIComponent(token)}; ${scope}; HttpOnly; SameSite=Strict`];
  if (refresh) cookies.push(`${refreshCookieName(options)}=${encodeURIComponent(refresh)}; ${scope}; HttpOnly; SameSite=Strict`);
  // Appended, never replacing a cookie set earlier in the same response (the guard's refresh).
  for (const c of cookies) res.append('set-cookie', c);
}

export function clearSessionCookie(res: Response, options: WebOptions) {
  const scope = options.publicHost ? 'Path=/; Secure' : 'Path=/api';
  for (const n of [cookieName(options), refreshCookieName(options)]) res.append('set-cookie', `${n}=; ${scope}; HttpOnly; SameSite=Strict; Max-Age=0`);
}

/**
 * Checks a token is an open session of a person's: the admin token, an unknown or ended token, a
 * session that lost its access, and an agent's session are each refused.
 */
@Injectable()
export class WebPeople {
  private readonly isAdmin: (token: string) => boolean;
  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
  ) {
    this.isAdmin = adminTokenMatcher(options.adminToken);
  }

  async check(token: string | undefined): Promise<WebMe> {
    return (await this.session(token)).me;
  }

  /** As check, with the session's id (its key), which the page never sees. */
  async session(token: string | undefined): Promise<{ me: WebMe; session: string }> {
    if (token && this.isAdmin(token)) {
      throw new UnauthorizedException({ error: 'unauthorized', message: 'the admin token works in no kolab: sign in as yourself, one kolab and one role' });
    }
    const signIn = this.options.tokenSignIn ? 'sign in again' : `sign in again${this.options.identityLabel ? ` with ${this.options.identityLabel}` : ''}`;
    const live = token ? await this.kolab.liveSession(token) : undefined;
    if (!live) throw new UnauthorizedException({ error: 'unauthorized', message: signIn });
    if (!live.granted && !this.options.handIssuedTokens) throw new UnauthorizedException({ error: 'unauthorized', message: `hand-issued session tokens are turned off here: ${signIn}` });
    let i;
    try { i = await this.kolab.sessionInfo(token!); } catch { throw new UnauthorizedException({ error: 'unauthorized', message: `your session has ended: ${signIn}` }); }
    if (i.kind !== 'person') {
      throw new ForbiddenException({ error: 'forbidden', message: `that is ${i.actor}'s session, an agent's: the web interface is for people, and an agent works through MCP or the konjir CLI. Sign in as yourself` });
    }
    const a = await this.kolab.actor(i.actor);
    return { session: i.session, me: { actor: i.actor, name: a.name, kind: i.kind, owner: i.owner, role: i.role as WebMe['role'], layer: i.layer, kolab: i.kolab, access: i.access } };
  }
}

/** How long a refresh's result is kept for the calls that arrived with the same refresh token. */
const REFRESH_SHARED_MS = 10_000;

/**
 * Refreshes the web interface's grants (D55), once per refresh token however many of a page's
 * calls arrive with it at once: they share the one result, so none of them presents a used refresh
 * token, which Kolab would refuse. Kept in memory by the refresh token's hash, for a few seconds.
 */
@Injectable()
export class WebRefresher {
  private readonly recent = new Map<string, { at: number; result: Promise<OAuthTokens> }>();
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  refresh(refreshToken: string): Promise<OAuthTokens> {
    const now = Date.now();
    for (const [k, v] of this.recent) if (now - v.at > REFRESH_SHARED_MS) this.recent.delete(k);
    const key = createHash('sha256').update(refreshToken).digest('base64url');
    const hit = this.recent.get(key);
    if (hit) return hit.result;
    const result = this.kolab.refreshGrant({ refreshToken, clientId: 'konjir-web' });
    this.recent.set(key, { at: now, result });
    result.catch(() => undefined);
    return result;
  }
}

/** Requests the guard has let through carry their session here. Never log it: it is the bearer token. */
type Signed = Request & { konjirSession?: string; konjirSessionId?: string; konjirMe?: WebMe };

/** Every /api call but signing in: a known host, Kolab's own origin for changes, and a person's open session. */
@Injectable()
export class WebSessionGuard implements CanActivate {
  constructor(
    @Inject(WebPeople) private readonly people: WebPeople,
    @Inject(WebRefresher) private readonly refresher: WebRefresher,
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Signed>();
    checkOrigin(req, this.options);
    let token = tokenOf(req, this.options);
    let found;
    try {
      found = await this.people.session(token);
    } catch (e) {
      // An expired access token, with a refresh token beside it: refresh, and carry on (D55).
      const refresh = tokenOf(req, this.options, refreshCookieName(this.options));
      if (!(e instanceof UnauthorizedException) || !refresh) throw e;
      let t: OAuthTokens;
      try { t = await this.refresher.refresh(refresh); } catch { throw e; }
      token = t.accessToken;
      found = await this.people.session(token);
      setSessionCookie(context.switchToHttp().getResponse<Response>(), t.accessToken, this.options, t.refreshToken);
    }
    req.konjirMe = found.me;
    req.konjirSessionId = found.session;
    req.konjirSession = token;
    return true;
  }
}

/** The id (key) of the session a guarded request carries. */
export const WebSessionId = createParamDecorator((_: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Signed>().konjirSessionId!);

/** The session a guarded request carries. */
export const WebSession = createParamDecorator((_: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Signed>().konjirSession!);

/** Who the guarded request's session is, as the guard found it. */
export const WebWho = createParamDecorator((_: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Signed>().konjirMe!);
