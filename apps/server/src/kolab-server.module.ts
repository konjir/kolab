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
import { KOLAB, MCP_ROUTE, OAUTH_OPTIONS, SERVER_INFO, SERVER_OPTIONS, WEB_OPTIONS, type ServerOptions } from './tokens.js';
import type { IdentityProvider } from './oauth/identity.js';
import { OAuthController } from './oauth/oauth.controller.js';
import { WebPeople, WebRefresher, WebSessionGuard } from './web/auth.js';
import { WebController, WebSessionController } from './web/web.controller.js';
import { WebEventsController, WebStreams } from './web/events.controller.js';
import { WebService } from './web/web.service.js';

export interface KolabServerModuleOptions extends ServerOptions {
  kolab: Kolab;
  /** The public hostname a TLS proxy serves this kolab on (e.g. kolab.konjir.com). */
  publicHost?: string;
  /** How often a web event stream checks its kolab's versions, in ms (3 s by default). */
  webVersionsPollMs?: number;
  /** Who signs people in (D55): GitHub on the test server. Without one, there is no OAuth, and only hand-issued tokens work. */
  identity?: IdentityProvider;
  /** Whether the web interface still takes a pasted session token: by default, only when there is no identity provider. */
  webTokenSignIn?: boolean;
}

/**
 * Konjir over MCP: one kolab, served by @onivoro/server-mcp as a stateless Streamable
 * HTTP endpoint at /mcp (MCP 2026-07-28, with the SDK's fallback for 2025-era clients),
 * plus GET /healthz, the web interface's API and server-sent events under /api (API8), and Kolab's
 * OAuth 2.1 authorization server (D55): its metadata under /.well-known, its endpoints under /oauth.
 * startServer serves the web interface's pages themselves.
 */
@Module({})
export class KolabServerModule implements NestModule {
  /**
   * A listen stream may subscribe only to its own session's kolab's resources (D50). ListenScope
   * sees subscriptions/listen alone, which suffices only while the transport is stateless (no
   * `session` below): a 2025-era resources/subscribe would bypass it. listen.test.ts pins that.
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ListenScope).forRoutes({ path: MCP_ROUTE, method: RequestMethod.POST });
  }

  static register(options: KolabServerModuleOptions): DynamicModule {
    const { kolab, publicHost, webVersionsPollMs, identity, webTokenSignIn, ...serverOptions } = options;
    const handIssuedTokens = serverOptions.handIssuedTokens !== false;
    return {
      module: KolabServerModule,
      imports: [
        McpHttpModule.registerAndServeHttp({
          metadata: { ...SERVER_INFO, instructions: SERVER_INSTRUCTIONS },
          route: MCP_ROUTE,
          // Its acceptListenStream gates each listen stream as it opens (D41).
          authStrategy: KonjirAuth,
          // A request without a valid token gets 401, naming the protected-resource metadata that
          // leads an MCP client to Kolab's authorization server (D55). Behind the TLS proxy, its URL
          // is the public one; on loopback, the request's own origin.
          requireBearerAuth: publicHost
            ? { resourceMetadataUrl: `https://${publicHost}/.well-known/oauth-protected-resource/${MCP_ROUTE}` }
            : true,
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
      controllers: [HealthController, OAuthController, WebSessionController, WebController, WebEventsController],
      providers: [
        { provide: KOLAB, useValue: kolab },
        { provide: SERVER_OPTIONS, useValue: { ...serverOptions, handIssuedTokens } },
        { provide: OAUTH_OPTIONS, useValue: { identity, publicHost } },
        {
          provide: WEB_OPTIONS,
          useValue: {
            adminToken: serverOptions.adminToken, publicHost, versionsPollMs: webVersionsPollMs,
            tokenSignIn: webTokenSignIn ?? !identity, identityLabel: identity?.label, handIssuedTokens,
          },
        },
        WebService,
        WebPeople,
        WebRefresher,
        WebSessionGuard,
        WebStreams,
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
