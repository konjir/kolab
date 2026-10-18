/** Injection tokens. Every dependency is injected by token, not by its type's metadata:
 * tsx (esbuild) doesn't emit decorator metadata, so type-based injection would break there. */
export const KOLAB = Symbol('KOLAB');
export const SERVER_OPTIONS = Symbol('SERVER_OPTIONS');

export interface ServerOptions {
  /** The token that may add actors and open sessions. */
  adminToken: string;
  /**
   * Whether hand-issued session tokens (konjir_admin_open_session's, which never expire) still
   * work, beside OAuth's access tokens (D55). True during the transition; false turns them off,
   * on /mcp and in the web interface. The admin token works either way.
   */
  handIssuedTokens?: boolean;
}

/** Who this server says it is, in its MCP metadata and in the listen results it sends itself. */
export const SERVER_INFO = { name: 'konjir', version: '0.6.0' };

/** The MCP endpoint's route, as McpHttpModule is registered with it. */
export const MCP_ROUTE = 'mcp';

export const OAUTH_OPTIONS = Symbol('OAUTH_OPTIONS');

/** Kolab's authorization server's settings (D55). */
export interface OAuthOptions {
  /** Who signs people in: GitHub on the test server. Without one, Kolab has no OAuth, and only hand-issued tokens work. */
  identity?: import('./oauth/identity.js').IdentityProvider;
  /** The public hostname behind the TLS proxy: the issuer's and the resource's origin. */
  publicHost?: string;
}

export const WEB_OPTIONS = Symbol('WEB_OPTIONS');

/** The web interface's settings (W3.1). */
export interface WebOptions {
  /** The admin token, which works in no kolab, so it never signs in to the web interface. */
  adminToken: string;
  /** The public hostname behind the TLS proxy: its pages' origin, and the cookie is Secure. */
  publicHost?: string;
  /** How often an event stream checks its kolab's versions for commits, in ms (3 s by default). */
  versionsPollMs?: number;
  /** Whether a person may sign in by pasting a session token (development); otherwise only with the identity provider. */
  tokenSignIn: boolean;
  /** The identity provider's name for the sign-in button, when there is one (D55). */
  identityLabel?: string;
  /** As ServerOptions.handIssuedTokens. */
  handIssuedTokens: boolean;
}
