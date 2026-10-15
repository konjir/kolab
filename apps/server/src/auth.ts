import { Inject, Injectable } from '@nestjs/common';
import { OAuthError, OAuthErrorCode, type McpAuthInfo, type McpAuthStrategy } from '@onivoro/server-mcp';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { Kolab } from '@konjir/engine';
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
    @Inject(SERVER_OPTIONS) private readonly options: ServerOptions,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    if (token === this.options.adminToken) return { token, clientId: 'admin', scopes: ['admin'], expiresAt };
    const s = await this.kolab.db.query(`select 1 from session where id = $1 and ended_at is null`, [token]);
    if (!s.rows.length) throw new OAuthError(OAuthErrorCode.InvalidToken, 'missing or invalid Konjir token');
    return { token, clientId: token, scopes: ['agent'], expiresAt };
  }

  /** The verified auth is already Konjir's; tools read the session from it. */
  resolveAuth(authInfo: McpAuthInfo | undefined) {
    return authInfo;
  }
}
