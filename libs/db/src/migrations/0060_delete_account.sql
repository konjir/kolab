-- Migration 0060: a person deletes their own account (konjir_delete_my_account; Lee, 2026-11-23).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Apple requires that anyone who can make an account in an app can delete it there (App Store
-- guideline 5.1.1(v)). Lee's decision of 2026-11-23, "remove me, keep my words": deleting an
-- account leaves every kolab, ends every sign-in and push device, removes the person's own agents,
-- and deletes their identity (the GitHub account it was) and profile. The messages they and their
-- agents sent stay where they are, shown as from "a deleted account". A kolab they alone are in is
-- erased with the account (0056); one where anyone else is a member must be archived, or its other
-- members removed, first.
--
-- An actor's id is the GitHub login it signed up with (signUpNames), so keeping it would keep the
-- login on every message, mention, invitation and audit row. Deleting an account re-keys it: the
-- person's id, and each of their agents', becomes an opaque one, `deleted-<random>` (an agent's
-- `deleted-<random>-<n>`), everywhere it is written, in the one transaction that deletes it. What
-- is kept of them then is a tombstone under that id and nothing else: their names become the new
-- id, and their identity row goes. Text other people wrote (an "@bo" in a message) stays as written.
--
--   account.deleted_at  when the person deleted their account: set once, with archived_at (0014),
--                       so a deleted person, and their agents, hold nothing anywhere (kj_access) and
--                       open no session (kj_session_openable). Never cleared, and archived_at is
--                       never cleared while it is set, so no unarchive brings a deleted account back.
--                       Only a user's account is deleted; an organization's never is.
--
--   retired_name        the old ids, so they are never used again: each kept as a one-way digest
--                       (the unsalted sha256 of the lowercased name), not as the name. That keeps
--                       the name out of a plain read of the table, but it isn't anonymous: anyone
--                       who guesses a name, a GitHub login say, can hash it and find it there. No
--                       account or actor is made with one again, in any case, nor with one
--                       followed by `-` (`<old>-x` would read as one of their agents, D30), so a
--                       later sign-up with the same GitHub account is a new person, `<login>_2` and
--                       on. Only ever added to. No name starting `deleted-` is made either but by
--                       the re-key.
--
-- What the re-key leaves as it is, so still holds the old login: names the person chose for things
-- that stay (the ids of kolabs they made, an archived kolab's host's name and folder), a
-- repository's URL (github.com/<login>/...) and its audit row, and text others wrote (an "@bo" in
-- a message).
--
-- The re-key. Each foreign key to actor or account now cascades an update of the id (ON UPDATE
-- CASCADE), but for those that hold a generated kind (below): Kolab updates account.id, which
-- carries their agents' owner and their kolabs' owner, and the person's actor.id, which carries
-- every row that names them; then each agent's actor.id. A column that names an actor with no
-- foreign key (who made or ended something, an audit row's subject) Kolab updates itself: each is
-- in kj_actor_columns() here and ACTOR_ID_COLUMNS in the engine, which the engine's tests hold to
-- each other and to the schema (a later column that names an actor takes a foreign key, or a
-- place in both). Rows that are never edited (messages, the audit and archive logs, work events,
-- evidence, case files, jobs, repositories, an admin's row) and rows of archived kolabs may change
-- in that transaction, but only so: kj.rekey, set only by Kolab's own login (never a session's
-- role, as kj.erasing, 0056), maps each old id to its new one, and such a row may change only in
-- the columns that name an actor, each only from one of those old ids to the new id it maps to
-- (kj_rekey_only). The same setting lets the deletion scrub what archived kolabs keep of the person
-- (their notification prefs, invitations to their identity), and nothing else: an archived kolab
-- takes no other insert or delete under it.
--
-- No id of an actor or an account changes otherwise (kj_name_free), and a write that names a
-- deleted account's old id where no foreign key would refuse it (kj_actor_named) is refused, or,
-- if it was under way as the deletion began, waits for it to run first, then is re-keyed with the
-- rest: kj_actor_named holds the actor's row as a foreign key's check does, and the deletion locks
-- its actors' rows first.
--
-- The database holds to it, whatever role writes: a deleted account's row, and every actor row of
-- it (the person and their agents), is never removed, renamed, re-keyed, re-owned nor changes kind;
-- no identity is linked to a deleted person again; and kj_actor_deleted says whether an actor's
-- account is deleted, for what shows a message's sender (Kolab reads messages as kj_system).
--
-- A new nullable column, a table, a check, triggers and functions, a new action in the audit log
-- (account.deleted, which records the event, never the person's data), and the foreign keys to
-- actor or account made again with ON UPDATE CASCADE, which checks every row as before. No row that
-- exists changes. It refuses a database where an actor's or an account's id already starts with
-- `deleted-`, which would read as a deleted account's: deploy/preflight/0060.sql lists any.

do $$
declare bad text;
begin
  select q.nodes into bad from (
-- check:begin
select 1 as ord, 'an actor''s or account''s id starts with deleted-, which after 0060 names a deleted account only' as why,
       string_agg(x.what || ' ' || x.id, ', ' order by x.what, x.id) as nodes
  from (select 'actor' as what, id from actor where lower(id) like 'deleted-%'
        union all
        select 'account', id from account where lower(id) like 'deleted-%') x
having count(*) > 0
-- check:end
  ) q;
  if bad is not null then
    raise exception 'migration 0060: an actor''s or account''s id starts with deleted-, which after 0060 names a deleted account only: %. Rename each first; deploy/preflight/0060.sql lists the same (deploy/konjir-ops.sh preflight 0060).', bad;
  end if;
end
$$;

alter table account add column deleted_at timestamptz;
alter table account add constraint account_deleted_check
  check (deleted_at is null or (kind = 'user' and archived_at is not null));

-- Every foreign key to an actor or an account carries a change of its id (the re-key, above), but
-- those that hold a generated kind (Postgres can't cascade into one): a grant's, a membership's and
-- a team's, none of which names a deleted person once their deletion has removed them, and a
-- person's actor's to their account, which the re-key changes itself, so that one may wait for the
-- end of the transaction (deferrable; still checked at once unless deferred). Only a key that
-- doesn't cascade already is made again, with ON UPDATE CASCADE after its REFERENCES clause (and
-- its MATCH, before any ON DELETE or DEFERRABLE), so a run over a key made so already changes
-- nothing; a key with another ON UPDATE action is a schema this doesn't know, and stops it.
do $$
declare
  c record;
  def text;
begin
  for c in select f.conrelid::regclass::text as tbl, f.conname, pg_get_constraintdef(f.oid) as def from pg_constraint f
            where f.contype = 'f' and f.confrelid in ('public.actor'::regclass, 'public.account'::regclass) and f.confupdtype <> 'c'
              and not exists (select 1 from pg_attribute a where a.attrelid = f.conrelid and a.attnum = any(f.conkey) and a.attgenerated <> '')
            order by f.conrelid::regclass::text, f.conname loop
    def := regexp_replace(c.def, '^(FOREIGN KEY \([^)]*\) REFERENCES [^(]+\([^)]*\)( MATCH [A-Z]+)?)', '\1 ON UPDATE CASCADE');
    if position('ON UPDATE' in c.def) > 0 or def = c.def then
      raise exception 'migration 0060: foreign key % on % reads %, which it doesn''t know how to make cascade', c.conname, c.tbl, c.def;
    end if;
    execute format('alter table %s drop constraint %I, add constraint %I %s', c.tbl, c.conname, c.conname, def);
  end loop;
end
$$;
alter table actor alter constraint actor_person_is_user deferrable initially immediate;

-- Whether `p_actor` is a deleted person, or an agent of one.
create function kj_actor_deleted(p_actor text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.actor a join public.account o on o.id = coalesce(a.owner_id, a.id)
                  where a.id = p_actor and o.deleted_at is not null)
$$;
revoke execute on function kj_actor_deleted(text) from public;
grant execute on function kj_actor_deleted(text) to kj_system, kj_agent;

-- The re-key under way in this transaction, while Kolab's own login deletes an account (kj.rekey):
-- a JSON object of each old id to the new one, `deleted-<12 hex>` or an agent's `deleted-<12
-- hex>-<n>`; null otherwise, and always for a session's role. A kj.rekey that is anything else is
-- an error, never a re-key.
create function kj_rekeying() returns jsonb
language plpgsql stable as $$
declare m jsonb;
begin
  if current_setting('role') <> 'none' or coalesce(current_setting('kj.rekey', true), '') = '' then return null; end if;
  m := current_setting('kj.rekey', true)::jsonb;
  if jsonb_typeof(m) <> 'object' or m = '{}'::jsonb or exists (
       select 1 from jsonb_each(m) e(k, v)
        where jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^deleted-[0-9a-f]{12}(-[1-9][0-9]*)?$' or lower(k) like 'deleted-%') then
    raise exception 'kj.rekey must map each id being re-keyed to its deleted-<hex> id' using errcode = 'invalid_parameter_value';
  end if;
  return m;
end
$$;

-- Where an actor's id is written with no foreign key to carry it: each table and column, and for a
-- JSON column the key that holds it. The engine's ACTOR_ID_COLUMNS, which its tests hold to this,
-- and to the schema. Which rows of audit_event.subject and archive_event.target_id name an actor
-- is kj_names_actor's.
create function kj_actor_columns() returns table (tbl text, col text, key text)
language sql immutable as $$
  values ('account', 'created_by', null::text), ('actor', 'created_by', null),
         ('archive_event', 'target_id', null), ('archive_event', 'done_by', null),
         ('audit_event', 'subject', null), ('audit_event', 'done_by', null), ('audit_event', 'detail', 'owner'),
         ('case_file', 'opened_by', null), ('position', 'actor_id', null), ('ruling', 'actor_id', null), ('precedent', 'ruled_by', null),
         ('evidence', 'recorded_by', null), ('evidence', 'redacted_by', null),
         ('identity', 'linked_by', null), ('invalidation', 'cleared_by', null), ('job', 'ended_by', null),
         ('kolab', 'created_by', null), ('kolab_invite', 'revoked_by', null), ('kolab_policy', 'updated_by', null),
         ('konjir_admin', 'granted_by', null), ('node', 'created_by', null), ('oauth_grant', 'revoked_by', null),
         ('outbox', 'payload', 'approvedBy'), ('outbox', 'payload', 'rulingBy'),
         ('query', 'raised_by', null), ('query', 'answered_by', null),
         ('repository', 'registered_by', null), ('repository', 'confirmed_by', null), ('repository', 'archived_by', null),
         ('session', 'opened_by', null), ('session', 'ended_by', null), ('team', 'created_by', null),
         ('version', 'actor_id', null), ('version', 'submitted_by', null),
         ('work_event', 'actor_id', null), ('work_event', 'assignee_from', null), ('work_event', 'assignee_to', null),
         ('work_event', 'redacted_by', null)
$$;

-- The audit actions whose subject is an actor; for the rest it is a kolab, a repository, a verb...
create function kj_audit_subject_is_actor(p_action text) returns boolean
language sql immutable as $$
  select p_action in ('grant.set', 'grant.removed', 'member.set', 'member.removed', 'team_member.added', 'team_member.removed',
                      'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'push_device.unregistered', 'host.ended',
                      'account.deleted')
$$;

-- Whether row `r` of `tbl` names an actor in `col` (kj_actor_columns): always, but for an audit
-- row's subject and an archive row's target, which name one only for some actions and kinds.
create function kj_names_actor(tbl text, col text, r jsonb) returns boolean
language sql immutable as $$
  select case when tbl = 'audit_event' and col = 'subject' then public.kj_audit_subject_is_actor(r ->> 'action')
              when tbl = 'archive_event' and col = 'target_id' then r ->> 'target_kind' = 'actor'
              else true end
$$;

-- The columns of `tbl` a re-key may change, whole: each a foreign key to actor or account carries,
-- each of kj_actor_columns() but a JSON column's key, and an actor's and an account's own id.
create function kj_rekey_columns(p_tbl text) returns text[]
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select array(
    select a.attname::text from pg_constraint f join pg_attribute a on a.attrelid = f.conrelid and a.attnum = any(f.conkey)
     where f.contype = 'f' and f.conrelid = to_regclass('public.' || quote_ident(p_tbl))
       and f.confrelid in ('public.actor'::regclass, 'public.account'::regclass) and a.attgenerated = ''
    union
    select c.col from public.kj_actor_columns() c where c.tbl = p_tbl and c.key is null
    union
    select 'id' where p_tbl in ('actor', 'account'))
$$;

-- Whether value `a` became `b` by re-key `m` alone: unchanged, or `a` exactly one of the ids being
-- re-keyed and `b` exactly the id it maps to, or both arrays of the same length whose elements each
-- did so.
create function kj_rekeyed_to(a jsonb, b jsonb, m jsonb) returns boolean
language plpgsql immutable as $$
begin
  if a is not distinct from b then return true; end if;
  if a is null or b is null then return false; end if;
  if jsonb_typeof(a) = 'string' and jsonb_typeof(b) = 'string' then
    return coalesce(m -> (a #>> '{}') = b, false);
  end if;
  if jsonb_typeof(a) = 'array' and jsonb_typeof(b) = 'array' then
    return jsonb_array_length(a) = jsonb_array_length(b)
       and not exists (select 1 from generate_series(0, jsonb_array_length(a) - 1) i where not public.kj_rekeyed_to(a -> i, b -> i, m));
  end if;
  return false;
end
$$;

-- Whether row `o` of `tbl` becoming `n` is only a re-key: Kolab's own login is re-keying (kj.rekey),
-- and each column that changed is one that names an actor (kj_rekey_columns, or a JSON column's
-- key in kj_actor_columns, the rest of that column unchanged), changed only from an id being
-- re-keyed to exactly the id it maps to. Nothing else changes: no message's body, no other actor's id.
create function kj_rekey_only(tbl text, o jsonb, n jsonb) returns boolean
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare
  m jsonb := public.kj_rekeying();
  cols text[];
  c text;
  keys text[];
  k text;
begin
  if m is null then return false; end if;
  cols := public.kj_rekey_columns(tbl);
  for c in select jsonb_object_keys(o) union select jsonb_object_keys(n) loop
    continue when (o -> c) is not distinct from (n -> c);
    continue when c = any(cols) and public.kj_rekeyed_to(o -> c, n -> c, m);
    keys := array(select x.key from public.kj_actor_columns() x where x.tbl = kj_rekey_only.tbl and x.col = c and x.key is not null);
    if cardinality(keys) = 0 or jsonb_typeof(o -> c) <> 'object' or jsonb_typeof(n -> c) <> 'object'
       or ((o -> c) - keys) is distinct from ((n -> c) - keys) then
      return false;
    end if;
    foreach k in array keys loop
      if not public.kj_rekeyed_to(o -> c -> k, n -> c -> k, m) then return false; end if;
    end loop;
  end loop;
  return true;
end
$$;

-- The rows that are never edited may be re-keyed (kj_rekey_only), and only that; otherwise as before.
create or replace function kj_message_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'DELETE' and public.kj_erasing(old.kolab_id) then return old; end if;
  raise exception '%: a message and its receipt are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;

create or replace function kj_channel_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'DELETE' and public.kj_erasing(old.kolab_id) then return old; end if;
  raise exception '%: a channel, its messages and their mentions are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;

create or replace function kj_audit_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  raise exception 'audit_event: the audit log is only ever added to' using errcode = 'check_violation';
end
$$;

create or replace function kj_archive_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  raise exception 'archive_event: the archive log is only ever added to' using errcode = 'check_violation';
end
$$;

create or replace function kj_work_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.actor_id = 'redacted' and new.note is null
     and (new.assignee_from is null or new.assignee_from = 'redacted') and (new.assignee_to is null or new.assignee_to = 'redacted')
     and (new.id, new.kolab_id, new.binding_node_id, new.element_id, new.kind, new.from_state, new.to_state, new.version_id, new.concerned, new.at)
         is not distinct from
         (old.id, old.kolab_id, old.binding_node_id, old.element_id, old.kind, old.from_state, old.to_state, old.version_id, old.concerned, old.at) then
    return new;
  end if;
  raise exception 'work_event: events are never edited or removed (PLN5); only Kolab redacts one''s actor and note' using errcode = 'check_violation';
end
$$;

create or replace function kj_evidence_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.title is null and new.files is null
     and (new.id, new.kolab_id, new.binding_node_id, new.element_id, new.event_id, new.kind, new.ref, new.url, new.recorded_by, new.at,
          new.repository_id, new.before_repositories, new.checks)
         is not distinct from
         (old.id, old.kolab_id, old.binding_node_id, old.element_id, old.event_id, old.kind, old.ref, old.url, old.recorded_by, old.at,
          old.repository_id, old.before_repositories, old.checks) then
    return new;
  end if;
  raise exception 'evidence: evidence is never edited or removed (PLN5); only Kolab redacts its text' using errcode = 'check_violation';
end
$$;

create or replace function kj_repository_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'UPDATE'
     and (new.id, new.kolab_id, new.url, new.root_sha, new.binding_node_id, new.registered_by, new.registered_at)
         is not distinct from (old.id, old.kolab_id, old.url, old.root_sha, old.binding_node_id, old.registered_by, old.registered_at)
     and (old.confirmed_at is null or (new.confirmed_by, new.confirmed_at, new.confirmed_binding_node_id, new.confirmed_element_id)
          is not distinct from (old.confirmed_by, old.confirmed_at, old.confirmed_binding_node_id, old.confirmed_element_id))
     and (old.archived_at is null or (new.archived_by, new.archived_at) is not distinct from (old.archived_by, old.archived_at)) then
    return new;
  end if;
  raise exception 'repository: a repository''s URL, root commit, binding and registration never change, it is confirmed and archived once, and it is never removed (D98)'
    using errcode = 'check_violation';
end
$$;

create or replace function kj_job_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'UPDATE' and old.ended_at is null
     and (new.id, new.kolab_id, new.person_id, new.runner_session_id, new.machine, new.agent_id, new.session_id, new.kind,
          new.binding_node_id, new.element_id, new.version_id, new.review_request_id, new.started_at,
          new.query_id, new.mark_id, new.spec_node_id, new.spec_element_id)
         is not distinct from
         (old.id, old.kolab_id, old.person_id, old.runner_session_id, old.machine, old.agent_id, old.session_id, old.kind,
          old.binding_node_id, old.element_id, old.version_id, old.review_request_id, old.started_at,
          old.query_id, old.mark_id, old.spec_node_id, old.spec_element_id) then
    return new;
  end if;
  raise exception 'job: a job is never deleted, and changes only its lease until it ends, once (JOB1)' using errcode = 'check_violation';
end
$$;

create or replace function kj_case_fixed() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '%: case files, positions and rulings are never removed: a ruling is precedent, and a later one says what it replaces', tg_table_name
      using errcode = 'check_violation';
  end if;
  if tg_table_name = 'ruling' then
    raise exception 'ruling %: a ruling never changes once given; give another that replaces it', old.id
      using errcode = 'check_violation';
  elsif tg_table_name = 'position' then
    if new.id is distinct from old.id or new.case_file_id is distinct from old.case_file_id
       or new.actor_id is distinct from old.actor_id or new.claim is distinct from old.claim
       or new.evidence is distinct from old.evidence or new.created_at is distinct from old.created_at
       or new.seeks is distinct from old.seeks
       or (old.verdict is not null and new.verdict is distinct from old.verdict) then
      raise exception 'position %: a position never changes once taken; only its ruling sets its verdict, once', old.id
        using errcode = 'check_violation';
    end if;
    if new.verdict is not null and old.verdict is null
       and not exists (select 1 from public.ruling r where r.case_file_id = new.case_file_id) then
      raise exception 'position %: only its case file''s ruling sets its verdict, and case file % has none', old.id, new.case_file_id
        using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'case_file' then
    if new.id is distinct from old.id or new.version_id is distinct from old.version_id
       or new.element_id is distinct from old.element_id or new.question is distinct from old.question
       or new.opened_by is distinct from old.opened_by or new.opened_at is distinct from old.opened_at
       or (old.state <> 'open' and (new.state is distinct from old.state or new.superseded_by is distinct from old.superseded_by)) then
      raise exception 'case file %: a case file never changes once opened, except to be ruled on or superseded, once', old.id
        using errcode = 'check_violation';
    end if;
    if new.state = 'ruled' and old.state = 'open'
       and not exists (select 1 from public.ruling r where r.case_file_id = new.id) then
      raise exception 'case file %: a case file is ruled only with its ruling', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

-- An agent's owner changes only by a re-key of that owner.
create or replace function kj_actor_frozen() returns trigger
language plpgsql as $$
begin
  if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return new; end if;
  if new.kind is distinct from old.kind or new.owner_id is distinct from old.owner_id then
    raise exception 'actor %: kind and owner never change once added', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- A Konjir admin's row changes by a re-key (who made them one) without a record of its own.
create or replace function kj_admin_audited() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  r record;
  act text;
begin
  if kj_migrating() then return null; end if;
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then return null; end if;
  end if;
  if tg_op = 'DELETE' then r := old; act := 'admin.revoked'; else r := new; act := 'admin.granted'; end if;
  if not exists (select 1 from public.audit_event a where a.tx = pg_current_xact_id() and a.subject = r.actor_id and a.action = act) then
    raise exception 'konjir_admin: making or removing an admin (%) must be recorded in the audit log, with who did it (W2.22)', r.actor_id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

-- Whether deleting row `r` of `tbl` is the deletion of an account scrubbing what an archived kolab
-- keeps of the person (re-key `m`): their own notification prefs, or an invitation to their
-- identity (whose row the deletion removes after).
create function kj_rekey_scrubs(tbl text, r jsonb, m jsonb) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case tbl
    when 'notification_pref' then m ? (r ->> 'actor_id')
    when 'kolab_invitation' then exists (select 1 from public.identity i where m ? i.actor_id and i.provider = r ->> 'provider' and i.subject = r ->> 'subject')
    else false end
$$;
revoke execute on function kj_rekey_scrubs(text, jsonb, jsonb) from public;

-- An archived kolab's rows change while Kolab's own login deletes an account (kj.rekey), but only
-- so: an update that is a re-key alone (kolab_rekeyed, row by row, below), and a delete of what it
-- keeps of the person (kj_rekey_scrubs). No insert, and no other update or delete.
create or replace function kj_kolab_writable() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  k text;
  m jsonb;
begin
  if kj_migrating() then return null; end if;
  m := kj_rekeying();
  if m is not null and tg_op = 'UPDATE' then return null; end if;
  select d.kolab_id into k from kj_rows d
   where kj_kolab_archived(d.kolab_id) and (m is null or tg_op <> 'DELETE' or not kj_rekey_scrubs(tg_table_name, to_jsonb(d), m)) limit 1;
  if k is not null then
    raise exception 'kolab % is archived: its data is kept, and nothing in it can change until an admin unarchives it', k
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

-- While kj.rekey is set, each row of an archived kolab that is updated changes by the re-key alone.
create function kj_kolab_rekeyed() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if kj_kolab_archived(old.kolab_id) and not kj_rekey_only(tg_table_name, to_jsonb(old), to_jsonb(new)) then
    raise exception 'kolab % is archived: its data is kept, and nothing in it changes but by the re-key of a deleted account', old.kolab_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_kolab_rekeyed() from public;
do $$
declare t text;
begin
  for t in select distinct c.relname::text from pg_trigger g join pg_class c on c.oid = g.tgrelid
            where g.tgname = 'kolab_writable_update' and not g.tgisinternal order by 1 loop
    execute format('create trigger kolab_rekeyed before update on %I for each row
                      when (coalesce(current_setting(''kj.rekey'', true), '''') <> '''') execute function kj_kolab_rekeyed()', t);
  end loop;
end
$$;

-- The names of deleted accounts and their agents, never given again, each as a one-way digest
-- (above: not anonymous to anyone who guesses the name).
create table retired_name (
  digest     text primary key constraint retired_name_digest_check check (digest ~ '^[0-9a-f]{64}$'),
  retired_at timestamptz not null default now()
);
alter table retired_name enable row level security;
create function kj_retired_name_fixed() returns trigger
language plpgsql as $$
begin
  raise exception 'retired_name: a retired name is never given again, so it is never removed' using errcode = 'check_violation';
end
$$;
revoke execute on function kj_retired_name_fixed() from public;
create trigger retired_name_fixed before update or delete on retired_name for each row execute function kj_retired_name_fixed();
create trigger retired_name_kept before truncate on retired_name for each statement execute function kj_retired_name_fixed();

-- How retired_name holds a name: the sha256 of it lowercased, in hex, unsalted, so the same name
-- always finds it.
create function kj_name_digest(p_name text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(lower(p_name), 'UTF8')), 'hex')
$$;

-- Whether `p_name` is a retired name, or one followed by `-` and more, in any case; but for a name
-- in the namespace of an account that holds a longer part of it (`bo-smith-x` is bo-smith's to
-- give, as addOwnAgent's squat check has it, D30).
create function kj_name_retired(p_name text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.retired_name r where r.digest in (
    select public.kj_name_digest(p_name)
    union all
    select public.kj_name_digest(left(p_name, i - 1)) from generate_series(2, length(p_name)) i
     where substr(p_name, i, 1) = '-'
       and not exists (select 1 from public.account o where length(o.id) >= i - 1
                                                        and left(lower(p_name), length(o.id) + 1) = lower(o.id) || '-')))
$$;
revoke execute on function kj_name_retired(text) from public;

-- No account or actor takes a retired name, nor one starting `deleted-`; and an account's or
-- actor's id never changes, whatever role asks (its foreign keys would carry a rename everywhere),
-- but by the re-key of a deleted account: under kj.rekey, to exactly the new id it maps the old one
-- to. A refusal of a retired name names the constraint retired_name, so a sign-up that races a
-- deletion can tell it from any other.
create function kj_name_free() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if kj_migrating() then return new; end if;
  if tg_op = 'UPDATE' then
    if new.id is not distinct from old.id or kj_rekeying() ->> old.id = new.id then return new; end if;
    raise exception '%: an account''s or actor''s id never changes, but to the id its account''s deletion gives it', old.id using errcode = 'check_violation';
  end if;
  if lower(new.id) like 'deleted-%' then
    raise exception '%: a name starting deleted- is a deleted account''s, and no one else''s', new.id
      using errcode = 'check_violation', constraint = 'retired_name';
  end if;
  if kj_name_retired(new.id) then
    raise exception '%: that name can''t be used: it was a deleted account''s, and is never given to anyone again', new.id
      using errcode = 'check_violation', constraint = 'retired_name';
  end if;
  return new;
end
$$;
revoke execute on function kj_name_free() from public;
create trigger account_name_free before insert or update of id on account for each row execute function kj_name_free();
create trigger actor_name_free before insert or update of id on actor for each row execute function kj_name_free();

-- A write that names an actor where no foreign key checks it (kj_actor_columns) holds that actor's
-- row as a foreign key's check would (for key share), so a deletion of its account, which locks it
-- first, waits for the write and re-keys it with the rest; and one that names a deleted account's
-- old id (retired_name, exactly) is refused, since nothing will re-key it. A value that is no
-- actor's and was never one (the admin token's name, Kolab's, a kolab's id where the row names no
-- actor) is written as before.
create function kj_actor_named() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  n jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  c record;
  v text;
begin
  if kj_migrating() then return new; end if;
  for c in select x.col, x.key from kj_actor_columns() x where x.tbl = tg_table_name loop
    v := case when c.key is null then n ->> c.col else n -> c.col ->> c.key end;
    continue when v is null
      or (o is not null and v is not distinct from (case when c.key is null then o ->> c.col else o -> c.col ->> c.key end));
    perform 1 from actor a where a.id = v for key share;
    if not found and kj_names_actor(tg_table_name, c.col, n)
       and exists (select 1 from retired_name r where r.digest = kj_name_digest(v)) then
      raise exception '%.%: % was a deleted account''s, which nothing names again', tg_table_name, c.col, v
        using errcode = 'foreign_key_violation', constraint = 'retired_name';
    end if;
  end loop;
  return new;
end
$$;
revoke execute on function kj_actor_named() from public;
do $$
declare t record;
begin
  for t in select x.tbl, string_agg(distinct format('%I', x.col), ', ') as cols from kj_actor_columns() x group by x.tbl order by x.tbl loop
    execute format('create trigger actor_named before insert or update of %s on %I for each row execute function kj_actor_named()', t.cols, t.tbl);
  end loop;
end
$$;

-- A deleted account stays deleted and archived, keeps its id, and is never removed.
create function kj_account_deleted_kept() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.deleted_at is not null then
      raise exception 'account %: a deleted account is kept, so its name is never taken again', old.id using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.deleted_at is not null and (new.deleted_at is distinct from old.deleted_at or new.archived_at is distinct from old.archived_at
                                     or new.id is distinct from old.id or new.name is distinct from old.name
                                     or new.kind is distinct from old.kind) then
    raise exception 'account %: a deleted account never changes again', old.id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger account_deleted_kept before update or delete on account for each row execute function kj_account_deleted_kept();

-- A deleted person's actor, and their agents', are never removed, renamed, re-keyed, re-owned nor
-- change kind: their messages name them.
create function kj_actor_deleted_kept() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if public.kj_actor_deleted(old.id) and (tg_op = 'DELETE' or new.id is distinct from old.id or new.name is distinct from old.name
                                          or new.owner_id is distinct from old.owner_id or new.kind is distinct from old.kind) then
    raise exception 'actor %: a deleted account''s actors are kept as they are, so the name is never taken again', old.id using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke execute on function kj_actor_deleted_kept() from public;
create trigger actor_deleted_kept before update or delete on actor for each row execute function kj_actor_deleted_kept();

-- Only a person has an identity (0018), and never a deleted one: a later sign-in with the same
-- GitHub account signs up as a new person.
create or replace function kj_identity_of_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from public.actor a where a.id = new.actor_id and a.kind = 'person') then
    raise exception 'only a person has an identity; % is not one', new.actor_id using errcode = 'check_violation';
  end if;
  if public.kj_actor_deleted(new.actor_id) then
    raise exception '% deleted their account: no identity is linked to it again', new.actor_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;

alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set', 'ruling.backdated',
   'host.ended', 'kolab.erased', 'push_device.unregistered', 'account.deleted'));   -- AUDIT_ACTIONS in @konjir/types
