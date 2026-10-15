/** Injection tokens. Every dependency is injected by token, not by its type's metadata:
 * tsx (esbuild) doesn't emit decorator metadata, so type-based injection would break there. */
export const KOLAB = Symbol('KOLAB');
export const SERVER_OPTIONS = Symbol('SERVER_OPTIONS');

export interface ServerOptions {
  /** The token that may add actors and open sessions. */
  adminToken: string;
}
