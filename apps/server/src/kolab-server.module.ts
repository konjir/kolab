import { Module, type DynamicModule } from '@nestjs/common';
import { McpHttpModule } from '@onivoro/server-mcp';
import type { Kolab } from '@konjir/engine';
import { AdminTools } from './admin-tools.js';
import { AgentTools } from './agent-tools.js';
import { KonjirAuth } from './auth.js';
import { HealthController } from './health.controller.js';
import { Inboxes } from './inboxes.js';
import { OperatingInstructions, SERVER_INSTRUCTIONS } from './instructions.js';
import { KOLAB, SERVER_OPTIONS, type ServerOptions } from './tokens.js';

export interface KolabServerModuleOptions extends ServerOptions {
  kolab: Kolab;
  /** The public hostname a TLS proxy serves this kolab on (e.g. kolab.konjir.com). */
  publicHost?: string;
}

/**
 * Konjir over MCP: one kolab, served by @onivoro/server-mcp as a stateless Streamable
 * HTTP endpoint at /mcp (MCP 2026-07-28, with the SDK's fallback for 2025-era clients),
 * plus GET /healthz.
 */
@Module({})
export class KolabServerModule {
  static register(options: KolabServerModuleOptions): DynamicModule {
    const { kolab, publicHost, ...serverOptions } = options;
    return {
      module: KolabServerModule,
      imports: [
        McpHttpModule.registerAndServeHttp({
          metadata: { name: 'konjir', version: '0.6.0', instructions: SERVER_INSTRUCTIONS },
          authStrategy: KonjirAuth,
          requireBearerAuth: true,
          // Agents don't see the admin verbs; the admin token sees everything.
          toolVisibility: 'authorized',
          exposeErrorMessages: false,
          // DNS-rebinding guard. Locally, a loopback host name on any port, whatever forwarding headers
          // say, and no browser origin but our own; behind the TLS proxy, its host name or loopback.
          ...(publicHost
            ? { allowedHosts: [publicHost, 'localhost', '127.0.0.1', '[::1]'], allowedOrigins: [`https://${publicHost}`] }
            : { trustForwardedHosts: false }),
        }),
      ],
      controllers: [HealthController],
      providers: [
        { provide: KOLAB, useValue: kolab },
        { provide: SERVER_OPTIONS, useValue: serverOptions },
        KonjirAuth,
        AgentTools,
        AdminTools,
        Inboxes,
        OperatingInstructions,
      ],
    };
  }
}
