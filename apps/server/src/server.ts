import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { Kolab } from '@konjir/engine';
import { KolabServerModule } from './kolab-server.module.js';

export { INSTRUCTIONS, REVIEWER_INSTRUCTIONS } from './instructions.js';
export { answersUri, inboxUri, uriOf } from './uris.js';

export interface KonjirServer { url: string; kolab: Kolab; close(): Promise<void> }

export async function startServer(opts: {
  port?: number; host?: string; dataDir?: string; adminToken: string; kolab?: Kolab;
  /** Postgres to store in. Without it, PGlite in `dataDir`, or in memory. */
  databaseUrl?: string;
  /** The public hostname a TLS proxy serves this kolab on (e.g. kolab.konjir.com). Accepted alongside localhost. */
  publicHost?: string;
}): Promise<KonjirServer> {
  const kolab = opts.kolab ?? await Kolab.open({ dataDir: opts.dataDir, databaseUrl: opts.databaseUrl });
  const app = await NestFactory.create(
    KolabServerModule.register({ kolab, adminToken: opts.adminToken, publicHost: opts.publicHost }),
    { logger: ['error', 'warn'] },
  );
  const host = opts.host ?? '127.0.0.1';
  await app.listen(opts.port ?? 0, host);
  // Its own Kolab runs the outbox (REV3, W1.8): at once, for work a stopped process left, then as
  // jobs fall due. A Kolab given to it is its owner's to start.
  if (!opts.kolab) kolab.startWorker();
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
