import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { verifyBearerToken } from '@modelcontextprotocol/server';
import { MCP_LISTEN_STREAM_REFUSED } from '@onivoro/server-mcp';
import { Kolab, maskTokens } from '@konjir/engine';
import { KOLAB } from './tokens.js';
import { subscribableBy } from './uris.js';

type Req = { body?: unknown; headers: { authorization?: string } };
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
 * stream asks for. It only ever refuses: a request it can't place (no session, an ended one,
 * the admin token, anything but a listen) goes on to the transport, which authenticates it and
 * gates the stream as before (KonjirAuth). The admin token may subscribe to anything.
 */
@Injectable()
export class ListenScope implements NestMiddleware {
  private readonly logger = new Logger(ListenScope.name);

  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  async use(req: Req, res: Res, next: (e?: unknown) => void) {
    const body = req.body as { id?: unknown; method?: unknown; params?: { notifications?: { resourceSubscriptions?: unknown } } } | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.method !== 'subscriptions/listen') return next();
    const asked = body.params?.notifications?.resourceSubscriptions;
    if (!Array.isArray(asked) || !asked.length) return next();
    const token = await tokenOf(req.headers.authorization);
    if (!token) return next();
    let scope: Awaited<ReturnType<Kolab['sessionScope']>>;
    try {
      scope = await this.kolab.sessionScope(token);
    } catch (e) {
      // Fail closed, as the gate does when it can't check a session, and log it without a token.
      this.logger.warn(`could not check which resources a listening session may subscribe to, so its stream was refused: ${maskTokens(e)}`);
      return refuse(res, body.id, 'gate_failed', 'Kolab could not check the session just now; retry');
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

function refuse(res: Res, id: unknown, reason: string, detail: string) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code: MCP_LISTEN_STREAM_REFUSED, message: 'Listen stream refused', data: { reason, detail } },
  }));
}
