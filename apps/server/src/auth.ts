import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OAuthError, OAuthErrorCode, type McpAuthInfo, type McpAuthStrategy, type McpListenStream, type McpListenStreamRefusal } from '@onivoro/server-mcp';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { Kolab, maskTokens, sessionKey } from '@konjir/engine';
import { KOLAB, SERVER_OPTIONS, type ServerOptions } from './tokens.js';

/**
 * Identity rides the transport, not the tool arguments: every request carries
 * `Authorization: Bearer <token>`. An agent token is an open session (one actor, one
 * active role), with the `agent` scope; the admin token has the `admin` scope.
 *
 * Konjir's tokens don't expire yet (P2 replaces them), but the transport requires an
 * expiry on every verified token. The session is checked against the database on every
 * request, so each verification is given a short expiry of its own.
 */
@Injectable()
export class KonjirAuth implements McpAuthStrategy, OAuthTokenVerifier {
  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(SERVER_OPTIONS) options: ServerOptions,
  ) {
    this.adminDigest = createHash('sha256').update(options.adminToken).digest();
  }

  /** The admin token's digest, compared in constant time: equal-length buffers, whatever was sent. */
  private readonly adminDigest: Buffer;

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    if (this.isAdmin(token)) return { token, clientId: 'admin', scopes: ['admin'], expiresAt };
    if (!(await this.kolab.sessionOpen(token))) throw new OAuthError(OAuthErrorCode.InvalidToken, 'missing or invalid Konjir token');
    // The client is named by the session's key, never its token, so nothing that logs a principal logs a token.
    return { token, clientId: sessionKey(token), scopes: ['agent'], expiresAt };
  }

  private isAdmin(token: string) {
    return timingSafeEqual(createHash('sha256').update(token).digest(), this.adminDigest);
  }

  /**
   * The gate on each subscriptions/listen stream, as it opens (API4, D41): the admin token's
   * streams pass; an agent's only while its session is open. A session ended since its request
   * was verified is refused in-band (JSON-RPC -32003, `data.reason` 'session_ended'), which
   * Kolab's own clients, the channel bridge and `konjir watch`, treat as the token revoked, as
   * they do a 401. If the check itself fails, the package refuses the stream as 'gate_failed'
   * (or 'gate_timeout' after 10 s), which they treat as worth retrying. The stream is already
   * tracked while this runs, so a session that ends now or later still has it closed
   * (ListenStreams).
   */
  async acceptListenStream(s: McpListenStream): Promise<true | McpListenStreamRefusal> {
    const auth = s.authInfo;
    if (auth?.scopes.includes('admin')) return true;
    let open: boolean;
    try {
      open = !!auth && await this.kolab.sessionOpen(auth.token);
    } catch (e) {
      // The package logs a failed gate's message (and refuses with gate_failed): never with a token in it.
      throw new Error(`could not check the listening session: ${maskTokens(e)}`);
    }
    return open || { reason: 'session_ended' };
  }

  /** The verified auth is already Konjir's; tools read the session from it. */
  resolveAuth(authInfo: McpAuthInfo | undefined) {
    return authInfo;
  }
}
