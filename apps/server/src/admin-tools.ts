import { Inject, Injectable } from '@nestjs/common';
import { McpGuard, McpScopeGuard, McpTool, type McpCanActivate, type McpToolContext } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { AccessError, GateError, Kolab, NameTakenError, SESSION_KEY, sessionKey } from '@konjir/engine';
import { formatAddress, parseAddress } from '@konjir/address';
import { ACCESS_LEVELS, ADMIN_DOER, DELTA_KINDS, LAYERS, ORG_ROLES, OUTBOX_STATES, ROLES, VISIBILITIES, type ArchiveTarget, type Doer } from '@konjir/types';
import { linkRef, toLinkRef } from './link-refs.js';
import { PAGED, paging } from './paging.js';
import { fail as toolError, ok } from './results.js';

/**
 * A tool error for the admin token. A name an archived kolab, account or actor holds is refused
 * everywhere in the words a live one is, so no one else learns it exists; the admin token, which
 * can list archived ones anyway, is also told which archived one holds it and how to restore it (D52).
 */
function fail(e: unknown) {
  if (e instanceof NameTakenError && e.archived) {
    const { kind, id } = e.archived;
    const told = new NameTakenError(`${e.message}. The archived ${kind} ${id} holds it, and an archived name stays reserved: `
      + `konjir_admin_unarchive ${kind}=${id} restores it, or choose another name`);
    told.name = e.name;
    return toolError(told);
  }
  return toolError(e);
}
import { KOLAB, SERVER_OPTIONS, type ServerOptions } from './tokens.js';

/**
 * Who an admin verb records as having made its write (W2.20, D70; W2.22, D69): the Konjir admin
 * whose own raised session called it (KonjirAuth puts its actor in the auth's `extra`), or, for the
 * break-glass token, ADMIN_DOER. Every verb below passes it, so none records a write as no one's,
 * and none falls back to the token for a caller it can't name.
 */
export function admin(context: McpToolContext | undefined): { by: Doer } {
  const auth = context?.authInfo;
  if (auth?.scopes.includes('break-glass')) return { by: ADMIN_DOER };
  const actor = auth?.extra?.actor;
  if (auth?.scopes.includes('admin') && typeof actor === 'string' && actor.trim()) return { by: actor };
  throw new AccessError('admin verbs need a Konjir admin\'s own session, raised in their browser (konjir_admin_elevate), or the break-glass token');
}

/**
 * Records each admin verb the break-glass token runs (W2.22): in the audit log, as
 * break_glass.used, before the verb runs, whether it then succeeds or not. It refuses nothing:
 * the scope guard beside it decides who may call the verb.
 */
@Injectable()
export class BreakGlassAudit implements McpCanActivate {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}
  async canActivate(context: McpToolContext): Promise<boolean> {
    if (context.authInfo?.scopes.includes('break-glass')) await this.kolab.recordBreakGlass(context.toolName);
    return true;
  }
}

/**
 * An admin verb: for a Konjir admin's raised session or the break-glass token, which both carry
 * the `admin` scope (KonjirAuth); hidden from, and refused to, every other session. Each use of the
 * break-glass token is recorded.
 */
const AdminOnly = () => (target: object, key: string, descriptor: PropertyDescriptor) => {
  McpGuard(McpScopeGuard, { scopes: ['admin'] })(target, key, descriptor);
  McpGuard(BreakGlassAudit)(target, key, descriptor);
};

const addActor = z.object({
  id: z.string(),
  name: z.string().optional(),
  owner: z.string().optional().describe('For an agent: the account that owns it, a person or an organization. Omit to register a person, who is also a user account.'),
});
const linkIdentity = z.object({
  actor: z.string().describe('The person to link'),
  provider: z.enum(['github']).describe('The identity provider'),
  subject: z.string().regex(/^[0-9]{1,20}$/).describe("The provider's id for the person: GitHub's numeric user id (gh api users/<login> --jq .id), never the login, which can change hands"),
  login: z.string().optional().describe('Their login there, for display'),
});
const listActors = z.object({
  owner: z.string().optional().describe("Only this account's agents"),
  archived: z.boolean().optional().describe('Also list archived actors, and agents of an archived account, each with archived: true or false'),
  ...paging,
});
const openSession = z.object({
  actor: z.string(), role: z.enum(ROLES),
  kolab: z.string().optional().describe('The kolab the session works in. Defaults to the one kolab the actor can reach.'),
});
const endSession = z.object({
  token: z.string().optional().describe('The bearer token the session opened with'),
  session: z.string().optional().describe("The session's key, as whoami gives it: the sha256 of its token, base64url"),
  actor: z.string().optional().describe('The actor whose open session to end'),
});
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
const listKolabs = z.object({
  owner: z.string().optional(),
  archived: z.boolean().optional().describe('Also list archived kolabs, and those of an archived account, each with archived: true or false'),
  ...paging,
});
const archiveTarget = z.object({
  kolab: z.string().optional().describe('A kolab, by its name'),
  organization: z.string().optional().describe('An organization: its kolabs and its agents go with it'),
  actor: z.string().optional().describe("A person or an agent: a person's agents go with them; the kolabs a person owns stay live"),
});
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
  node: z.string().describe('The node, as <kolab>/<node> (e.g. kolab/kolab-binding), or its name alone when no other kolab has a node of that name'),
  elements: z.array(z.object({ id: z.string().optional(), text: z.string(), parent: z.string().optional() })).optional(),
  deltas: z.array(z.object({ kind: z.enum(DELTA_KINDS), element: z.string(), text: z.string().optional(), parent: z.string().optional() })).optional(),
  parent: z.string().optional().describe('For a variant: the committed parent version, e.g. kj:storefront@2, in the node\'s kolab'),
  unlink: z.array(linkRef).optional().describe('Links of the node\'s live version that the ruling drops, so they aren\'t carried forward, and their open marks settle: [{"source_element":"b1","target":"kj:kolab#R1"}] or [{"link":"<id>"}]; targets in the node\'s kolab'),
});
const auditLog = z.object({
  kolab: z.string().optional().describe("Only this kolab's changes: its grants and its outbox jobs"),
  subject: z.string().optional().describe('Only changes to this grantee, person or job'),
  limit: z.number().int().min(1).max(500).optional().describe('At most this many, newest first; 100 by default'),
  before: z.number().int().min(1).optional().describe('Only events older than this one: the id of the last event of the previous page, to page back'),
});
const elevate = z.object({ lower: z.boolean().optional().describe('End the raise now, before it lapses') });
const adminPerson = z.object({ actor: z.string().describe('The person, by their actor id (a GitHub sign-up is named after their login, e.g. icedlee337)') });
const outbox = z.object({
  state: z.enum(OUTBOX_STATES).optional().describe('Only jobs in this state: dead ones wait for an admin to retry them'),
  kolab: z.string().optional().describe('Only jobs of this kolab'),
  retry: z.string().optional().describe('The id of a dead job, or one waiting out its backoff, to run again now'),
  ...paging,
});

/** What archive and unarchive name: exactly one of a kolab, an organization or an actor. */
function oneTarget(a: { kolab?: string; organization?: string; actor?: string }): ArchiveTarget {
  const given = (['kolab', 'organization', 'actor'] as const).filter((k) => a[k] !== undefined);
  if (given.length !== 1) throw new Error('name exactly one of kolab, organization or actor');
  const k = given[0];
  return { [k]: a[k]! } as ArchiveTarget;
}

/** Whether this Kolab's break-glass admin token is enabled: without it, the last live Konjir admin stays one (W2.22). */
const breakGlassOn = (options: ServerOptions) => !!options.adminToken;

/** Admin verbs: for a Konjir admin's raised session or the break-glass token; the scope guard refuses every other session. */
@Injectable()
export class AdminTools {
  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(SERVER_OPTIONS) private readonly options: ServerOptions,
  ) {}

  @McpTool({
    name: 'konjir_admin_elevate',
    description: "For a Konjir admin, from their own session (W2.22, D69): ask for it to be raised to run the admin verbs for 15 minutes, as yourself. This raises nothing: it answers with a link (raise_url) for the person to open in their browser, sign in with GitHub as themselves and confirm on Kolab's page; only then is this session raised, and only for that person. Asking again, and confirming again, renews it. lower=true ends a raise now. Only a person's own session, signed in with GitHub, never an agent's or a hand-issued one, and only while they are a Konjir admin.",
    schema: elevate,
  })
  @McpGuard(McpScopeGuard, { scopes: ['konjir-admin'] })
  async elevate({ lower }: z.infer<typeof elevate>, context?: McpToolContext) {
    try {
      const token = context?.authInfo?.token;
      if (!token || context?.authInfo?.scopes.includes('break-glass')) throw new AccessError('raise your own session: the break-glass token needs no raising');
      if (lower) {
        const r = await this.kolab.lowerRaise(token);
        return ok({ actor: r.actor, session: r.session, admin_until: null, lowered: r.lowered });
      }
      // Asked for only: no MCP call raises a session (Lee's ruling of 2026-10-23). The person's browser does.
      const r = await this.kolab.requestRaise(token);
      if (!this.options.origin) throw new Error('this Kolab doesn\'t know its own address yet, so it can\'t give a raise link');
      return ok({
        actor: r.actor, session: r.session, raised: false,
        raise_url: `${this.options.origin}/oauth/raise?request=${r.request}`, expires_at: r.expiresAt,
        next: 'Open raise_url in your own browser, sign in with GitHub as yourself and confirm there. Only then does this session run the admin verbs, for 15 minutes; nothing called here raises it. If you did not ask for this, ignore the link.',
      });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_make_admin',
    description: "Admin: make a person a Konjir admin (D69), who then runs the admin verbs from their own GitHub sign-in (konjir_admin_elevate) instead of the break-glass token. Never an agent. Recorded in the audit log as admin.granted, by you.",
    schema: adminPerson,
  })
  @AdminOnly()
  async makeAdmin({ actor }: z.infer<typeof adminPerson>, context?: McpToolContext) {
    try {
      const made = await this.kolab.makeAdmin(actor, admin(context));
      return ok({ actor, admin: true, ...(made ? {} : { already: true }) });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_remove_admin',
    description: "Admin: a person is no longer a Konjir admin; any raised session of theirs stops running admin verbs at once. Refused for the last live admin while this Kolab's break-glass token is disabled. Recorded in the audit log as admin.revoked, by you.",
    schema: adminPerson,
  })
  @AdminOnly()
  async removeAdmin({ actor }: z.infer<typeof adminPerson>, context?: McpToolContext) {
    try {
      if (!(await this.kolab.removeAdmin(actor, { ...admin(context), breakGlass: breakGlassOn(this.options) }))) throw new Error(`${actor} is not a Konjir admin`);
      return ok({ actor, admin: false });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_list_admins', description: "Admin: Konjir's admins, each with who made them one and when, whether they are archived, and whether they can sign in (signs_in: a linked GitHub identity, without which they can never raise a session); and whether this Kolab's break-glass token is enabled.", schema: z.object({}) })
  @AdminOnly()
  async listAdmins() {
    try { return ok({ admins: await this.kolab.admins(), break_glass: breakGlassOn(this.options) }); } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_add_actor',
    description: 'Admin: register a person, or with owner=<account> an agent that a person or an organization owns. Each agent is an actor of its own, with its own sessions and authorship.',
    schema: addActor,
  })
  @AdminOnly()
  async addActor({ id, name, owner }: z.infer<typeof addActor>, context?: McpToolContext) {
    try {
      await this.kolab.addActor(id, { name, owner, ...admin(context) });
      return ok({ actor: id, kind: owner === undefined ? 'person' : 'agent', owner: owner ?? null });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_link_identity',
    description: "Admin: link an existing person to their identity at an identity provider (D55), so that signing in with it reaches them instead of signing up someone new. Kolab never matches a person by name. Refused if the identity is linked to someone else, or the person already has one there.",
    schema: linkIdentity,
  })
  @AdminOnly()
  async linkIdentity({ actor, provider, subject, login }: z.infer<typeof linkIdentity>, context?: McpToolContext) {
    try {
      await this.kolab.linkIdentity(actor, { provider, subject, login }, admin(context));
      return ok({ actor, identities: await this.kolab.identities(actor) });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_list_actors', description: `Admin: list actors, each with its kind and owner; owner=<account> lists that account's agents. By id.${PAGED}`, schema: listActors })
  @AdminOnly()
  async listActors({ owner, archived, cursor, limit }: z.infer<typeof listActors>) {
    try {
      const { items, next } = await this.kolab.actorsPage({ owner, archived }, { cursor, limit });
      return ok({ actors: items, next });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_open_session',
    description: 'Admin: open a session for an actor in one kolab, with one active role. Returns the bearer token the agent connects with, and when it expires: 30 days after it opens, by default (W2.22); an expired token is refused like an ended one. The actor must have access to the kolab; an agent holds its own grant there, never more than its owner.',
    schema: openSession,
  })
  @AdminOnly()
  async openSession({ actor, role, kolab }: z.infer<typeof openSession>, context?: McpToolContext) {
    try {
      const token = await this.kolab.openSession(actor, role, { kolab, ...admin(context) });
      // The only time the token is shown: Kolab stores only its hash (P1). It expires (W2.22).
      const expires = (await this.kolab.liveSession(token))?.expiresAt;
      return ok({ token, session: sessionKey(token), actor, role, kolab: await this.kolab.sessionKolab(token), expires_at: expires ? expires.toISOString() : null });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_end_session',
    description: "Admin: end a session, revoking its token. Name it by exactly one of token (kjs_…), session (its 43-character key, as whoami and admin_open_session give it) or actor (whose open session it is). Returns the ended session's key; an error if no open session matched, so a mistyped revoke never passes for one that worked.",
    schema: endSession,
  })
  @AdminOnly()
  async endSession({ token, session, actor }: z.infer<typeof endSession>, context?: McpToolContext) {
    try {
      if ([token, session, actor].filter((x) => x !== undefined).length !== 1) throw new Error('name the session by exactly one of token, session or actor');
      // Each argument in its own form, so a token passed as a key (or the reverse) is refused, not looked up and missed.
      if (token !== undefined && !token.startsWith('kjs_')) {
        throw new Error(SESSION_KEY.test(token) ? "that is a session's key, not a token; pass it as session=" : 'that is not a session token, which starts kjs_');
      }
      if (session !== undefined && !SESSION_KEY.test(session)) {
        throw new Error(session.startsWith('kjs_') ? 'that is a token, not a session key; pass it as token=' : "that is not a session key, which is 43 base64url characters (whoami's session)");
      }
      const ended = await this.kolab.endSession(token ?? (session !== undefined ? { key: session } : { actor: actor! }), admin(context));
      if (!ended) {
        throw new Error(actor !== undefined ? `${actor} has no open session` : 'no open session matched; it has already ended, or never existed');
      }
      return ok({ ended });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_outbox',
    description: `Admin: the outbox (REV3): the work commits and verdicts still owe, each job with its subject, attempts and last error; kolab=<name> for one kolab\'s. A rebase job (D43) is a variant to rebase onto its parent\'s latest version, queued by the parent version named in after; it rebases whatever the variant has live when it runs. A job that fails ten times is dead, and it, and any later cascade of its node, waits until retry=<id> runs it again. Oldest first.${PAGED}`,
    schema: outbox,
  })
  @AdminOnly()
  async outbox({ state, kolab, retry, cursor, limit }: z.infer<typeof outbox>, context?: McpToolContext) {
    try {
      if (retry !== undefined && !(await this.kolab.retryOutboxJob(retry, admin(context)))) throw new GateError(`no job ${retry} to retry: it is done, or a live process is running it`);
      const { items, next } = await this.kolab.outboxPage({ state, kolab }, { cursor, limit });
      return ok({ ...(retry !== undefined ? { retried: retry } : {}), jobs: items, next });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_audit',
    description: "Admin: the audit log (W2.20), newest first, a page at a time (next_before, when given, is the before for the next page): each change that leaves no row of its own to say who made it, with who made it and when. A grant made, changed or removed (grant.set, grant.removed), a person added to or removed from an organization or a team (member.set, member.removed, team_member.added, team_member.removed), an outbox job retried (outbox.retried), a person made or no longer a Konjir admin (admin.granted, admin.revoked), an admin raising their session to run admin verbs or lowering it (admin.elevated, admin.lowered), and each admin verb the break-glass token ran (break_glass.used, its subject the verb). by is an actor, or admin for the break-glass token. Everything else Kolab writes names who made it on its own row: a node's created_by, a session's opened_by and ended_by, a version's actor and submitted_by, an archive's done_by.",
    schema: auditLog,
  })
  @AdminOnly()
  async audit({ kolab, subject, limit, before }: z.infer<typeof auditLog>) {
    try {
      const events = await this.kolab.auditLog({ kolab, subject, limit, before });
      // A full page may have more behind it: pass its last id as before.
      return ok({ events, ...(events.length === (limit ?? 100) ? { next_before: events[events.length - 1].id } : {}) });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_apply_ruling',
    description: 'Admin: apply a ruling of Lee\'s to a node (D47): a new version, written as the actor given, that commits after structural checks only, with no review request, since the ruling is already the approval. With unlink, it also drops links of the node\'s live version. Its review note records the ruling. It goes through the same per-node commit step as any other commit, so it is rejected as stale if the node moved on meanwhile. Agent sessions can\'t reach it.',
    schema: applyRuling,
  })
  @AdminOnly()
  async applyRuling(a: z.infer<typeof applyRuling>, context?: McpToolContext) {
    try {
      if (!a.elements === !a.deltas) throw new Error('send exactly one of elements or deltas');
      // The admin token works in no kolab, so the node is named with its kolab, or by a name only one kolab has.
      const node = await this.kolab.nodeForAdmin(a.node);
      let parent: string | undefined;
      if (a.parent) {
        const p = parseAddress(a.parent);
        if (p.kolab !== undefined && p.kolab !== node.kolab_id) throw new GateError(`${a.parent} is not in kolab ${node.kolab_id}, the node's kolab`);
        const { version: v } = await this.kolab.locateVersion({ system: node.kolab_id }, p);
        if (!v || v.state !== 'committed') throw new GateError(`${a.parent} is not a committed version`);
        parent = v.id;
      }
      const r = await this.kolab.applyRuling(node.id, { elements: a.elements, deltas: a.deltas, parent, unlink: a.unlink?.map(toLinkRef) }, { id: a.ruling, actor: a.actor, ...admin(context) });
      const v = await this.kolab.version(r.version);
      const at = formatAddress({ kolab: node.kolab_id, node: node.name, version: v.seq });
      return ok({ ok: r.ok, ruling: a.ruling, committed: r.ok ? at : null, state: v.state, stale: r.stale ?? false, review: r.note ?? null, ...(r.rebases ? { rebases_queued: r.rebases } : {}) });
    } catch (e) { return fail(e); }
  }
}

/** Admin verbs for accounts, kolabs, teams and grants (W1.3; TEN1–TEN11): for a Konjir admin's raised session or the break-glass token. */
@Injectable()
export class TenancyTools {
  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(SERVER_OPTIONS) private readonly options: ServerOptions,
  ) {}

  @McpTool({ name: 'konjir_admin_add_organization', description: 'Admin: register an organization, an account that owns kolabs and agents and has members and teams.', schema: addOrganization })
  @AdminOnly()
  async addOrganization({ id, name }: z.infer<typeof addOrganization>, context?: McpToolContext) {
    try { await this.kolab.addOrganization(id, { name, ...admin(context) }); return ok({ organization: id }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_member', description: "Admin: add a person to an organization, or change their role in it (member or owner).", schema: addMember })
  @AdminOnly()
  async addMember({ org, user, role }: z.infer<typeof addMember>, context?: McpToolContext) {
    try { const { ended } = await this.kolab.addMember(org, user, role, admin(context)); return ok({ org, user, role: role ?? 'member', ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_remove_member', description: "Admin: remove a person from an organization and its teams. Their sessions, and their agents', narrow, and any that can no longer reach their kolab end.", schema: removeMember })
  @AdminOnly()
  async removeMember({ org, user }: z.infer<typeof removeMember>, context?: McpToolContext) {
    try { const { ended } = await this.kolab.removeMember(org, user, admin(context)); return ok({ org, removed: user, ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_team', description: "Admin: create a team in an organization, optionally under a parent team. Teams hold no konstructs; they are granted access.", schema: addTeam })
  @AdminOnly()
  async addTeam({ org, name, parent }: z.infer<typeof addTeam>, context?: McpToolContext) {
    try { return ok({ team: await this.kolab.addTeam(org, name, { parent, ...admin(context) }) }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_team_member', description: "Admin: add a member of the team's organization to the team.", schema: addTeamMember })
  @AdminOnly()
  async addTeamMember({ team, user }: z.infer<typeof addTeamMember>, context?: McpToolContext) {
    try { await this.kolab.addTeamMember(team, user, admin(context)); return ok({ team, user }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_remove_team_member', description: "Admin: remove a person from a team. Their sessions, and their agents', narrow, and any that can no longer reach their kolab end.", schema: removeTeamMember })
  @AdminOnly()
  async removeTeamMember({ team, user }: z.infer<typeof removeTeamMember>, context?: McpToolContext) {
    try { const { ended } = await this.kolab.removeTeamMember(team, user, admin(context)); return ok({ team, removed: user, ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_add_kolab', description: 'Admin: create a kolab owned by a person or an organization. Its name is unique across all of Konjir.', schema: addKolab })
  @AdminOnly()
  async addKolab({ name, owner, title, visibility, base }: z.infer<typeof addKolab>, context?: McpToolContext) {
    try {
      await this.kolab.createKolab(name, { owner, title, visibility, base, ...admin(context) });
      return ok({ kolab: name, owner, visibility: visibility ?? 'private', base: base ?? null });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_list_kolabs', description: `Admin: list kolabs, or with owner=<account> that account's. Archived kolabs are left out unless archived=true. By name.${PAGED}`, schema: listKolabs })
  @AdminOnly()
  async listKolabs({ owner, archived, cursor, limit }: z.infer<typeof listKolabs>) {
    try {
      const { items, next } = await this.kolab.kolabsPage({ owner, archived }, { cursor, limit });
      return ok({ kolabs: items, next });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_archive',
    description: "Admin: archive a kolab, an organization or an actor, named by exactly one of kolab, organization or actor (D52). It disappears from listings and can't be used: its sessions end and their streams close, no session opens, and nothing in an archived kolab can change. Its data is kept, and its name stays reserved. An organization's kolabs and agents, and a person's agents, are archived with it; a person's own kolabs stay live for their other members. Nothing is deleted; admin_unarchive restores it.",
    schema: archiveTarget,
  })
  @AdminOnly()
  async archive(a: z.infer<typeof archiveTarget>, context?: McpToolContext) {
    try {
      const { archived, kolabs, agents, ended } = await this.kolab.archive(oneTarget(a), { ...admin(context), breakGlass: breakGlassOn(this.options) });
      return ok({ archived, with_kolabs: kolabs, with_agents: agents, ended_sessions: ended });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_unarchive',
    description: "Admin: unarchive a kolab, an organization or an actor, named by exactly one of kolab, organization or actor (D52). It is restored as it was, with its grants and memberships, and so is what was archived with it; sessions that ended stay ended. A kolab or agent archived with its owner comes back by unarchiving the owner.",
    schema: archiveTarget,
  })
  @AdminOnly()
  async unarchive(a: z.infer<typeof archiveTarget>, context?: McpToolContext) {
    try {
      const { unarchived, kolabs, agents } = await this.kolab.unarchive(oneTarget(a), admin(context));
      return ok({ unarchived, with_kolabs: kolabs, with_agents: agents });
    } catch (e) { return fail(e); }
  }

  @McpTool({
    name: 'konjir_admin_grant',
    description: "Admin: grant a person, an agent or a team (<org>/<team>) access to a kolab: read, triage, write, maintain or admin, replacing any grant it had there. A write grant names its layers (both by default). An agent can't be granted more than its owner holds. A lower grant narrows the grantee's sessions, and ends any that can no longer reach the kolab.",
    schema: grant,
  })
  @AdminOnly()
  async grant({ kolab, to, level, layers }: z.infer<typeof grant>, context?: McpToolContext) {
    try {
      const { ended } = await this.kolab.grant(kolab, to, level, { layers, ...admin(context) });
      return ok({ kolab, to, level, layers: level === 'write' ? layers ?? [...LAYERS] : level === 'read' || level === 'triage' ? [] : [...LAYERS], ended_sessions: ended });
    } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_revoke', description: "Admin: remove a grant. Sessions it covered narrow, and any that can no longer reach the kolab end.", schema: revoke })
  @AdminOnly()
  async revoke({ kolab, to }: z.infer<typeof revoke>, context?: McpToolContext) {
    try { const { ended } = await this.kolab.revoke(kolab, to, admin(context)); return ok({ kolab, revoked: to, ended_sessions: ended }); } catch (e) { return fail(e); }
  }

  @McpTool({ name: 'konjir_admin_access', description: "Admin: an actor's access to a kolab: its level and the layers it may write. An agent's is its own grant, cut down to its owner's.", schema: access })
  @AdminOnly()
  async access({ actor, kolab }: z.infer<typeof access>) {
    try { await this.kolab.actor(actor); return ok({ actor, kolab, ...(await this.kolab.access(actor, kolab)) }); } catch (e) { return fail(e); }
  }
}
