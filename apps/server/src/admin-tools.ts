import { Inject, Injectable } from '@nestjs/common';
import { McpGuard, McpScopeGuard, McpTool } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { Kolab } from '@konjir/engine';
import { ROLES } from '@konjir/types';
import { fail, ok } from './results.js';
import { KOLAB } from './tokens.js';

const addActor = z.object({ id: z.string(), name: z.string().optional() });
const openSession = z.object({ actor: z.string(), role: z.enum(ROLES) });
const endSession = z.object({ token: z.string() });

/** Verbs for the admin token only: the scope guard refuses them to agent sessions. */
@Injectable()
export class AdminTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @McpTool({ name: 'konjir_admin_add_actor', description: 'Admin: register an actor (a person or an agent identity).', schema: addActor })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addActor({ id, name }: z.infer<typeof addActor>) {
    try { await this.kolab.addActor(id, name ?? id); return ok({ actor: id }); } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_open_session',
    description: 'Admin: open a session for an actor with one active role. Returns the bearer token the agent connects with.',
    schema: openSession,
  })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async openSession({ actor, role }: z.infer<typeof openSession>) {
    try { return ok({ token: await this.kolab.openSession(actor, role), actor, role }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_end_session', description: 'Admin: end a session, revoking its token.', schema: endSession })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async endSession({ token }: z.infer<typeof endSession>) {
    try { await this.kolab.endSession(token); return ok({ ended: token }); } catch (e) { return fail(e); }
  }
}
