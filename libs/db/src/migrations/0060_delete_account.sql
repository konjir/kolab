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
--   retired_name        the old ids, each as the sha256 of its lowercased name, never the name
--                       itself: no account or actor is made with one again, in any case, nor with
--                       one followed by `-` (`<old>-x` would read as one of their agents, D30), so a
--                       later sign-up with the same GitHub account is a new person, `<login>_2` and
--                       on. Only ever added to. No name starting `deleted-` is made either but by
--                       the re-key.
--
-- The re-key. Each foreign key to actor or account now cascades an update of the id (ON UPDATE
-- CASCADE), but for those that hold a generated kind (below): Kolab updates account.id, which
-- carries their agents' owner and their kolabs' owner, and the person's actor.id, which carries
-- every row that names them; then each agent's actor.id. A column that names an actor with no
-- foreign key (who made or ended something, an audit row's subject) Kolab updates itself
-- (ACTOR_ID_COLUMNS in the engine; a later column that names an actor takes a foreign key, or a
-- place there, and the engine's tests hold every one to it). Rows that are never edited (messages,
-- the audit and archive logs, work events, evidence, case files, jobs, repositories, an admin's
-- row) and rows of archived kolabs may change in that transaction, but only so: kj.rekey, set only
-- by Kolab's own login (never a session's role, as kj.erasing, 0056), maps each old id to its new
-- one, and such a row may change only by one of those ids becoming another (kj_rekey_only). The
-- same setting lets the deletion scrub what archived kolabs keep of the person (invitations to
-- them, their notification prefs).
--
-- The database holds to it, whatever role writes: a deleted account's row, and every actor row of
-- it (the person and their agents), is never removed, renamed, re-keyed, re-owned nor changes kind;
-- no identity is linked to a deleted person again; and kj_actor_deleted says whether an actor's
-- account is deleted, for what shows a message's sender (Kolab reads messages as kj_system).
--
-- A new nullable column, a table, a check, triggers and functions, a new action in the audit log
-- (account.deleted, which records the event, never the person's data), and the foreign keys to
-- actor or account made again with ON UPDATE CASCADE, which checks every row as before. No row that
-- exists changes, so it needs no preflight.

alter table account add column deleted_at timestamptz;
alter table account add constraint account_deleted_check
  check (deleted_at is null or (kind = 'user' and archived_at is not null));

-- Every foreign key to an actor or an account carries a change of its id (the re-key, above), but
-- those that hold a generated kind (Postgres can't cascade into one): a grant's, a membership's and
-- a team's, none of which names a deleted person once their deletion has removed them, and a
-- person's actor's to their account, which the re-key changes itself, so that one may wait for the
-- end of the transaction (deferrable; still checked at once unless deferred).
do $$
declare c record;
begin
  for c in select f.conrelid::regclass::text as tbl, f.conname, pg_get_constraintdef(f.oid) as def from pg_constraint f
            where f.contype = 'f' and f.confrelid in ('public.actor'::regclass, 'public.account'::regclass)
              and not exists (select 1 from pg_attribute a where a.attrelid = f.conrelid and a.attnum = any(f.conkey) and a.attgenerated <> '')
            order by f.conrelid::regclass::text, f.conname loop
    execute format('alter table %s drop constraint %I, add constraint %I %s on update cascade', c.tbl, c.conname, c.conname, c.def);
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

-- The ids a re-key is changing in this transaction, old and new, while Kolab's own login deletes an
-- account (kj.rekey, a JSON object of old id to new); null otherwise, and always for a session's role.
create function kj_rekeying() returns text[]
language sql stable as $$
  select case when current_setting('role') = 'none' and coalesce(current_setting('kj.rekey', true), '') <> '' then
    (select array_agg(x) from jsonb_each_text(current_setting('kj.rekey', true)::jsonb) e(k, v) cross join lateral (values (k), (v)) y(x))
  end
$$;

-- `j` with each string in it (at any depth) that is one of `ids` made the same marker, which no
-- string is: two rows equal under it differ only in which of those ids they name.
create function kj_unkeyed(j jsonb, ids text[]) returns jsonb
language plpgsql immutable as $$
begin
  case jsonb_typeof(j)
    when 'string' then
      if (j #>> '{}') = any(ids) then return '{"kj.rekeyed": true}'::jsonb; end if;
      return j;
    when 'array' then
      return coalesce((select jsonb_agg(public.kj_unkeyed(e, ids) order by o) from jsonb_array_elements(j) with ordinality x(e, o)), '[]'::jsonb);
    when 'object' then
      return coalesce((select jsonb_object_agg(k, public.kj_unkeyed(v, ids)) from jsonb_each(j) y(k, v)), '{}'::jsonb);
    else
      return j;
  end case;
end
$$;

-- Whether a row changing from `o` to `n` is only a re-key: Kolab's own login is re-keying, and
-- nothing changed but which of the ids being re-keyed it names.
create function kj_rekey_only(o jsonb, n jsonb) returns boolean
language sql stable as $$
  select ids is not null and public.kj_unkeyed(o, ids) = public.kj_unkeyed(n, ids) from (select public.kj_rekeying() as ids) r
$$;

-- The rows that are never edited may be re-keyed (kj_rekey_only), and only that; otherwise as before.
create or replace function kj_message_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'DELETE' and public.kj_erasing(old.kolab_id) then return old; end if;
  raise exception '%: a message and its receipt are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;

create or replace function kj_channel_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  if tg_op = 'DELETE' and public.kj_erasing(old.kolab_id) then return old; end if;
  raise exception '%: a channel, its messages and their mentions are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;

create or replace function kj_audit_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  raise exception 'audit_event: the audit log is only ever added to' using errcode = 'check_violation';
end
$$;

create or replace function kj_archive_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
  end if;
  raise exception 'archive_event: the archive log is only ever added to' using errcode = 'check_violation';
end
$$;

create or replace function kj_work_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
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
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
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
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
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
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
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
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
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
  if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return new; end if;
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
    if public.kj_rekey_only(to_jsonb(old), to_jsonb(new)) then return null; end if;
  end if;
  if tg_op = 'DELETE' then r := old; act := 'admin.revoked'; else r := new; act := 'admin.granted'; end if;
  if not exists (select 1 from public.audit_event a where a.tx = pg_current_xact_id() and a.subject = r.actor_id and a.action = act) then
    raise exception 'konjir_admin: making or removing an admin (%) must be recorded in the audit log, with who did it (W2.22)', r.actor_id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

-- An archived kolab's rows change while Kolab's own login deletes an account: re-keyed, or what it
-- keeps of the person scrubbed.
create or replace function kj_kolab_writable() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
  if kj_migrating() or kj_rekeying() is not null then return null; end if;
  select d.kolab_id into k from (select distinct kolab_id from kj_rows) d where kj_kolab_archived(d.kolab_id) limit 1;
  if k is not null then
    raise exception 'kolab % is archived: its data is kept, and nothing in it can change until an admin unarchives it', k
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

-- The names of deleted accounts and their agents, never given again (above).
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

-- How retired_name holds a name: the sha256 of it lowercased, in hex.
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

-- No account or actor takes a retired name, nor one starting `deleted-` but by a re-key.
create function kj_name_free() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if kj_migrating() or (tg_op = 'UPDATE' and new.id is not distinct from old.id) then return new; end if;
  if lower(new.id) like 'deleted-%' then
    if tg_op = 'UPDATE' and kj_rekeying() is not null then return new; end if;
    raise exception '%: a name starting deleted- is a deleted account''s, and no one else''s', new.id using errcode = 'check_violation';
  end if;
  if kj_name_retired(new.id) then
    raise exception '%: that name was a deleted account''s, and is never given to anyone again', new.id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_name_free() from public;
create trigger account_name_free before insert or update of id on account for each row execute function kj_name_free();
create trigger actor_name_free before insert or update of id on actor for each row execute function kj_name_free();

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
