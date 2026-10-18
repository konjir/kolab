-- Migration 0019: invites, so a kolab's admins bring a teammate in without Konjir's admin (W3.4; P15, D55).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- An invite is a link a kolab's admin makes: whoever signs in with it, as a person, is granted the
-- access it names in that kolab, once. It is a bearer secret, like a session token, so Kolab stores
-- only its sha256, base64url (`key`, P1), and shows the link once, when it is made. It lasts until
-- `expires_at` (7 days), until it is accepted, or until an admin of the kolab revokes it; and it
-- counts only while the person who made it still holds Admin there, so an admin who loses Admin
-- takes their open invites with them. It never grants Admin: the kolab's owners give that.
--
-- Invites are access metadata, like kolab_grant, not kolab data an agent reads: only Kolab's own
-- login reads or writes them, and kj_agent and kj_system are granted nothing. Like every table with
-- a kolab_id, an archived kolab's invites can't be made, changed or removed (kolab_writable, 0014).

create table kolab_invite (
  id          text primary key check (id ~ '^inv_[A-Za-z0-9_-]{16}$'),
  key         text not null unique check (key ~ '^[A-Za-z0-9_-]{43}$'),
  kolab_id    text not null references kolab(id),
  level       text not null
              constraint kolab_invite_level_check check (level in ('read', 'triage', 'write', 'maintain')),   -- INVITE_LEVELS in @konjir/types
  functional  boolean not null,
  technical   boolean not null,
  created_by  text not null references actor(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_by text references actor(id),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  -- The layers an invite covers, as a grant's (kolab_grant_layers): Write names one or both, Maintain both, Read and Triage none.
  constraint kolab_invite_layers check (case
    when level = 'write' then functional or technical
    when level = 'maintain' then functional and technical
    else not functional and not technical end),
  constraint kolab_invite_accepted check ((accepted_by is null) = (accepted_at is null)),
  constraint kolab_invite_once check (accepted_at is null or revoked_at is null)
);
-- The kolab's open invites, which its admins list and which a kolab may hold only so many of.
create index kolab_invite_open on kolab_invite(kolab_id) where accepted_at is null and revoked_at is null;
-- The rate at which one person makes invites, counted in the database so every Kolab process counts the same.
create index kolab_invite_made_by on kolab_invite(created_by, created_at);

revoke all on kolab_invite from public;
revoke all on kolab_invite from kj_agent, kj_system;

create trigger kolab_writable_insert after insert on kolab_invite referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on kolab_invite referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on kolab_invite referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

-- A sign-in through the web interface may carry an invite, by its key, from the browser that opened
-- the link to the consent page, which offers to join that kolab (W3.4). Only the web interface's own
-- client sets it, never a registered MCP client.
alter table oauth_request add column invite_key text check (invite_key ~ '^[A-Za-z0-9_-]{43}$');
