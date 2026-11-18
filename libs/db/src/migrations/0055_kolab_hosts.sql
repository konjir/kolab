-- Migration 0055: hosts, so a person can start and stop their own agents on another of their machines.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A host is one of a person's own machines that runs `konnect host run` (konnect is built outside
-- the spec). From another machine, the same person asks it, through Kolab, to start or stop one of
-- their agents there. Kolab only keeps the host's registration and relays small requests between two
-- sessions of that one person: it never reads a request's body, and no one else sees either table.
--
--   kolab_host          one row per host a person has in a kolab: (kolab_id, owner, name). owner is
--                       the person's actor id; two people's hosts of one name are two hosts. instance
--                       names the process serving it now, public_key its X25519 key (base64url), so
--                       the asker can seal a request to it; folder, agents and running are what it
--                       said last; seen_at is when it last called, started_at when this instance began.
--                       A host not seen for HOST_FORGOTTEN_DAYS is cleared away, lazily.
--   kolab_host_request  a request to one host, made by its owner: kind start, stop or end, and an
--                       opaque body (at most MAX_HOST_BODY characters). It waits until expires_at
--                       for its host to take it (taken_at), once, and is answered once (done_at, ok,
--                       result, answered_by), which empties its body: a body may hold a sealed
--                       login, and is not kept once answered. One that expires untaken has its
--                       body emptied too, and still reads as expired until its row goes: so an
--                       empty body is allowed on any request, and required once it is answered.
--                       Requests go with their host (on delete cascade), and are cleared away an
--                       hour after they were made; the person's requests of that hour are their
--                       budget (MAX_HOST_ASKS_PER_HOUR).
--
-- Kolab reads and writes both as kj_system, after the engine's checks, as it does leases: no
-- session's role is granted them. An archived kolab's hosts and requests can't change
-- (kolab_writable, 0014). Ending a host is audited (host.ended), as Kolab's own record of it: the
-- audit log is for Konjir's admins, never a session (0024).
--
-- Two new tables, a function their checks use, and one more action for the audit log. No row that
-- exists changes, so it can neither refuse a database nor change what is in one, and needs no preflight.

-- Whether every entry of a host's list of agents is a label (HOST_AGENT in @konjir/types). Null is none.
create function kj_host_labels_valid(labels text[]) returns boolean
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(array_ndims(labels) is null or array_ndims(labels) = 1, false)
     and coalesce((select bool_and(coalesce(l ~ '^[a-z0-9][a-z0-9-]{0,23}$', false)) from unnest(labels) l), true)
$$;

create table kolab_host (
  kolab_id    text not null references kolab(id),
  owner       text not null references actor(id),
  name        text not null constraint kolab_host_name_check check (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),   -- HOST_NAME
  instance    text not null constraint kolab_host_instance_check check (instance ~ '^[a-f0-9]{16,64}$'),   -- HOST_INSTANCE
  public_key  text not null constraint kolab_host_public_key_check check (public_key ~ '^[A-Za-z0-9_-]{43}$'),   -- HOST_PUBLIC_KEY
  folder      text constraint kolab_host_folder_check
                check (folder is null or (length(folder) between 1 and 400 and folder !~ '[\u0001-\u001f\u007f-\u009f  ]')),   -- MAX_HOST_FOLDER
  agents      text[] not null default '{}' constraint kolab_host_agents_check check (cardinality(agents) <= 100 and kj_host_labels_valid(agents)),
  running     text[] not null default '{}' constraint kolab_host_running_check check (cardinality(running) <= 100 and kj_host_labels_valid(running)),
  started_at  timestamptz not null,
  seen_at     timestamptz not null,
  primary key (kolab_id, owner, name)
);
-- A kolab's hosts by when they were last seen, which forgetting reads.
create index kolab_host_seen on kolab_host(kolab_id, seen_at);

create table kolab_host_request (
  id          text primary key constraint kolab_host_request_id_check check (id ~ '^[a-f0-9]{32,64}$'),
  kolab_id    text not null,
  owner       text not null references actor(id),
  host        text not null,
  kind        text not null constraint kolab_host_request_kind_check check (kind in ('start', 'stop', 'end')),   -- HOST_REQUEST_KINDS
  body        text not null constraint kolab_host_request_body_check check (length(body) <= 98304),   -- MAX_HOST_BODY
  created_at  timestamptz not null,
  expires_at  timestamptz not null,
  taken_at    timestamptz,
  done_at     timestamptz,
  ok          boolean,
  result      text constraint kolab_host_request_result_check check (result is null or length(result) <= 16384),   -- MAX_HOST_RESULT
  answered_by text references actor(id),
  foreign key (kolab_id, owner, host) references kolab_host(kolab_id, owner, name) on delete cascade,
  -- Answered once, after it was taken, and its body emptied then: done, ok and who answered go together.
  constraint kolab_host_request_done check (
    (done_at is null) = (ok is null) and (done_at is null) = (answered_by is null)
    and (done_at is null or (taken_at is not null and body = '')))
);
-- A host's requests, oldest first, as serving takes them and as they are counted.
create index kolab_host_request_host on kolab_host_request(kolab_id, owner, host, created_at);
-- A kolab's requests by when they were made, which clearing away and the hourly budget read.
create index kolab_host_request_created on kolab_host_request(kolab_id, created_at);
-- Requests that wait with a body, by when they expire: once expired untaken, the body is emptied.
create index kolab_host_request_unblanked on kolab_host_request(kolab_id, expires_at) where taken_at is null and done_at is null and body <> '';

create trigger kolab_writable_insert after insert on kolab_host referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on kolab_host referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on kolab_host referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_insert after insert on kolab_host_request referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on kolab_host_request referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on kolab_host_request referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

alter table kolab_host enable row level security;
create policy system_all on kolab_host for all to kj_system using (true) with check (true);
revoke all on kolab_host from public;
grant select, insert, update, delete on kolab_host to kj_system;
alter table kolab_host_request enable row level security;
create policy system_all on kolab_host_request for all to kj_system using (true) with check (true);
revoke all on kolab_host_request from public;
grant select, insert, update, delete on kolab_host_request to kj_system;

alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set', 'ruling.backdated',
   'host.ended'));   -- AUDIT_ACTIONS in @konjir/types
