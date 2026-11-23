-- Migration 0060: a person deletes their own account (konjir_delete_my_account; Lee, 2026-11-23).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Apple requires that anyone who can make an account in an app can delete it there (App Store
-- guideline 5.1.1(v)). Lee's decision of 2026-11-23, "remove me, keep my words": deleting an
-- account leaves every kolab, ends every sign-in and push device, removes the person's own agents,
-- and deletes their identity (the GitHub account it was) and profile. The messages they and their
-- agents sent stay where they are, shown as from "a deleted account". A kolab they alone are in is
-- erased with the account (0056); one where anyone else is a member must be handed over or erased
-- first.
--
-- The person's account and actor rows stay, as a tombstone: messages, receipts and the audit log
-- name them by id, and requireFreeName keeps a name any account or actor holds, so the id is never
-- handed to anyone again (a later sign-up with the same GitHub account is a new person, `<login>_2`
-- and on, signUpNames). What is kept of them is their id and nothing else: their names become
-- their id, and their identity row goes.
--
--   account.deleted_at  when the person deleted their account: set once, with archived_at (0014),
--                       so a deleted person, and their agents, hold nothing anywhere (kj_access) and
--                       open no session (kj_session_openable). Never cleared, and archived_at is
--                       never cleared while it is set, so no unarchive brings a deleted account back.
--                       Only a user's account is deleted; an organization's never is.
--
-- The database holds to it, whatever role writes: a deleted account's row, and every actor row of
-- it (the person and their agents), is never removed, nor renamed back; no identity is linked to a
-- deleted person again; and kj_actor_deleted says whether an actor's account is deleted, for what
-- shows a message's sender (Kolab reads messages as kj_system).
--
-- A new nullable column, a check, triggers and functions, and a new action in the audit log
-- (account.deleted, which records the event, never the person's data). No row that exists changes,
-- so it needs no preflight.

alter table account add column deleted_at timestamptz;
alter table account add constraint account_deleted_check
  check (deleted_at is null or (kind = 'user' and archived_at is not null));

-- Whether `p_actor` is a deleted person, or an agent of one.
create function kj_actor_deleted(p_actor text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.actor a join public.account o on o.id = coalesce(a.owner_id, a.id)
                  where a.id = p_actor and o.deleted_at is not null)
$$;
revoke execute on function kj_actor_deleted(text) from public;
grant execute on function kj_actor_deleted(text) to kj_system, kj_agent;

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
                                     or new.id is distinct from old.id or new.name is distinct from old.name) then
    raise exception 'account %: a deleted account never changes again', old.id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger account_deleted_kept before update or delete on account for each row execute function kj_account_deleted_kept();

-- A deleted person's actor, and their agents', are never removed nor renamed: their messages name them.
create function kj_actor_deleted_kept() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if public.kj_actor_deleted(old.id) and (tg_op = 'DELETE' or new.id is distinct from old.id or new.name is distinct from old.name) then
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
