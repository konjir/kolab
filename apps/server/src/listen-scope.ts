import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { verifyBearerToken } from '@modelcontextprotocol/server';
import { MCP_LISTEN_STREAM_REFUSED, McpHttpService } from '@onivoro/server-mcp';
import { Kolab, maskTokens } from '@konjir/engine';
import { KOLAB } from './tokens.js';
import { subscribableBy } from './uris.js';

type Req = { body?: unknown; headers: { authorization?: string } };

/** How long the session lookup may take before the stream is refused as gate_timeout, as the transport's gate does. */
export const SCOPE_TIMEOUT_MS = 10_000;

/**
 * The transport's own DNS-rebinding guard (McpHttpService's isHostAllowed and isOriginAllowed),
 * which it runs before anything else. They aren't in its public types, so ListenScope checks they
 * exist when it is made: a release of @onivoro/server-mcp without them stops Kolab starting
 * rather than let this answer a request the guard would have refused.
 */
type HostGuard = { isHostAllowed(req: Req): boolean; isOriginAllowed(req: Req): boolean };
type Res = { writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown };

/** The refusal's `data.reason`: the stream asked for a resource its session can't subscribe to. */
export const NOT_SUBSCRIBABLE = 'not_subscribable';

/**
 * Reads the bearer token from an Authorization header exactly as the transport does, by its own
 * verifyBearerToken, so this never checks one token while the transport verifies another. The
 * token is only parsed here; the transport verifies it.
 */
const tokenOf = (header: string | undefined) => verifyBearerToken(header, {
  verifier: { verifyAccessToken: async (token) => ({ token, clientId: '', scopes: [], expiresAt: Number.MAX_SAFE_INTEGER }) },
}).then((a) => a.token, () => undefined);

/**
 * A subscriptions/listen stream may subscribe only to its own session's resources (D50, TEN12):
 * each layer's inbox in the session's kolab, and its own answers there. Kolab signals each
 * kolab's changes on that kolab's URIs alone, so a session that could name another kolab's
 * inbox would hear when that kolab changes: this refuses it, before the stream opens, in-band
 * as the transport refuses a stream (JSON-RPC -32003), with `data.reason` 'not_subscribable'.
 *
 * Middleware, because neither the transport nor its listen-stream gate shows Kolab the URIs a
 * stream asks for. It only ever refuses, and only what the transport would have let through to
 * the stream: a request its Host/Origin guard refuses, one with no valid request id, or one it
 * can't place (no session, an ended one, the admin token, anything but a listen) goes on to the
 * transport, which refuses or authenticates it and gates the stream as before (KonjirAuth). So a
 * blocked origin can't probe sessions here. The admin token may subscribe to anything. The
 * session lookup is bounded: past SCOPE_TIMEOUT_MS the stream is refused as gate_timeout.
 *
 * It covers subscriptions/listen alone, which holds only while the transport is stateless: a
 * 2025-era resources/subscribe needs a session (McpHttpModule's `session`), and would bypass
 * this. apps/cli/test/listen.test.ts pins that down.
 */
@Injectable()
export class ListenScope implements NestMiddleware {
  private readonly logger = new Logger(ListenScope.name);

  private readonly guard: HostGuard;

  constructor(@Inject(KOLAB) private readonly kolab: Kolab, @Inject(McpHttpService) mcp: McpHttpService) {
    const guard = mcp as unknown as Partial<HostGuard>;
    if (typeof guard.isHostAllowed !== 'function' || typeof guard.isOriginAllowed !== 'function') {
      throw new Error('ListenScope needs @onivoro/server-mcp\'s Host/Origin guard (McpHttpService.isHostAllowed, isOriginAllowed), which this release lacks');
    }
    this.guard = guard as HostGuard;
  }

  async use(req: Req, res: Res, next: (e?: unknown) => void) {
    const body = req.body as { id?: unknown; method?: unknown; params?: { notifications?: { resourceSubscriptions?: unknown } } } | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.method !== 'subscriptions/listen') return next();
    // The transport refuses these itself: a blocked Host or Origin with 403, and a bad id with 400.
    if (!this.guard.isHostAllowed(req) || !this.guard.isOriginAllowed(req)) return next();
    if (typeof body.id !== 'string' && typeof body.id !== 'number') return next();
    const asked = body.params?.notifications?.resourceSubscriptions;
    if (!Array.isArray(asked) || !asked.length) return next();
    const token = await tokenOf(req.headers.authorization);
    if (!token) return next();
    let scope: Awaited<ReturnType<Kolab['sessionScope']>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), SCOPE_TIMEOUT_MS); timer.unref(); });
      const found = await Promise.race([this.kolab.sessionScope(token), timedOut]);
      if (found === 'timeout') {
        this.logger.warn(`could not check which resources a listening session may subscribe to within ${SCOPE_TIMEOUT_MS} ms, so its stream was refused`);
        return refuse(res, body.id, 'gate_timeout', 'Kolab could not check the session in time; retry');
      }
      scope = found;
    } catch (e) {
      // Fail closed, as the gate does when it can't check a session, and log it without a token.
      this.logger.warn(`could not check which resources a listening session may subscribe to, so its stream was refused: ${maskTokens(e)}`);
      return refuse(res, body.id, 'gate_failed', 'Kolab could not check the session just now; retry');
    } finally {
      clearTimeout(timer);
    }
    // Not an open session's token: the admin token, or one the transport will refuse.
    if (!scope) return next();
    const allowed = new Set(subscribableBy(scope.kolab, scope.actor));
    const refused = asked.filter((u) => typeof u !== 'string' || !allowed.has(u));
    if (!refused.length) return next();
    return refuse(res, body.id, NOT_SUBSCRIBABLE,
      'a session can subscribe only to its own kolab\'s inboxes and its own answers there, as konjir_whoami lists them');
  }
}

function refuse(res: Res, id: string | number, reason: string, detail: string) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: MCP_LISTEN_STREAM_REFUSED, message: 'Listen stream refused', data: { reason, detail } },
  }));
}
