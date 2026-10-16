import { Inject, Injectable } from '@nestjs/common';
import { McpGuard, McpScopeGuard, McpTool } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { Kolab } from '@konjir/engine';
import { ROLES } from '@konjir/types';
import { fail, ok } from './results.js';
import { KOLAB } from './tokens.js';

const addActor = z.object({
  id: z.string(),
  name: z.string().optional(),
  owner: z.string().optional().describe('For an agent: the person who owns it. Omit to register a person.'),
});
const listActors = z.object({ owner: z.string().optional().describe("Only this person's agents") });
const openSession = z.object({ actor: z.string(), role: z.enum(ROLES) });
const endSession = z.object({ token: z.string() });

/** Verbs for the admin token only: the scope guard refuses them to agent sessions. */
@Injectable()
export class AdminTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @McpTool({
    name: 'konjir_admin_add_actor',
    description: 'Admin: register a person, or with owner=<person> an agent that person owns. Each agent is an actor of its own, with its own sessions and authorship.',
    schema: addActor,
  })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addActor({ id, name, owner }: z.infer<typeof addActor>) {
    try {
      await this.kolab.addActor(id, { name, owner });
      return ok({ actor: id, kind: owner === undefined ? 'person' : 'agent', owner: owner ?? null });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_list_actors', description: "Admin: list actors, each with its kind and owner; owner=<person> lists that person's agents.", schema: listActors })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async listActors({ owner }: z.infer<typeof listActors>) {
    try { return ok({ actors: await this.kolab.listActors({ owner }) }); } catch (e) { return fail(e); }
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
