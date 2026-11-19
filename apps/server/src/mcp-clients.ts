import type { NextFunction, Request, Response } from 'express';
import { log, type Logger } from '@konjir/log';

/** Where a 2026-07-28 request carries its client's name and version: in its `_meta`, on every request. */
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/** The most of a name or a version a line keeps: the client chooses them. */
const MAX_LENGTH = 100;

const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_LENGTH) : null);

/**
 * Logs who connects to /mcp: at each `initialize` (a 2025-era client) and each `server/discover`
 * (a 2026-07-28 client, which sends it as it connects, in place of initialize), once it is answered
 * 2xx, so only a request whose token verified, one info line, event `mcp_client`, with the client's
 * own `clientInfo.name` and `clientInfo.version` (null for one it didn't give), and nothing else of
 * the request. So which clients still connect, and at which versions, can be counted from the logs
 * (CloudWatch Logs Insights: `filter event = "mcp_client" | stats count() by client_name,
 * client_version`): before the server changes anything a released client depends on, such as
 * the words of an error published konnect recognises (docs/plans/rebrand-and-site.md).
 *
 * It only reads the parsed body and listens for the answer: it changes nothing a request gets.
 */
export function mcpClients(logger: Logger = log) {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as { method?: unknown; params?: { clientInfo?: unknown; _meta?: Record<string, unknown> } } | undefined;
    if (body && typeof body === 'object' && !Array.isArray(body) && (body.method === 'initialize' || body.method === 'server/discover')) {
      const info = (body.params?.clientInfo ?? body.params?._meta?.[CLIENT_INFO_META_KEY]) as { name?: unknown; version?: unknown } | undefined;
      const client_name = text(info?.name);
      const client_version = text(info?.version);
      res.once('finish', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        logger.info(`an MCP client connected: ${client_name ?? '(unnamed)'} ${client_version ?? '(no version)'}`, { event: 'mcp_client', client_name, client_version });
      });
    }
    next();
  };
}
