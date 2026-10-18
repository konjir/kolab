import { Module, RequestMethod, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { McpHttpModule } from '@onivoro/server-mcp';
import type { Kolab } from '@konjir/engine';
import { AdminTools, TenancyTools } from './admin-tools.js';
import { AgentTools } from './agent-tools.js';
import { KonjirAuth } from './auth.js';
import { HealthController } from './health.controller.js';
import { Inboxes } from './inboxes.js';
import { ListenScope } from './listen-scope.js';
import { ListenStreams } from './listen-streams.js';
import { OperatingInstructions, ReviewerInstructions, SERVER_INSTRUCTIONS } from './instructions.js';
import { KOLAB, MCP_ROUTE, SERVER_INFO, SERVER_OPTIONS, type ServerOptions } from './tokens.js';

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
export class KolabServerModule implements NestModule {
  /** A listen stream may subscribe only to its own session's kolab's resources (D50). */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ListenScope).forRoutes({ path: MCP_ROUTE, method: RequestMethod.POST });
  }

  static register(options: KolabServerModuleOptions): DynamicModule {
    const { kolab, publicHost, ...serverOptions } = options;
    return {
      module: KolabServerModule,
      imports: [
        McpHttpModule.registerAndServeHttp({
          metadata: { ...SERVER_INFO, instructions: SERVER_INSTRUCTIONS },
          route: MCP_ROUTE,
          // Its acceptListenStream gates each listen stream as it opens (D41).
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
        TenancyTools,
        Inboxes,
        ListenStreams,
        ListenScope,
        OperatingInstructions,
        ReviewerInstructions,
      ],
    };
  }
}
