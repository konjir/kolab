import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { Kolab } from '@konjir/engine';
import { JsonNestLogger, serverErrors } from './json-logger.js';
import { MAX_REQUEST_BYTES, MAX_SMALL_REQUEST_BYTES, REFRESH_HEADER } from '@konjir/types';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { KonjirAuth } from './auth.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { KolabServerModule } from './kolab-server.module.js';
import { SERVER_OPTIONS, type ServerOptions } from './tokens.js';
import type { IdentityProvider } from './oauth/identity.js';
import { defaultWebRoot, webApp } from './web/static.js';

export { INSTRUCTIONS, REVIEWER_INSTRUCTIONS } from './instructions.js';
export { answersUri, inboxUri, uriOf } from './uris.js';
export { isPinnedNpmSpec } from './kolab-server.module.js';
// Kolab's JSON log lines (P11, D68), for `konjir serve`'s own lines: the CLI loads the server, never the library.
export { log } from '@konjir/log';
export { JsonNestLogger, serverErrors } from './json-logger.js';
export { GitHubIdentity, StubIdentity, type IdentityProvider } from './oauth/identity.js';

export interface KonjirServer { url: string; kolab: Kolab; close(): Promise<void> }

export async function startServer(opts: {
  port?: number; host?: string; dataDir?: string; kolab?: Kolab;
  /** The break-glass admin token (W2.22, D69); null disables it, leaving Konjir's admins, people who sign in, alone. */
  adminToken: string | null;
  /** Postgres to store in. Without it, PGlite in `dataDir`, or in memory. */
  databaseUrl?: string;
  /** The public hostname a TLS proxy serves this kolab on (e.g. kolab.konjir.com). Accepted alongside localhost. */
  publicHost?: string;
  /** The built web interface to serve at the root: apps/web's dist/ by default; null for none. */
  webRoot?: string | null;
  /** How often a web event stream checks its kolab's versions, in ms (3 s by default). */
  webVersionsPollMs?: number;
  /** How many kolabs a person may own when they make their own (D54; 10 by default). */
  kolabsPerPerson?: number;
  /** How many days a hand-issued session token lasts (W2.22; 30 by default, KONJIR_HAND_ISSUED_TOKEN_DAYS). */
  handIssuedTokenDays?: number;
  /** Who signs people in (D55): GitHubIdentity on the test server, StubIdentity in tests. Without one, no OAuth. */
  identity?: IdentityProvider;
  /** Whether the web interface still takes a pasted session token: by default, only without an identity provider. */
  webTokenSignIn?: boolean;
  /** Whether hand-issued session tokens still work beside OAuth's (true by default, during the transition). */
  handIssuedTokens?: boolean;
  /** The published konjir CLI's npm spec, pinned to an exact version (KONJIR_CLI_NPM_SPEC, W3.7). */
  cliNpmSpec?: string;
  /** False: apply no migration to its own Kolab's database, and refuse one that needs any (W2.24). True by default. */
  migrate?: boolean;
  /** False: its own Kolab runs no outbox worker, so it never claims or runs a job (W2.24). True by default. */
  worker?: boolean;
}): Promise<KonjirServer> {
  const kolab = opts.kolab ?? await Kolab.open({ dataDir: opts.dataDir, databaseUrl: opts.databaseUrl, migrate: opts.migrate });
  if (opts.kolabsPerPerson !== undefined) kolab.ownKolabs.max = opts.kolabsPerPerson;
  if (opts.handIssuedTokenDays !== undefined) {
    if (!(Number.isFinite(opts.handIssuedTokenDays) && opts.handIssuedTokenDays > 0 && opts.handIssuedTokenDays <= 365)) {
      throw new Error(`a hand-issued token lasts more than 0 and at most 365 days, not ${opts.handIssuedTokenDays}`);
    }
    kolab.sessions.handIssuedTtlS = Math.max(1, Math.round(opts.handIssuedTokenDays * 86_400));
  }
  const app = await NestFactory.create<NestExpressApplication>(
    KolabServerModule.register({
      kolab, adminToken: opts.adminToken, publicHost: opts.publicHost, webVersionsPollMs: opts.webVersionsPollMs,
      identity: opts.identity, webTokenSignIn: opts.webTokenSignIn, handIssuedTokens: opts.handIssuedTokens,
      cliNpmSpec: opts.cliNpmSpec,
    }),
    // Nest's lines, and the server's own Loggers', as Kolab's JSON lines, warn and error only.
    { logger: new JsonNestLogger(), bodyParser: false },
  );
  // Every 5xx answer is an error line, which the deployed stack's server-error alarm counts.
  app.use(serverErrors());
  // The MCP endpoint and the web API take bodies of up to MAX_REQUEST_BYTES (W2.21): room for the
  // largest version Kolab takes (MAX_VERSION_BYTES). Everything a caller reaches before signing in
  // keeps the small limit (MAX_SMALL_REQUEST_BYTES): the OAuth routes, the web sign-in and invites
  // (/api/session), and /mcp unless the request carries a token that verifies, which is checked
  // before its body is read, and only for a body that may be over the small limit. Past either, a
  // clear refusal. A body a parser has read isn't read again.
  const small = [json({ limit: MAX_SMALL_REQUEST_BYTES }), urlencoded({ limit: MAX_SMALL_REQUEST_BYTES, extended: true })];
  const large = [json({ limit: MAX_REQUEST_BYTES }), urlencoded({ limit: MAX_REQUEST_BYTES, extended: true })];
  app.use('/api/session', ...small);
  app.use('/api', ...large);
  // Only requests a person initiates renew a lease on their work (D100). Two kinds aren't: a read
  // the web page makes by itself after a pushed event, which says so (REFRESH_HEADER: push), and
  // opening the page's event stream, which EventSource opens and reopens by itself and can't mark.
  // Both are read quietly; the mark, or the route, only withholds a renewal, and changes nothing else.
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    const stream = req.method === 'GET' && req.path === '/events';
    if (stream || req.headers[REFRESH_HEADER] === 'push') kolab.quietly(async () => next()).catch(next);
    else next();
  });
  const auth = app.get(KonjirAuth);
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    signedIn(auth, req).then((ok) => {
      if (!ok) return next();
      large[0](req, res, (e?: unknown) => (e ? next(e) : large[1](req, res, next)));
    }, next);
  });
  app.use(...small);
  app.use(tooLarge);
  // The web interface's pages, at the root (API8); its API is the module's, under /api.
  app.use(webApp(opts.webRoot === undefined ? defaultWebRoot() : opts.webRoot));
  const host = opts.host ?? '127.0.0.1';
  await app.listen(opts.port ?? 0, host);
  // Its own Kolab runs the outbox (REV3, W1.8): at once, for work a stopped process left, then as
  // jobs fall due. A Kolab given to it is its owner's to start.
  if (!opts.kolab && opts.worker !== false) kolab.startWorker();
  const http = app.getHttpServer() as HttpServer;
  const { port } = http.address() as AddressInfo;
  const url = opts.publicHost ? `https://${opts.publicHost}/mcp` : `http://${host}:${port}/mcp`;
  // Its origin, now that it is known: where an admin's raise link points (W2.22).
  (app.get(SERVER_OPTIONS) as ServerOptions).origin = url.slice(0, -'/mcp'.length);
  let closing: Promise<void> | undefined;
  return {
    url,
    kolab,
    // Closing again, or while it's closing, waits for the same close; after a failed close, it tries again.
    close: () => (closing ??= (async () => {
      try {
        // Listen streams stay open until the client goes; end them so close doesn't wait on them.
        http.closeAllConnections();
        await app.close();
      } finally {
        // Its own Kolab, which no one else will close, even if the app's close failed.
        if (!opts.kolab) await kolab.close();
      }
    })().catch((e) => { closing = undefined; throw e; })),
  };
}

/**
 * Whether a request to /mcp may send a body over MAX_SMALL_REQUEST_BYTES: only one whose bearer
 * token verifies, as the transport will verify it after (KonjirAuth). A body declared within the
 * small limit needs no check, so most calls cost no extra lookup.
 */
async function signedIn(auth: KonjirAuth, req: Request): Promise<boolean> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) <= MAX_SMALL_REQUEST_BYTES) return false;
  const token = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return false;
  try {
    await auth.verifyAccessToken(token);
    return true;
  } catch {
    return false;
  }
}

/**
 * A request body over its limit, refused with a message that names the limit the parser applied
 * (MAX_REQUEST_BYTES or MAX_SMALL_REQUEST_BYTES): as a JSON-RPC error on the MCP endpoint, so a
 * client shows it, and as the web API's error elsewhere. Paths match as Express mounts them,
 * whatever their case.
 */
function tooLarge(err: unknown, req: { path?: string }, res: { status(n: number): { json(b: unknown): void }; headersSent?: boolean }, next: (e?: unknown) => void) {
  const e = err as { type?: string; status?: number; limit?: number } | undefined;
  if (e?.type !== 'entity.too.large' || res.headersSent) return next(err);
  const mcp = /^\/mcp(\/|$)/i.test(req.path ?? '');
  const message = e.limit === MAX_REQUEST_BYTES
    ? `the request is over ${MAX_REQUEST_BYTES / (1024 * 1024)} MiB, the most Kolab takes in one call: send less at once (a version holds at most 512 KiB of text)`
    : `the request is over ${MAX_SMALL_REQUEST_BYTES / 1024} KiB, the most Kolab takes here${mcp ? ' from a caller that hasn\'t signed in' : ''}`;
  if (mcp) res.status(413).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } });
  else res.status(413).json({ error: 'too_large', message });
}
