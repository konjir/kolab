import type { AuditAction } from '@konjir/types';

/**
 * Where a write records who made it (W2.20, D70): the columns of its own rows, `table.column`, and
 * the audit log's actions, `audit_event:<action>`, for a change that leaves no row of its own.
 */
export type ActorRecord = `${string}.${string}` | `audit_event:${AuditAction}`;

/**
 * Why a write records no one of its own (W2.20): a closed list, so a new reason is a change here,
 * reviewed like any other.
 * - `system`: Kolab's own work, which no one asked for when it runs; what it writes is recorded as
 *   by `kolab`, or belongs to a version whose author and submitter are recorded.
 * - `unsigned`: a write before anyone signs in, on a row that names no one yet (OAuth's client
 *   registration and authorization in progress, RFC 7591 and 6749).
 */
export const NO_ACTOR_REASONS = {
  system: {
    migrations: 'applies migrations, and frees the outbox claims of a process that stopped',
    outbox: 'runs outbox jobs: cascades, settles and rebases owed by versions whose authors and submitters are recorded; a rebase Kolab writes is by kolab',
  },
  unsigned: {
    client_registration: 'a client registers itself before anyone signs in (RFC 7591); its row is the record, and one no one uses is pruned',
    client_pruning: 'deletes clients no one used, as registration does before each one',
    authorization_pending: 'an authorization before anyone has signed in: it names its person once the identity provider answers (identifyAuthorization)',
    authorization_dropped: 'drops an authorization that was refused or declined before it made any grant, code or session; nothing of it is kept',
  },
} as const;
export type SystemReason = keyof typeof NO_ACTOR_REASONS.system;
export type UnsignedReason = keyof typeof NO_ACTOR_REASONS.unsigned;

/**
 * How each of Kolab's public methods that writes records who made the write (W2.20, D70):
 * - `recorded`: where it is recorded (ActorRecord): from the session's actor, the person signing
 *   in, or the `by` its caller must pass (an admin's, the admin token's until admins are people,
 *   W2.22, or Kolab's own)
 * - `system` or `unsigned`: why it records no one, one of NO_ACTOR_REASONS
 *
 * What write-actors.test.ts checks, and nothing more:
 * - the methods listed are exactly the public methods of Kolab, in kolab.ts, that write: whose own
 *   SQL inserts, updates or deletes, or that call (as `this.<method>(`, or a function of the
 *   module) something that does, other than SYSTEM_WRITES
 * - each `table.column` place is a column of the schema, and the SQL reachable from the method
 *   that way names the column in an insert of a row of that table, or sets it in an update of
 *   that table; each `audit_event:<action>` place is an action of the audit log, and that SQL
 *   includes a call of audit() with that action
 * - the methods with `system` or `unsigned` are exactly the ones the test lists, so adding one is
 *   a change to the test as well
 * - no other source file of the engine or the apps writes SQL, and Kolab has no method written as
 *   an arrow-function property, which the scan would miss
 * Whether the right person is recorded is checked by its scenario tests, and the database refuses
 * a row that names no one (migration 0024).
 */
export const WRITE_ACTORS: Record<string, { recorded: ActorRecord[] } | { system: SystemReason } | { unsigned: UnsignedReason }> = {
  // ---- the outbox and Kolab's own processes ----
  open: { system: 'migrations' },
  listen: { system: 'outbox' },
  startWorker: { system: 'outbox' },
  drainOutbox: { system: 'outbox' },
  retryOutboxJob: { recorded: ['audit_event:outbox.retried'] },

  // ---- actors, sessions and sign-in ----
  addActor: { recorded: ['actor.created_by', 'account.created_by'] },
  openSession: { recorded: ['session.opened_by'] },
  endSession: { recorded: ['session.ended_by'] },
  switchSession: { recorded: ['session.ended_by', 'session.opened_by'] },
  signInWith: { recorded: ['actor.created_by', 'account.created_by', 'identity.linked_by'] },
  linkIdentity: { recorded: ['identity.linked_by'] },
  registerClient: { unsigned: 'client_registration' },
  pruneClients: { unsigned: 'client_pruning' },
  oauthClient: { unsigned: 'authorization_pending' },
  beginAuthorization: { unsigned: 'authorization_pending' },
  identifyAuthorization: { recorded: ['oauth_request.actor_id'] },
  abandonAuthorization: { unsigned: 'authorization_dropped' },
  declineAuthorization: { unsigned: 'authorization_dropped' },
  consent: { recorded: ['oauth_code.person_id', 'kolab.created_by', 'actor.created_by', 'audit_event:grant.set', 'kolab_invite.accepted_by'] },
  exchangeCode: { recorded: ['oauth_grant.person_id', 'session.opened_by', 'session.ended_by'] },
  // A rotation is the grant's person's: each refresh token names its grant, which names them.
  refreshGrant: { recorded: ['oauth_refresh_token.grant_id', 'session.ended_by', 'oauth_grant.revoked_by'] },
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
  abandon: { recorded: ['version.review_note'] },
  commit: { recorded: ['version.actor_id', 'version.submitted_by'] },
  link: { recorded: ['edge.held_by'] },
  // A removal belongs to its author's own draft (only the author unlinks), which names them.
  unlink: { recorded: ['link_removal.version_id'] },

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
