import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { Kolab } from '@konjir/engine';
import { JsonNestLogger, serverErrors } from './json-logger.js';
import { MAX_REQUEST_BYTES } from '@konjir/types';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { KolabServerModule } from './kolab-server.module.js';
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
  port?: number; host?: string; dataDir?: string; adminToken: string; kolab?: Kolab;
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
  // One limit on every request body, the MCP endpoint's and the web API's alike (W2.21): room for
  // the largest version Kolab takes (MAX_VERSION_BYTES), and a clear refusal past it.
  app.useBodyParser('json', { limit: MAX_REQUEST_BYTES });
  app.useBodyParser('urlencoded', { limit: MAX_REQUEST_BYTES, extended: true });
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
  let closing: Promise<void> | undefined;
  return {
    url: opts.publicHost ? `https://${opts.publicHost}/mcp` : `http://${host}:${port}/mcp`,
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
 * A request body over MAX_REQUEST_BYTES, refused with a message that names the limit: as a JSON-RPC
 * error on the MCP endpoint, so a client shows it, and as the web API's error elsewhere.
 */
function tooLarge(err: unknown, req: { path?: string }, res: { status(n: number): { json(b: unknown): void }; headersSent?: boolean }, next: (e?: unknown) => void) {
  const e = err as { type?: string; status?: number } | undefined;
  if (e?.type !== 'entity.too.large' || res.headersSent) return next(err);
  const message = `the request is over ${MAX_REQUEST_BYTES / (1024 * 1024)} MiB, the most Kolab takes in one call: send less at once (a version holds at most 512 KiB of text)`;
  if (req.path?.startsWith('/mcp')) res.status(413).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } });
  else res.status(413).json({ error: 'too_large', message });
}
