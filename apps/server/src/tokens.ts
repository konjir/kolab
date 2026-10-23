/** Injection tokens. Every dependency is injected by token, not by its type's metadata:
 * tsx (esbuild) doesn't emit decorator metadata, so type-based injection would break there. */
export const KOLAB = Symbol('KOLAB');
export const SERVER_OPTIONS = Symbol('SERVER_OPTIONS');

export interface ServerOptions {
  /**
   * The break-glass admin token (W2.22, D69): it runs every admin verb, each use recorded. Null
   * disables it, and then the last live Konjir admin can't be removed or archived.
   */
  adminToken: string | null;
  /**
   * Whether hand-issued session tokens (konjir_admin_open_session's, which expire after 30 days by default, W2.22) still
   * work, beside OAuth's access tokens (D55). True during the transition; false turns them off,
   * on /mcp and in the web interface. The admin token works either way.
   */
  handIssuedTokens?: boolean;
  /**
   * This Kolab's own origin, `https://<public host>` or its loopback address, which startServer
   * sets once it listens: where konjir_admin_elevate's raise link points (W2.22).
   */
  origin?: string;
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
  /** The break-glass admin token, which works in no kolab, so it never signs in to the web interface; null when disabled. */
  adminToken: string | null;
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
  /** The published konjir CLI's npm spec, pinned (`konjir@1.2.3`), when there is one (W3.7); otherwise the page never shows `npx`. */
  cliNpmSpec?: string;
}
