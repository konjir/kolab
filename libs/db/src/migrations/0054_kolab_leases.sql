-- Migration 0054: leases, so a kolab's members keep off each other's shared resources.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A lease is a named thing in a kolab (a test database, a port, a file) that one member, a person
-- or an agent, holds at a time, for a while. The name is the members' own: Kolab gives it no meaning
-- and compares it exactly as given.
--
--   kolab_lease  one row per name in a kolab, held, or once held and not yet cleared away.
--                holder is who claimed it (the actor's id); expires_at is when it is free again.
--                A release by its holder, or a break by a person, ends it now: ended_at and
--                ended_by say when and by whom. A lease is live while it has not ended or expired
--                and its holder is still a member; any other row is free, as if absent, and Kolab
--                deletes it lazily, as the next claim in the kolab comes.
--
-- The primary key on kolab and name is what lets one claimant only win a free name. Kolab reads and
-- writes it as kj_system, after the engine's checks, as it does messages and channels: no session's
-- role is granted it. An archived kolab's leases can't be claimed, ended or removed (kolab_writable, 0014).
--
-- One new table. No row that exists changes, so it can neither refuse a database nor change what is
-- in one, and needs no preflight.

create table kolab_lease (
  kolab_id   text not null references kolab(id),
  name       text not null constraint kolab_lease_name_check check (name ~ '^[A-Za-z0-9._/@:-]{1,200}$'),   -- LEASE_NAME in @konjir/types
  holder     text not null references actor(id),
  note       text constraint kolab_lease_note_check check (note is null or length(note) between 1 and 200),
  claimed_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  ended_at   timestamptz,
  ended_by   text references actor(id),
  primary key (kolab_id, name),
  constraint kolab_lease_ended check ((ended_at is null) = (ended_by is null))
);
-- A member's leases in a kolab, which MAX_LEASES_PER_MEMBER counts, and those that go when they do.
create index kolab_lease_holder on kolab_lease(kolab_id, holder);
-- A kolab's leases, soonest to expire first, as they are listed.
create index kolab_lease_expires on kolab_lease(kolab_id, expires_at);

create trigger kolab_writable_insert after insert on kolab_lease referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on kolab_lease referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on kolab_lease referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

alter table kolab_lease enable row level security;
create policy system_all on kolab_lease for all to kj_system using (true) with check (true);
revoke all on kolab_lease from public;
grant select, insert, update, delete on kolab_lease to kj_system;
