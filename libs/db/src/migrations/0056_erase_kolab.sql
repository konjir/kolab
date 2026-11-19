-- Migration 0056: a kolab's owner may erase it, when it holds only messages (konnect's `team delete`).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Archiving (D52) keeps everything. Erasing removes a kolab and everything in it, for good, and frees
-- its name. Kolab erases only a kolab with no documents: no node, so no version, ruling, work or
-- job, and nothing in another kolab links to it. What such a kolab holds is its messages and
-- channels, its members' grants, invitations, leases and hosts, and its sessions. Konnect's teams
-- are such kolabs (konnect is built outside the spec).
--
-- Messages, channels and their mentions are never edited or removed (0050, 0052), by any role.
-- Erasing is the one exception: in the transaction that erases kolab K, Kolab's own login (never a
-- session's role) sets kj.erasing to K, and those rows of K alone may then be deleted. Nothing else
-- is exempted: a kolab with any row the erase doesn't remove is refused by its foreign keys, and
-- the whole erase rolls back.
--
-- The audit log keeps its rows about an erased kolab, which name it after it is gone: audit_event's
-- kolab_id no longer references kolab. Erasing is itself audited (kolab.erased).

create function kj_erasing(p_kolab text) returns boolean
language sql stable as $$
  select p_kolab is not null and coalesce(current_setting('kj.erasing', true), '') = p_kolab and current_setting('role') = 'none'
$$;

create or replace function kj_channel_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and public.kj_erasing(old.kolab_id) then return old; end if;
  raise exception '%: a channel, its messages and their mentions are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;

create or replace function kj_message_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and public.kj_erasing(old.kolab_id) then return old; end if;
  raise exception '%: a message and its receipt are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;

alter table audit_event drop constraint audit_event_kolab_id_fkey;

alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set', 'ruling.backdated',
   'host.ended', 'kolab.erased'));   -- AUDIT_ACTIONS in @konjir/types
