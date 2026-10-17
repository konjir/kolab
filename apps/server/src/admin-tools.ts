import { Inject, Injectable } from '@nestjs/common';
import { McpGuard, McpScopeGuard, McpTool } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { GateError, Kolab } from '@konjir/engine';
import { parseAddress } from '@konjir/address';
import { ACCESS_LEVELS, DELTA_KINDS, LAYERS, ORG_ROLES, ROLES, VISIBILITIES } from '@konjir/types';
import { fail, ok } from './results.js';
import { KOLAB } from './tokens.js';

const addActor = z.object({
  id: z.string(),
  name: z.string().optional(),
  owner: z.string().optional().describe('For an agent: the account that owns it, a person or an organization. Omit to register a person, who is also a user account.'),
});
const listActors = z.object({ owner: z.string().optional().describe("Only this account's agents") });
const openSession = z.object({
  actor: z.string(), role: z.enum(ROLES),
  kolab: z.string().optional().describe('The kolab the session works in. Defaults to the one kolab the actor can reach.'),
});
const endSession = z.object({ token: z.string() });
const addOrganization = z.object({ id: z.string(), name: z.string().optional() });
const addMember = z.object({ org: z.string(), user: z.string(), role: z.enum(ORG_ROLES).optional().describe('owner administers every kolab the organization owns. Defaults to member.') });
const removeMember = z.object({ org: z.string(), user: z.string() });
const removeTeamMember = z.object({ team: z.string().describe('<org>/<team>'), user: z.string() });
const addTeam = z.object({ org: z.string(), name: z.string(), parent: z.string().optional().describe('A team of the same organization to nest this one under; its members inherit the parent\'s access') });
const addTeamMember = z.object({ team: z.string().describe('<org>/<team>'), user: z.string() });
const addKolab = z.object({
  name: z.string().describe('The short name, unique across all of Konjir: lowercase letters, digits and -'),
  owner: z.string().describe('The account that owns it: a person or an organization'),
  title: z.string().optional(),
  visibility: z.enum(VISIBILITIES).optional().describe('Defaults to private'),
  base: z.enum(ACCESS_LEVELS).optional().describe('An organization\'s kolab: what every member of the organization holds'),
});
const listKolabs = z.object({ owner: z.string().optional() });
const grant = z.object({
  kolab: z.string(),
  to: z.string().describe('A person, an agent, or a team as <org>/<team>'),
  level: z.enum(ACCESS_LEVELS),
  layers: z.array(z.enum(LAYERS)).optional().describe('For write: the layers it covers. Defaults to both.'),
});
const revoke = z.object({ kolab: z.string(), to: z.string() });
const access = z.object({ actor: z.string(), kolab: z.string() });
const applyRuling = z.object({
  ruling: z.string().regex(/^D\d+$/).describe('The ruling being applied, by its Decisions Log ID, e.g. D46'),
  actor: z.string().describe('Who the version is written as, e.g. mirror-product; it writes in the role of the node\'s layer'),
  node: z.string(),
  elements: z.array(z.object({ id: z.string().optional(), text: z.string(), parent: z.string().optional() })).optional(),
  deltas: z.array(z.object({ kind: z.enum(DELTA_KINDS), element: z.string(), text: z.string().optional(), parent: z.string().optional() })).optional(),
  parent: z.string().optional().describe('For a variant: the committed parent version, e.g. kj:storefront@2'),
});

/** Verbs for the admin token only: the scope guard refuses them to agent sessions. */
@Injectable()
export class AdminTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @McpTool({
    name: 'konjir_admin_add_actor',
    description: 'Admin: register a person, or with owner=<account> an agent that a person or an organization owns. Each agent is an actor of its own, with its own sessions and authorship.',
    schema: addActor,
  })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addActor({ id, name, owner }: z.infer<typeof addActor>) {
    try {
      await this.kolab.addActor(id, { name, owner });
      return ok({ actor: id, kind: owner === undefined ? 'person' : 'agent', owner: owner ?? null });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_list_actors', description: "Admin: list actors, each with its kind and owner; owner=<account> lists that account's agents.", schema: listActors })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async listActors({ owner }: z.infer<typeof listActors>) {
    try { return ok({ actors: await this.kolab.listActors({ owner }) }); } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_open_session',
    description: 'Admin: open a session for an actor in one kolab, with one active role. Returns the bearer token the agent connects with. The actor must have access to the kolab; an agent holds its own grant there, never more than its owner.',
    schema: openSession,
  })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async openSession({ actor, role, kolab }: z.infer<typeof openSession>) {
    try {
      const token = await this.kolab.openSession(actor, role, { kolab });
      return ok({ token, actor, role, kolab: await this.kolab.sessionKolab(token) });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_end_session', description: 'Admin: end a session, revoking its token.', schema: endSession })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async endSession({ token }: z.infer<typeof endSession>) {
    try { await this.kolab.endSession(token); return ok({ ended: token }); } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_apply_ruling',
    description: 'Admin: apply a ruling of Lee\'s to a node (D47): a new version, written as the actor given, that commits after structural checks only, with no review request, since the ruling is already the approval. Its review note records the ruling. It goes through the same per-node commit step as any other commit, so it is rejected as stale if the node moved on meanwhile. Agent sessions can\'t reach it.',
    schema: applyRuling,
  })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async applyRuling(a: z.infer<typeof applyRuling>) {
    try {
      if (!a.elements === !a.deltas) throw new Error('send exactly one of elements or deltas');
      let parent: string | undefined;
      if (a.parent) {
        const p = parseAddress(a.parent);
        const v = p.version === undefined ? await this.kolab.latestCommitted(p.node)
          : (await this.kolab.db.query<{ id: string; state: string }>(`select id, state from version where node_id = $1 and seq = $2`, [p.node, p.version])).rows[0];
        if (!v || v.state !== 'committed') throw new GateError(`${a.parent} is not a committed version`);
        parent = v.id;
      }
      const r = await this.kolab.applyRuling(a.node, { elements: a.elements, deltas: a.deltas, parent }, { id: a.ruling, actor: a.actor });
      const v = await this.kolab.version(r.version);
      return ok({ ok: r.ok, ruling: a.ruling, committed: r.ok ? `kj:${a.node}@${v.seq}` : null, state: v.state, stale: r.stale ?? false, review: r.note ?? null });
    } catch (e) { return fail(e); }
  }
}

/** Admin verbs for accounts, kolabs, teams and grants (W1.3; TEN1–TEN11). The admin token only. */
@Injectable()
export class TenancyTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @McpTool({ name: 'konjir_admin_add_organization', description: 'Admin: register an organization, an account that owns kolabs and agents and has members and teams.', schema: addOrganization })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addOrganization({ id, name }: z.infer<typeof addOrganization>) {
    try { await this.kolab.addOrganization(id, { name }); return ok({ organization: id }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_member', description: "Admin: add a person to an organization, or change their role in it (member or owner).", schema: addMember })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addMember({ org, user, role }: z.infer<typeof addMember>) {
    try { const { ended } = await this.kolab.addMember(org, user, role); return ok({ org, user, role: role ?? 'member', ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_remove_member', description: "Admin: remove a person from an organization and its teams. Their sessions, and their agents', narrow, and any that can no longer reach their kolab end.", schema: removeMember })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async removeMember({ org, user }: z.infer<typeof removeMember>) {
    try { const { ended } = await this.kolab.removeMember(org, user); return ok({ org, removed: user, ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_team', description: "Admin: create a team in an organization, optionally under a parent team. Teams hold no konstructs; they are granted access.", schema: addTeam })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addTeam({ org, name, parent }: z.infer<typeof addTeam>) {
    try { return ok({ team: await this.kolab.addTeam(org, name, { parent }) }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_team_member', description: "Admin: add a member of the team's organization to the team.", schema: addTeamMember })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addTeamMember({ team, user }: z.infer<typeof addTeamMember>) {
    try { await this.kolab.addTeamMember(team, user); return ok({ team, user }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_remove_team_member', description: "Admin: remove a person from a team. Their sessions, and their agents', narrow, and any that can no longer reach their kolab end.", schema: removeTeamMember })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async removeTeamMember({ team, user }: z.infer<typeof removeTeamMember>) {
    try { const { ended } = await this.kolab.removeTeamMember(team, user); return ok({ team, removed: user, ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_kolab', description: 'Admin: create a kolab owned by a person or an organization. Its name is unique across all of Konjir.', schema: addKolab })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async addKolab({ name, owner, title, visibility, base }: z.infer<typeof addKolab>) {
    try {
      await this.kolab.createKolab(name, { owner, title, visibility, base });
      return ok({ kolab: name, owner, visibility: visibility ?? 'private', base: base ?? null });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_list_kolabs', description: "Admin: list kolabs, or with owner=<account> that account's.", schema: listKolabs })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async listKolabs({ owner }: z.infer<typeof listKolabs>) {
    try { return ok({ kolabs: await this.kolab.listKolabs({ owner }) }); } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_grant',
    description: "Admin: grant a person, an agent or a team (<org>/<team>) access to a kolab: read, triage, write, maintain or admin, replacing any grant it had there. A write grant names its layers (both by default). An agent can't be granted more than its owner holds. A lower grant narrows the grantee's sessions, and ends any that can no longer reach the kolab.",
    schema: grant,
  })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async grant({ kolab, to, level, layers }: z.infer<typeof grant>) {
    try {
      const { ended } = await this.kolab.grant(kolab, to, level, { layers });
      return ok({ kolab, to, level, layers: level === 'write' ? layers ?? [...LAYERS] : level === 'read' || level === 'triage' ? [] : [...LAYERS], ended_sessions: ended });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_revoke', description: "Admin: remove a grant. Sessions it covered narrow, and any that can no longer reach the kolab end.", schema: revoke })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async revoke({ kolab, to }: z.infer<typeof revoke>) {
    try { const { ended } = await this.kolab.revoke(kolab, to); return ok({ kolab, revoked: to, ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_access', description: "Admin: an actor's access to a kolab: its level and the layers it may write. An agent's is its own grant, cut down to its owner's.", schema: access })
  @McpGuard(McpScopeGuard, { scopes: ['admin'] })
  async access({ actor, kolab }: z.infer<typeof access>) {
    try { await this.kolab.actor(actor); return ok({ actor, kolab, ...(await this.kolab.access(actor, kolab)) }); } catch (e) { return fail(e); }
  }
}
