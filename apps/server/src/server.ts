import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation } from '@modelcontextprotocol/node';
import { NestFactory } from '@nestjs/core';
import { Kolab } from '@konjir/engine';
import type { Reviewer } from '@konjir/types';
import { KolabServerModule } from './kolab-server.module.js';

export { INSTRUCTIONS } from './instructions.js';
export { answersUri, inboxUri, uriOf } from './uris.js';

export interface KonjirServer { url: string; kolab: Kolab; close(): Promise<void> }

export async function startServer(opts: {
  port?: number; host?: string; dataDir?: string; adminToken: string; kolab?: Kolab; reviewer?: Reviewer;
  /** Postgres to store in. Without it, PGlite in `dataDir`, or in memory. */
  databaseUrl?: string;
  /** The public hostname a TLS proxy serves this kolab on (e.g. kolab.konjir.com). Accepted alongside localhost. */
  publicHost?: string;
}): Promise<KonjirServer> {
  const kolab = opts.kolab ?? await Kolab.open({ dataDir: opts.dataDir, databaseUrl: opts.databaseUrl, reviewer: opts.reviewer });
  const app = await NestFactory.create(
    KolabServerModule.register({ kolab, adminToken: opts.adminToken, publicHost: opts.publicHost }),
    { logger: ['error', 'warn'] },
  );
  const host = opts.host ?? '127.0.0.1';
  // DNS-rebinding guard: only our own hostnames, and no browser origin but our own.
  if (host === '127.0.0.1' || host === 'localhost' || opts.publicHost) {
    const allowed = ['localhost', '127.0.0.1', '[::1]', ...(opts.publicHost ? [opts.publicHost] : [])];
    const validateHost = opts.publicHost ? hostHeaderValidation(allowed) : localhostHostValidation();
    const validateOrigin = opts.publicHost ? originValidation(allowed) : localhostOriginValidation();
    app.use('/mcp', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      if (validateHost(req, res) && validateOrigin(req, res)) next();
    });
  }
  await app.listen(opts.port ?? 0, host);
  const http = app.getHttpServer() as HttpServer;
  const { port } = http.address() as AddressInfo;
  return {
    url: opts.publicHost ? `https://${opts.publicHost}/mcp` : `http://${host}:${port}/mcp`,
    kolab,
    async close() {
      // Listen streams stay open until the client goes; end them so close doesn't wait on them.
      http.closeAllConnections();
      await app.close();
      if (!opts.kolab) await kolab.close();
    },
  };
}
