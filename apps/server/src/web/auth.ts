import {
  type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Kolab } from '@konjir/engine';
import type { WebMe } from '@konjir/types';
import { adminTokenMatcher } from '../auth.js';
import { KOLAB, WEB_OPTIONS, type WebOptions } from '../tokens.js';

/**
 * How a person signs in to the web interface (W3.1). Until OAuth is bound (RUN3, P2), a person
 * signs in with a Konjir session token of their own: one person, one kolab, one role (ENF4,
 * ENF5), opened by an admin (`konjir admin_open_session`, or `deploy/konjir-ops.sh connect`). An
 * agent's session is refused: the web interface is for people, and an agent acts through MCP or
 * the CLI, so no person clicks as their agent and no verdict says an agent gave it.
 *
 * The page posts the token once to POST /api/session. Kolab checks it is an open session of a
 * person's and keeps it in an HttpOnly, SameSite=Strict session cookie, so the page's script never
 * holds it. Behind the TLS proxy the cookie is `__Host-konjir_session` (Secure, Path=/, no Domain),
 * so no other host under the same domain can set one in its place; on loopback it is
 * `konjir_session`, scoped to /api. Every call checks the session again, as /mcp does, so a session
 * that ends signs the page out; signing out ends the session.
 *
 * Every /api request must also name a host Kolab serves (loopback names, or its public host behind
 * the TLS proxy), as /mcp's DNS-rebinding guard requires, and a request that changes anything must
 * come from Kolab's own origin.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const cookieName = (options: WebOptions) => (options.publicHost ? '__Host-konjir_session' : 'konjir_session');

/** The session token a request's cookie carries, if any. */
export function tokenOf(req: Request, options: WebOptions): string | undefined {
  const name = cookieName(options);
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

/** A session cookie: the browser forgets it when it closes, and signing out ends the session itself. */
export function setSessionCookie(res: Response, token: string, options: WebOptions) {
  const scope = options.publicHost ? 'Path=/; Secure' : 'Path=/api';
  res.setHeader('set-cookie', `${cookieName(options)}=${encodeURIComponent(token)}; ${scope}; HttpOnly; SameSite=Strict`);
}

export function clearSessionCookie(res: Response, options: WebOptions) {
  const scope = options.publicHost ? 'Path=/; Secure' : 'Path=/api';
  res.setHeader('set-cookie', `${cookieName(options)}=; ${scope}; HttpOnly; SameSite=Strict; Max-Age=0`);
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
    @Inject(WEB_OPTIONS) options: WebOptions,
  ) {
    this.isAdmin = adminTokenMatcher(options.adminToken);
  }

  async check(token: string | undefined): Promise<WebMe> {
    if (token && this.isAdmin(token)) {
      throw new UnauthorizedException({ error: 'unauthorized', message: 'the admin token works in no kolab: sign in with your own session token, one kolab and one role' });
    }
    const signIn = 'sign in with your Konjir session token';
    if (!token || !(await this.kolab.sessionOpen(token))) throw new UnauthorizedException({ error: 'unauthorized', message: signIn });
    let i;
    try { i = await this.kolab.sessionInfo(token); } catch { throw new UnauthorizedException({ error: 'unauthorized', message: `your session has ended: ${signIn}` }); }
    if (i.kind !== 'person') {
      throw new ForbiddenException({ error: 'forbidden', message: `that is ${i.actor}'s session, an agent's: the web interface is for people, and an agent works through MCP or the konjir CLI. Sign in with your own token` });
    }
    const a = await this.kolab.actor(i.actor);
    return { actor: i.actor, name: a.name, kind: i.kind, owner: i.owner, role: i.role as WebMe['role'], layer: i.layer, kolab: i.kolab, access: i.access };
  }
}

/** Requests the guard has let through carry their session here. Never log it: it is the bearer token. */
type Signed = Request & { konjirSession?: string; konjirMe?: WebMe };

/** Every /api call but signing in: a known host, Kolab's own origin for changes, and a person's open session. */
@Injectable()
export class WebSessionGuard implements CanActivate {
  constructor(
    @Inject(WebPeople) private readonly people: WebPeople,
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Signed>();
    checkOrigin(req, this.options);
    const token = tokenOf(req, this.options);
    req.konjirMe = await this.people.check(token);
    req.konjirSession = token;
    return true;
  }
}

/** The session a guarded request carries. */
export const WebSession = createParamDecorator((_: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Signed>().konjirSession!);

/** Who the guarded request's session is, as the guard found it. */
export const WebWho = createParamDecorator((_: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Signed>().konjirMe!);
