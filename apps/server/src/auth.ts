import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { OAuthError, OAuthErrorCode, type McpAuthInfo, type McpAuthStrategy, type McpListenStream, type McpListenStreamRefusal } from '@onivoro/server-mcp';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { Kolab, maskTokens } from '@konjir/engine';
import { KOLAB, SERVER_OPTIONS, type ServerOptions } from './tokens.js';

/**
 * Whether a token is the admin token, compared in constant time: the digests are equal-length
 * buffers, whatever was sent. The MCP endpoint and the web interface both use it.
 */
export function adminTokenMatcher(adminToken: string): (token: string) => boolean {
  const digest = createHash('sha256').update(adminToken).digest();
  return (token) => timingSafeEqual(createHash('sha256').update(token).digest(), digest);
}

/**
 * Identity rides the transport, not the tool arguments: every request carries
 * `Authorization: Bearer <token>`. An agent token reaches an open session (one actor, one
 * active role, one kolab), with the `agent` scope; the admin token has the `admin` scope.
 *
 * A session's token is either an OAuth access token (D55), which expires 15 minutes after it is
 * issued or refreshed, or, during the transition, a hand-issued token (konjir_admin_open_session),
 * which doesn't, and which `handIssuedTokens: false` turns off. The session is checked against
 * the database on every request, so each verification is given a short expiry of its own, never
 * past the access token's. The verified client is named by the session's id, its key, which
 * stays the same as its access token rotates, and never by the token.
 */
@Injectable()
export class KonjirAuth implements McpAuthStrategy, OAuthTokenVerifier {
  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(SERVER_OPTIONS) private readonly options: ServerOptions,
  ) {
    this.isAdmin = adminTokenMatcher(options.adminToken);
  }

  private readonly isAdmin: (token: string) => boolean;

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const now = Math.floor(Date.now() / 1000);
    if (this.isAdmin(token)) return { token, clientId: 'admin', scopes: ['admin'], expiresAt: now + 300 };
    const s = await this.kolab.liveSession(token);
    if (!s) throw new OAuthError(OAuthErrorCode.InvalidToken, 'missing, expired or invalid Konjir token');
    if (!s.granted && this.options.handIssuedTokens === false) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'hand-issued Konjir tokens are turned off here: connect with OAuth');
    }
    const expiresAt = Math.min(now + 300, s.expiresAt ? Math.floor(s.expiresAt.getTime() / 1000) : Infinity);
    return { token, clientId: s.id, scopes: ['agent'], expiresAt };
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
