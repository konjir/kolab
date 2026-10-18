import {
  type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Kolab } from '@konjir/engine';
import { KOLAB, WEB_OPTIONS, type WebOptions } from '../tokens.js';

/**
 * How a person signs in to the web interface (W3.1). Until OAuth is bound (RUN3, P2), a person
 * signs in with a Konjir session token, the same bearer token an agent's harness holds: one actor,
 * one kolab, one role (ENF4, ENF5), opened by an admin (`konjir admin_open_session`, or
 * `deploy/konjir-ops.sh connect`). The page posts it once to POST /api/session; Kolab checks it is
 * an open session and keeps it in an HttpOnly, SameSite=Strict cookie scoped to /api, so the
 * page's script never holds it and other sites' pages can't send it. Every call checks the session
 * again, as /mcp does, so a session that ends signs the page out.
 *
 * Every /api request must also name a host Kolab serves (loopback names, or its public host behind
 * the TLS proxy), as /mcp's DNS-rebinding guard requires, and a request that changes anything must
 * come from Kolab's own origin.
 */
export const COOKIE = 'konjir_session';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The session token a request's cookie carries, if any. */
export function tokenOf(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
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

export function setSessionCookie(res: Response, token: string, options: WebOptions) {
  res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}${options.publicHost ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: Response, options: WebOptions) {
  res.setHeader('set-cookie', `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${options.publicHost ? '; Secure' : ''}`);
}

/** Requests the guard has let through carry their session here. Never log it: it is the bearer token. */
type Signed = Request & { konjirSession?: string };

/** Every /api call but signing in: a known host, Kolab's own origin for changes, and an open session. */
@Injectable()
export class WebSessionGuard implements CanActivate {
  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Signed>();
    checkOrigin(req, this.options);
    const token = tokenOf(req);
    if (!token || token === this.options.adminToken || !(await this.kolab.sessionOpen(token))) {
      throw new UnauthorizedException({ error: 'unauthorized', message: 'sign in with your Konjir session token' });
    }
    req.konjirSession = token;
    return true;
  }
}

/** The session a guarded request carries. */
export const WebSession = createParamDecorator((_: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Signed>().konjirSession!);
