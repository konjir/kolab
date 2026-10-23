-- Migration 0024: every write records who made it (W2.20; D70).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Versions (DAT3), rulings (DAT9) and archive events (D52) already said who made them. Now every
-- other write does too. Who made a write, in every column below and in audit_event, is one of:
--   an actor's id    a person or an agent, through their session or their own sign-in
--   'admin'          the admin token (ADMIN_DOER in @konjir/types), until admins are people who
--                    sign in (W2.22, D69); then it is that person's id, and 'admin' stays only on
--                    what the break-glass token did
--   'kolab'          Kolab's own work (SYSTEM_ACTOR), such as ending a session that lost access
-- None of them is a reference to actor: 'admin' and 'kolab', in any case, are no actor's or
-- account's id (actor_not_doer and account_not_doer, below), and actors are archived, never
-- deleted (D52). A doer is never empty or blank.
--
-- A change with a row of its own records it in a column of that row:
--   node.created_by, node.created_at          who made the node, and when
--   account.created_by                        who registered the account: an admin, or the person signing up
--   actor.created_by                          who added the person or agent: an admin, the person signing up, or the agent's owner
--   kolab.created_by                          who made the kolab: an admin, or the person who owns it
--   team.created_by                           who made the team
--   identity.linked_by                        who linked the identity: an admin, or the person signing up with it
--   session.opened_by, session.ended_by       who opened and ended the session: an admin, the person (signing in,
--                                             switching or signing out), or Kolab, when the session lost access
--   kolab_invite.revoked_by                   who revoked the invite
--   oauth_grant.revoked_by                    who revoked the grant: its person signing out, or Kolab, on a replayed token
--   version.submitted_by                      who put a draft to review: a session's actor, the admin applying a
--                                             ruling (D47), or Kolab, for its own rebases and folds
-- A change with no row of its own, because it replaces or deletes one, is a row of audit_event:
-- grants, organization memberships, team memberships and outbox retries. The database refuses a
-- change to kolab_grant, org_member or team_member whose transaction doesn't add the audit_event
-- row of that change (kj_access_audited).
--
-- Rows made before this migration keep null in every new column: who made them was never
-- recorded, and nothing guesses. Every row written from now on names someone: the database
-- refuses one that doesn't (kj_doer_given), so a write path that forgets fails its tests.

-- 'admin' is the admin token's name in what Kolab records, and 'kolab' is Kolab's own, so no actor
-- or account may be called either, in any case. A person never could (sign-up reserves both,
-- D55), and 0002 and 0006 refused 'kolab' exactly; now nothing can take either in any case. Rows
-- already there are checked first: if one holds such a name, this migration stops and says which,
-- rather than leaving a row that would fail its next update.
do $$
declare taken text;
begin
  select string_agg(id, ', ' order by id) into taken from (
    select id from actor where lower(id) in ('admin', 'kolab')
    union select id from account where lower(id) in ('admin', 'kolab')) t;
  if taken is not null then
    raise exception 'migration 0024: % names an actor or account, but ''admin'' and ''kolab'' are reserved for who made a write (W2.20); rename it before applying 0024', taken
      using errcode = 'check_violation';
  end if;
end
$$;
alter table actor add constraint actor_not_doer check (lower(id) not in ('admin', 'kolab'));
alter table account add constraint account_not_doer check (lower(id) not in ('admin', 'kolab'));

alter table node add column created_by text, add column created_at timestamptz;
alter table node alter column created_at set default clock_timestamp();
alter table account add column created_by text;
alter table actor add column created_by text;
alter table kolab add column created_by text;
alter table team add column created_by text;
alter table identity add column linked_by text;
alter table session add column opened_by text, add column ended_by text;
alter table kolab_invite add column revoked_by text;
alter table oauth_grant add column revoked_by text;
alter table version add column submitted_by text;

-- Refuses a row that doesn't name who made it, in the column the trigger names. Each trigger's
-- `when` says which writes need one: every insert, or the update that ends, revokes or submits.
-- Each is a constraint checked as the transaction commits, so a write its other constraints and
-- triggers refuse (an archived kolab's, 0014) is refused for that reason first, and the change
-- fails whole. An empty or blank name is no one. The migration runner alone may write without one
-- (kj_migrating, 0014).
create function kj_doer_given() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if kj_migrating() then return new; end if;
  if nullif(btrim(to_jsonb(new) ->> tg_argv[0]), '') is null then
    raise exception '%.% must name who made this write (W2.20)', tg_table_name, tg_argv[0] using errcode = 'not_null_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_doer_given() from public;

create constraint trigger node_created_by after insert on node deferrable initially deferred for each row execute function kj_doer_given('created_by');
create constraint trigger account_created_by after insert on account deferrable initially deferred for each row execute function kj_doer_given('created_by');
create constraint trigger actor_created_by after insert on actor deferrable initially deferred for each row execute function kj_doer_given('created_by');
create constraint trigger kolab_created_by after insert on kolab deferrable initially deferred for each row execute function kj_doer_given('created_by');
create constraint trigger team_created_by after insert on team deferrable initially deferred for each row execute function kj_doer_given('created_by');
create constraint trigger identity_linked_by after insert on identity deferrable initially deferred for each row execute function kj_doer_given('linked_by');
create constraint trigger session_opened_by after insert on session deferrable initially deferred for each row execute function kj_doer_given('opened_by');
create constraint trigger session_ended_by after insert or update of ended_at on session deferrable initially deferred for each row
  when (new.ended_at is not null) execute function kj_doer_given('ended_by');
create constraint trigger kolab_invite_revoked_by after insert or update of revoked_at on kolab_invite deferrable initially deferred for each row
  when (new.revoked_at is not null) execute function kj_doer_given('revoked_by');
create constraint trigger oauth_grant_revoked_by after insert or update of revoked_at on oauth_grant deferrable initially deferred for each row
  when (new.revoked_at is not null) execute function kj_doer_given('revoked_by');
create constraint trigger version_submitted_by after update of state on version deferrable initially deferred for each row
  when (old.state = 'drafted' and new.state in ('in_review', 'committed')) execute function kj_doer_given('submitted_by');

-- Changes of access and Kolab's own machinery that leave no row of their own: what, by whom and
-- when, kept for audit. Rows are only ever added (audit_event_fixed), like archive_event's.
--   grant.set            a kolab_grant made or replaced: subject is the grantee (a person, agent or
--                        <org>/<team>); detail holds the level and layers
--   grant.removed        a kolab_grant removed: subject is the grantee
--   member.set           a person added to an organization, or their role changed: subject is the
--                        person; detail holds the organization and role
--   member.removed       a person removed from an organization and its teams
--   team_member.added    a person added to a team: detail holds the team
--   team_member.removed  a person removed from a team
--   outbox.retried       an outbox job retried (konjir_admin_outbox): subject is the job's id
-- `kolab_id` is the kolab the change is in, for a grant or an outbox job; null for an
-- organization's or team's membership, which is in no one kolab.
--
-- It is access metadata, like kolab_grant and kolab_invite: only Kolab's own login reads or
-- writes it, and kj_agent and kj_system are granted nothing, so no session reads another's
-- changes (D49, D58). An archived kolab's grants may still be removed (0014), so this table has no
-- kolab_writable trigger: what was done there is still recorded.
create table audit_event (
  id       bigint generated always as identity primary key,
  action   text not null
             constraint audit_event_action_check check (action in
               ('grant.set', 'grant.removed', 'member.set', 'member.removed',
                'team_member.added', 'team_member.removed', 'outbox.retried')),   -- AUDIT_ACTIONS in @konjir/types
  kolab_id text references kolab(id),
  subject  text not null,
  detail   jsonb,
  done_by  text not null constraint audit_event_done_by_check check (btrim(done_by) <> ''),
  done_at  timestamptz not null default clock_timestamp(),
  -- The transaction that added it, so kj_access_audited can find it as that transaction commits.
  -- The top-level transaction's id, even from inside a savepoint.
  tx       xid8 not null default pg_current_xact_id()
);
create index audit_event_kolab on audit_event(kolab_id, id) where kolab_id is not null;
create index audit_event_subject on audit_event(subject, id);
create index audit_event_tx on audit_event(tx, subject);   -- kj_access_recorded's one probe per changed row
alter table audit_event enable row level security;
revoke all on audit_event from public;
revoke all on audit_event from kj_agent, kj_system;
create function kj_audit_event_fixed() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_event: the audit log is only ever added to' using errcode = 'check_violation';
end
$$;
revoke execute on function kj_audit_event_fixed() from public;
create trigger audit_event_fixed before update or delete on audit_event for each row execute function kj_audit_event_fixed();
create trigger audit_event_kept before truncate on audit_event for each statement execute function kj_audit_event_fixed();

-- A change of access has no row of its own to say who made it, so its audit_event row is the
-- record, and the database requires it. As a transaction commits, each row it inserted, updated or
-- deleted in kolab_grant, org_member or team_member must have an audit_event row added by that
-- same transaction (tx) for the same grantee or person (subject) and the same place, with the
-- action of that operation:
--   kolab_grant   insert or update: grant.set, delete: grant.removed; the same kolab_id
--   org_member    insert or update: member.set, delete: member.removed; detail's org is org_id
--   team_member   insert or update: team_member.added, delete: team_member.removed with detail's
--                 team, or member.removed whose detail's teams holds the team (a person removed
--                 from an organization leaves its teams under that one row)
-- An update is checked for its old row as well as its new one, so moving a grant or membership to
-- another kolab, grantee, organization or team needs a record of both. Like kj_doer_given it is
-- deferred, so the change and its record may be written in either order, and the migration runner
-- is exempt. Security definer: audit_event is Kolab's own login's alone. Each check is one probe
-- of audit_event_tx, by transaction and subject.
create function kj_access_recorded(tbl text, r jsonb, removed boolean) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1 from public.audit_event a
     where a.tx = pg_current_xact_id()
       and a.subject = coalesce(r ->> 'user_id', r ->> 'agent_id', r ->> 'team_id')
       and case tbl
         when 'kolab_grant' then a.kolab_id = r ->> 'kolab_id'
                                 and a.action = case when removed then 'grant.removed' else 'grant.set' end
         when 'org_member' then a.detail ->> 'org' = r ->> 'org_id'
                                and a.action = case when removed then 'member.removed' else 'member.set' end
         when 'team_member' then case when removed
                                   then (a.action = 'team_member.removed' and a.detail ->> 'team' = r ->> 'team_id')
                                     or (a.action = 'member.removed' and coalesce(a.detail -> 'teams', '[]'::jsonb) ? (r ->> 'team_id'))
                                   else a.action = 'team_member.added' and a.detail ->> 'team' = r ->> 'team_id' end
         else false
       end)
$$;
revoke execute on function kj_access_recorded(text, jsonb, boolean) from public;
create function kj_access_audited() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  r jsonb;
begin
  if kj_migrating() then return null; end if;
  if tg_op in ('INSERT', 'UPDATE') and not public.kj_access_recorded(tg_table_name, to_jsonb(new), false) then
    r := to_jsonb(new);
  elsif tg_op in ('UPDATE', 'DELETE') and not public.kj_access_recorded(tg_table_name, to_jsonb(old), tg_op = 'DELETE') then
    r := to_jsonb(old);
  end if;
  if r is not null then
    raise exception '%: a change of access to % must be recorded in the audit log, with who made it (W2.20)',
      tg_table_name, coalesce(r ->> 'user_id', r ->> 'agent_id', r ->> 'team_id')
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_access_audited() from public;
create constraint trigger kolab_grant_audited after insert or update or delete on kolab_grant deferrable initially deferred for each row
  execute function kj_access_audited();
create constraint trigger org_member_audited after insert or update or delete on org_member deferrable initially deferred for each row
  execute function kj_access_audited();
create constraint trigger team_member_audited after insert or update or delete on team_member deferrable initially deferred for each row
  execute function kj_access_audited();

-- Who made a node is shown only to readers in the node's own kolab (D49, D58): a reader from
-- another kolab sees its committed versions and their authors, but not who made the node, who
-- may have written nothing that reader can see. So kj_agent reads every column of node but
-- created_by, and reads that through kj_node_creator, which answers only for a node of the
-- session's own kolab. Kolab's own login, and kj_system, read it as before.
revoke select on node from kj_agent;
grant select (id, kind, layer, title, kolab_id, name, created_at) on node to kj_agent;
create function kj_node_creator(p_node text) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select n.created_by from public.node n where n.id = p_node and n.kolab_id = (select public.kj_session_kolab())
$$;
revoke execute on function kj_node_creator(text) from public;
grant execute on function kj_node_creator(text) to kj_agent;
