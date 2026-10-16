/** Injection tokens. Every dependency is injected by token, not by its type's metadata:
 * tsx (esbuild) doesn't emit decorator metadata, so type-based injection would break there. */
export const KOLAB = Symbol('KOLAB');
export const SERVER_OPTIONS = Symbol('SERVER_OPTIONS');

export interface ServerOptions {
  /** The token that may add actors and open sessions. */
  adminToken: string;
}

/** Who this server says it is, in its MCP metadata and in the listen results it sends itself. */
export const SERVER_INFO = { name: 'konjir', version: '0.6.0' };

/** The MCP endpoint's route, as McpHttpModule is registered with it. */
export const MCP_ROUTE = 'mcp';
