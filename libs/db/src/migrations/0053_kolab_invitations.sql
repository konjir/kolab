-- Migration 0053: invitations by account, so a kolab's owner invites a person by their GitHub name.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- An invitation names one account at an identity provider: the owner types a username, Kolab asks
-- the provider for that account's permanent id (GitHub's numeric user id) and keeps it, with the
-- name as typed, for display. Only a person whose identity is that account can accept it: a
-- username that changes hands later never takes an invitation with it. It is no bearer secret,
-- unlike kolab_invite's links (0019), which stay as they are. It waits until the person accepts or
-- declines it, on Kolab's sign-in page, or the kolab's owner withdraws it; it never expires.
-- Accepting it grants its level there once, as an invite does.
--
--   provider, subject  the account: the identity provider's name and its own id for the person,
--                      as the identity table keys an identity (0018)
--   login              the username the owner typed, as typed: display only, never matched
--   accepted_*, declined_*, withdrawn_*
--                      how it was settled, and by whom: at most one of the three
--
-- Like kolab_invite, it is access metadata: only Kolab's own login reads or writes it, and
-- kj_agent and kj_system are granted nothing. An archived kolab's invitations can't be made,
-- changed or removed (kolab_writable, 0014).
--
-- One new table. No row that exists changes, so it can neither refuse a database nor change what is
-- in one, and needs no preflight.

create table kolab_invitation (
  id           text primary key check (id ~ '^ivt_[A-Za-z0-9_-]{16}$'),
  kolab_id     text not null references kolab(id),
  provider     text not null check (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  subject      text not null check (subject ~ '^[A-Za-z0-9._@|:-]{1,200}$'),
  login        text not null check (length(login) between 1 and 100),
  level        text not null
               constraint kolab_invitation_level_check check (level in ('read', 'triage', 'write', 'maintain')),   -- INVITE_LEVELS in @konjir/types
  invited_by   text not null references actor(id) check (btrim(invited_by) <> ''),
  created_at   timestamptz not null default now(),
  accepted_by  text references actor(id),
  accepted_at  timestamptz,
  declined_by  text references actor(id),
  declined_at  timestamptz,
  withdrawn_by text references actor(id),
  withdrawn_at timestamptz,
  constraint kolab_invitation_accepted check ((accepted_by is null) = (accepted_at is null)),
  constraint kolab_invitation_declined check ((declined_by is null) = (declined_at is null)),
  constraint kolab_invitation_withdrawn check ((withdrawn_by is null) = (withdrawn_at is null)),
  constraint kolab_invitation_once check (
    (accepted_at is not null)::int + (declined_at is not null)::int + (withdrawn_at is not null)::int <= 1)
);
-- One open invitation per account and kolab: inviting the same account again finds it.
create unique index kolab_invitation_open on kolab_invitation(kolab_id, provider, subject)
  where accepted_at is null and declined_at is null and withdrawn_at is null;
-- The invitations waiting for one account, which its sign-in page lists.
create index kolab_invitation_for on kolab_invitation(provider, subject)
  where accepted_at is null and declined_at is null and withdrawn_at is null;
-- A kolab's invitations, newest first, as its owner lists them.
create index kolab_invitation_kolab_created on kolab_invitation(kolab_id, created_at, id);
-- The rate at which one person invites, counted in the database so every Kolab process counts the same.
create index kolab_invitation_made_by on kolab_invitation(invited_by, created_at);

revoke all on kolab_invitation from public;
revoke all on kolab_invitation from kj_agent, kj_system;

create trigger kolab_writable_insert after insert on kolab_invitation referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on kolab_invitation referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on kolab_invitation referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();
