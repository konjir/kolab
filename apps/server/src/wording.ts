import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Which name the server's errors give the CLI's commands (step 1b of docs/plans/rebrand-and-site.md).
 *
 * Published clients read some of Kolab's errors by their words: every konnect up to 0.8.0 turns
 * `run konjir connect again` and `konjir connect` in a setup's errors into its own command, and
 * `kolab <name>` in some refusals into `team <name>`; konjir up to 0.8.0 knows a sign-in to renew by
 * `run konjir login`. So an error keeps the command's old name, `konjir <command>`, as it always
 * has (`konjir`), unless the client asking says it is the kolab CLI, which opts in to its own
 * name, `kolab <command>` (`kolab`). It can't be the other way round: an older client never says
 * which it is in a way the server could rely on (every published konnect says `konnect 0.1.0`, and
 * its sign-in `konjir-cli 0.6.0`). Everything else the server says to a person or an agent (its
 * instructions, playbooks, tools' descriptions, hints) says `kolab` to everyone, since no client
 * reads it by its words.
 *
 * Only the command's name changes: `konjir_<verb>` tools, `kj:` and `konjir://` addresses,
 * `konjir kolab:…` scopes, and phrasing about kolabs (`only the owner of kolab …`, `is not a member
 * of kolab …`) stay word for word, for every client.
 */
export type Wording = 'konjir' | 'kolab';

/** The name the kolab CLI, and its channel, give as MCP's clientInfo (apps/channel-bridge/src/words.ts, KOLAB_CLIENT). */
export const KOLAB_CLIENT_NAME = 'kolab';

/** Where a 2026-07-28 request carries its client's name and version: in its `_meta`, on every request. */
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/**
 * The clientInfo a JSON-RPC request to /mcp carries, as the client gave it: a 2025-era initialize's
 * `params.clientInfo`, or the `_meta` envelope a 2026-07-28 client sends on every request (its
 * server/discover, and each call after). Undefined for a batch, or a request with neither.
 */
export function clientInfoOf(body: unknown): { name?: unknown; version?: unknown } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const params = (body as { params?: { clientInfo?: unknown; _meta?: Record<string, unknown> } }).params;
  if (!params || typeof params !== 'object') return undefined;
  const info = params.clientInfo ?? (params._meta && typeof params._meta === 'object' ? params._meta[CLIENT_INFO_META_KEY] : undefined);
  return info && typeof info === 'object' ? info as { name?: unknown; version?: unknown } : undefined;
}

/** The wording for an MCP client, by the name it gives: `kolab` only for the kolab CLI, exactly. */
export const mcpWording = (name: unknown): Wording => (name === KOLAB_CLIENT_NAME ? 'kolab' : 'konjir');

/**
 * The wording for an OAuth client, by the name it registered with (its `client_name`), which is all
 * an OAuth page or endpoint knows of it: `kolab` for the kolab CLI's (`kolab CLI`, `kolab connect`,
 * `kolab channel (Claude Code)`), `konjir` for any other, published konjir's (`konjir CLI`, `konjir
 * connect`…) and konnect's (`konnect`, `konnect agent`) among them. None, or an unregistered client: `konjir`.
 */
export const oauthWording = (registeredName: string | null | undefined): Wording =>
  (typeof registeredName === 'string' && /^kolab( |$)/.test(registeredName) ? 'kolab' : 'konjir');

/**
 * The CLI's commands an error may name, `konjir <command>`: its own commands, and a verb run through
 * it, which has an underscore (`konjir archive_agent label=…`). Not `konjir kolab:…` (a scope), nor
 * `konjir_<verb>` (a tool). The same list as the CLI's own rewording (apps/channel-bridge/src/words.ts,
 * KOLAB_COMMANDS), which apps/cli/test/server-wording.test.ts holds equal to it.
 */
export const COMMANDS = ['login', 'logout', 'connect', 'import', 'work', 'instructions', 'watch', 'claude', 'bridge', 'repo', 'serve', 'tools', 'help', 'status', 'whoami'];
const KONJIR_COMMAND = new RegExp(`\\bkonjir (${COMMANDS.join('|')}|[a-z]+(?:_[a-z]+)+)\\b(?!:)`, 'g');

/** `text` as `wording` says it: for `kolab`, each `konjir <command>` said `kolab <command>`; for `konjir`, as it is. */
export const worded = (text: string, wording: Wording): string => (wording === 'kolab' ? text.replace(KONJIR_COMMAND, 'kolab $1') : text);

/** The wording of the MCP request being answered, which McpWording sets; `konjir` outside one. */
const CURRENT = new AsyncLocalStorage<Wording>();

/** The wording of the MCP request being answered now: `konjir` unless it came from the kolab CLI. */
export const currentWording = (): Wording => CURRENT.getStore() ?? 'konjir';

/**
 * Sets the wording of each request to /mcp from the clientInfo it carries, for everything that
 * answers it (fail, results.ts). A 2026-07-28 client sends its clientInfo on every request, so its
 * calls are worded for it; a 2025-era client sends it only at initialize, and the transport is
 * stateless, so its later calls get the old wording, as any client that doesn't opt in does. The
 * kolab CLI and its channel speak 2026-07-28 to Kolab.
 */
export function mcpWordingMiddleware(req: Request, _res: Response, next: NextFunction) {
  CURRENT.run(mcpWording(clientInfoOf(req.body)?.name), () => next());
}

@Injectable()
export class McpWording implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    mcpWordingMiddleware(req, res, next);
  }
}
