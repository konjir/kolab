import type { AuditAction } from '@konjir/types';

/**
 * Where a write records who made it (W2.20, D70): the columns of its own rows, `table.column`, and
 * the audit log's actions, `audit_event:<action>`, for a change that leaves no row of its own.
 */
export type ActorRecord = `${string}.${string}` | `audit_event:${AuditAction}`;

/**
 * How each of Kolab's public methods that writes records who made the write (W2.20, D70):
 * - `recorded`: where it is recorded (ActorRecord), from the session's actor, the person signing
 *   in, or `by`, the admin token until admins are people (W2.22)
 * - `system`: Kolab's own work, which no one asked for when it runs; what it writes is recorded
 *   as `kolab`, or belongs to a version whose author is recorded
 * - `unsigned`: a write made before anyone signs in, on a row that names no one yet (OAuth's
 *   registration and authorization in progress, RFC 7591 and 6749); why that is so
 *
 * The test write-actors.test.ts reads kolab.ts and fails when a public method of Kolab that writes,
 * itself or through anything it calls, is missing here, or when a method here no longer writes;
 * and checks each `recorded` place exists and is filled by the method's own write. A new write path
 * is added here, and records its actor, or the build fails.
 */
export const WRITE_ACTORS: Record<string, { recorded: ActorRecord[] } | { system: string } | { unsigned: string }> = {
  // ---- the outbox and Kolab's own processes ----
  open: { system: 'applies migrations, and frees the outbox claims of a stopped process' },
  listen: { system: 'hears other processes, and runs the outbox work they announce' },
  startWorker: { system: 'runs outbox jobs: cascades, settles and rebases owed by versions whose authors are recorded; a rebase Kolab writes is by kolab' },
  drainOutbox: { system: 'runs outbox jobs, as startWorker' },
  retryOutboxJob: { recorded: ['audit_event:outbox.retried'] },

  // ---- actors, sessions and sign-in ----
  addActor: { recorded: ['actor.created_by', 'account.created_by'] },
  openSession: { recorded: ['session.opened_by'] },
  endSession: { recorded: ['session.ended_by'] },
  switchSession: { recorded: ['session.ended_by', 'session.opened_by'] },
  signInWith: { recorded: ['actor.created_by', 'account.created_by', 'identity.linked_by'] },
  linkIdentity: { recorded: ['identity.linked_by'] },
  registerClient: { unsigned: 'a client registers itself before anyone signs in (RFC 7591); its row is the record, and an unused one is pruned' },
  pruneClients: { unsigned: 'deletes clients no one used, as registerClient does before each registration' },
  oauthClient: { unsigned: 'marks a client used as it starts an authorization, before anyone signs in' },
  beginAuthorization: { unsigned: 'starts an authorization before anyone signs in; it names its person once the identity provider answers (identifyAuthorization)' },
  identifyAuthorization: { recorded: ['oauth_request.actor_id'] },
  abandonAuthorization: { unsigned: 'drops an authorization the identity provider refused, before anyone signed in; nothing of it is kept' },
  declineAuthorization: { unsigned: 'drops an authorization its person declined; nothing of it is kept, and no grant, code or session was made' },
  consent: { recorded: ['oauth_code.person_id', 'kolab.created_by', 'actor.created_by', 'audit_event:grant.set', 'kolab_invite.accepted_by'] },
  exchangeCode: { recorded: ['oauth_grant.person_id', 'session.opened_by', 'session.ended_by'] },
  refreshGrant: { recorded: ['oauth_grant.person_id', 'session.ended_by'] },
  revokeToken: { recorded: ['oauth_grant.revoked_by', 'session.ended_by'] },
  addOwnAgent: { recorded: ['actor.created_by'] },
  createOwnAgent: { recorded: ['actor.created_by'] },
  archiveOwnAgent: { recorded: ['archive_event.done_by', 'session.ended_by'] },

  // ---- invites and access ----
  createInvite: { recorded: ['kolab_invite.created_by'] },
  revokeInvite: { recorded: ['kolab_invite.revoked_by'] },
  acceptInvite: { recorded: ['kolab_invite.accepted_by', 'audit_event:grant.set'] },
  changeGrant: { recorded: ['audit_event:grant.set', 'session.ended_by'] },
  removeGrant: { recorded: ['audit_event:grant.removed', 'session.ended_by'] },

  // ---- accounts, kolabs, teams and grants (the admin's) ----
  addOrganization: { recorded: ['account.created_by'] },
  archive: { recorded: ['archive_event.done_by', 'session.ended_by'] },
  unarchive: { recorded: ['archive_event.done_by'] },
  createOwnKolab: { recorded: ['kolab.created_by'] },
  makeOwnKolab: { recorded: ['kolab.created_by'] },
  createKolab: { recorded: ['kolab.created_by'] },
  addMember: { recorded: ['audit_event:member.set', 'session.ended_by'] },
  removeMember: { recorded: ['audit_event:member.removed', 'session.ended_by'] },
  addTeam: { recorded: ['team.created_by'] },
  addTeamMember: { recorded: ['audit_event:team_member.added', 'session.ended_by'] },
  removeTeamMember: { recorded: ['audit_event:team_member.removed', 'session.ended_by'] },
  grant: { recorded: ['audit_event:grant.set', 'session.ended_by'] },
  revoke: { recorded: ['audit_event:grant.removed', 'session.ended_by'] },

  // ---- nodes, versions and links ----
  createNode: { recorded: ['node.created_by'] },
  draft: { recorded: ['version.actor_id'] },
  applyRuling: { recorded: ['version.actor_id', 'version.submitted_by'] },
  submit: { recorded: ['version.submitted_by'] },
  review: { recorded: ['version.submitted_by'] },
  recordReview: { recorded: ['review_request.reviewer_id'] },
  // Only a version's author abandons it; its review note says so.
  abandon: { recorded: ['version.actor_id', 'version.review_note'] },
  commit: { recorded: ['version.actor_id', 'version.submitted_by'] },
  link: { recorded: ['edge.held_by'] },
  // Removals are part of the author's own draft.
  unlink: { recorded: ['version.actor_id'] },

  // ---- marks, questions and case files ----
  resolveOverride: { recorded: ['precedent.ruled_by', 'version.actor_id', 'version.submitted_by'] },
  clear: { recorded: ['invalidation.cleared_by'] },
  raiseQuery: { recorded: ['query.raised_by'] },
  answerQuery: { recorded: ['query.answered_by'] },
  openCase: { recorded: ['case_file.opened_by', 'position.actor_id'] },
  addPosition: { recorded: ['position.actor_id'] },
  rule: { recorded: ['ruling.actor_id'] },
};

/**
 * Kolab's private helpers whose writes are its own, wherever they are called from: ending the
 * sessions that can no longer reach their kolab, recorded as by `kolab` (session.ended_by), and
 * freeing this process's outbox claims as it closes. A method that writes only through these
 * needs no entry in WRITE_ACTORS.
 */
export const SYSTEM_WRITES = ['endUnreachable', 'freeClaims'] as const;
