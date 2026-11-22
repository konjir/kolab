-- Migration 0058: push notifications to konnect's phone app, through Expo's push service.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- konnect's app signs a person in once, and moves that one sign-in between their teams (kolabs);
-- it registers its Expo push token from whichever team it is in. A device is the person's, not a
-- team's: it is pushed messages from every team they are a member of. A token is unique, so the
-- same phone registered by another person moves to them.
--
--   push_device        one row per token: the person whose app registered it, its platform, the
--                      sign-in it was registered from (grant_id: once that is revoked or lapses,
--                      nothing more is pushed to it, even if the app never unregistered; a sign-in
--                      moved to another team keeps its grant, and its device), and when it was
--                      registered and last seen. Only a person's: an agent has no device. It
--                      names no kolab, so archiving one doesn't touch it.
--   notification_pref  a person's choice in a kolab of what to be told: all (every message in a
--                      channel they follow or that mentions them, and every direct message),
--                      mentions_and_dms (the default, without a row) or none; the channels they
--                      muted, by id, which push nothing; and hide_preview, their choice that a push
--                      carries none of a message's words, beside the server's own (KONJIR_PUSH_PREVIEW).
--
-- A push is a job in the outbox (0010), kind `push`, with no version: it names its kolab itself,
-- and carries what it tells each person in its payload. Every other kind still names its version.
--
-- Kolab reads and writes them as kj_system, after the engine's checks, as it does messages: no
-- session's role is granted either. An archived kolab's prefs don't change (kolab_writable, 0014),
-- and its push jobs wait, unclaimed, like every job of an archived kolab. Erasing a kolab removes
-- its prefs and push jobs; its members' devices stay theirs.
--
-- Two new tables, a new kind of outbox job whose version may be null, and a new action in the
-- audit log. No row that exists changes, so it needs no preflight.

create table push_device (
  token        text primary key constraint push_device_token_check check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$'),
  actor_id     text not null references actor(id),
  platform     text not null
                 constraint push_device_platform_check check (platform in ('ios', 'android')),   -- PUSH_PLATFORMS in @konjir/types
  grant_id     text references oauth_grant(id),
  created_at   timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp()
);
-- A person's devices, as a push finds them.
create index push_device_actor on push_device(actor_id);

-- Only a person has a device: an agent never registers one.
create function kj_push_device_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from public.actor a where a.id = new.actor_id and a.kind = 'person') then
    raise exception 'push_device: % is no person: only a person registers a device', new.actor_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_push_device_person() from public;
create trigger push_device_person before insert or update of actor_id on push_device for each row execute function kj_push_device_person();

create table notification_pref (
  kolab_id   text not null references kolab(id),
  actor_id   text not null references actor(id),
  level      text not null
               constraint notification_pref_level_check check (level in ('all', 'mentions_and_dms', 'none')),   -- NOTIFICATION_LEVELS in @konjir/types
  muted      text[] not null default '{}' constraint notification_pref_muted_check check (cardinality(muted) <= 200),   -- channel ids; MAX_CHANNELS
  hide_preview boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (kolab_id, actor_id)
);

-- An archived kolab's prefs don't change (0014). A device names no kolab, so it has no such trigger.
create trigger kolab_writable_insert after insert on notification_pref referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on notification_pref referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on notification_pref referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

alter table push_device enable row level security;
alter table notification_pref enable row level security;
create policy system_all on push_device for all to kj_system using (true) with check (true);
create policy system_all on notification_pref for all to kj_system using (true) with check (true);
grant select, insert, update, delete on push_device to kj_system;
grant select, insert, update on notification_pref to kj_system;

-- A person unregistering a device leaves no row of its own, so the audit log says so (W2.20).
alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set', 'ruling.backdated',
   'host.ended', 'kolab.erased', 'push_device.unregistered'));   -- AUDIT_ACTIONS in @konjir/types

-- ---- push jobs in the outbox ----
alter table outbox drop constraint outbox_kind_check;
alter table outbox add constraint outbox_kind_check check (kind in
  ('after_commit','settle','rebase','push'));                -- OUTBOX_KINDS in @konjir/types
alter table outbox alter column version_id drop not null;
alter table outbox add constraint outbox_version check ((version_id is null) = (kind = 'push'));

-- A job's kolab is its version's, as 0010 set it; a push job, which has none, keeps the kolab it names.
create or replace function kj_outbox_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.version_id is not null then
    new.kolab_id := (select v.kolab_id from public.version v where v.id = new.version_id);
  end if;
  return new;
end
$$;
