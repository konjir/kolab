-- Migration 0032: repositories, and evidence tied to them (W5.2a; KON7, PLN16, D98 rulings 1 and 2, D102).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Implementation is centered on a git repository (KON7). Kolab never reads or writes git (D36), so a
-- repository is a claim made trustworthy by who makes it and how it is pinned (D98 ruling 1):
--   - only a person with Maintain or Admin registers one, never an agent (the engine checks; audited);
--   - it is pinned by its root commit, the checkout's parentless commit, which `konjir work deliver`
--     compares with the local checkout before it sends anything, and which never changes once written;
--   - it counts as confirmed only after the first approval of a work package whose evidence names it,
--     by someone other than its registrar and the package's assignee (D102).
-- A repository may be its binding's implementation, one per binding (D38). The same URL may be
-- registered in several kolabs: nobody squats a URL for anyone else.
--
-- Commit and pull-request evidence names its repository from now on. Evidence recorded before this
-- migration names none: it is kept as it was, marked `before_repositories`, read as unconfirmed, and
-- never counts toward a repository's confirmation.

-- ---- repositories (KON7, D98) ----

create table repository (
  id            text primary key,                          -- a ULID
  kolab_id      text not null references kolab(id),        -- set by Kolab, fixed once written
  -- https://host[:port]/path, as Kolab canonicalizes it: no user or password, query or fragment, no
  -- trailing slash and no .git; the host in lower case; at most 200 characters, so a work package's
  -- repo field (0029, at most 200) can name it.
  url           text not null
                  constraint repository_url check (url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^/?#@\s]+)+$'
                                                   and url !~ '\.git$' and length(url) <= 200),
  root_sha      text not null
                  constraint repository_root_sha check (root_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  binding_node_id text,                                    -- set: the binding this repository implements (D38)
  registered_by text not null constraint repository_registered_by check (btrim(registered_by) <> ''),
  registered_at timestamptz not null default clock_timestamp(),
  -- Who confirmed it, when, and the work package whose approval did (D98 ruling 1).
  confirmed_by  text,
  confirmed_at  timestamptz,
  confirmed_plan_node_id text,
  confirmed_element_id   text,
  archived_by   text,
  archived_at   timestamptz,
  constraint repository_kolab_key unique (id, kolab_id),
  constraint repository_binding_kolab_fkey foreign key (binding_node_id, kolab_id) references node(id, kolab_id),
  constraint repository_confirmed_work_fkey foreign key (confirmed_plan_node_id, confirmed_element_id, kolab_id)
    references work_package(plan_node_id, element_id, kolab_id),
  constraint repository_confirmed check (
    (confirmed_by is null) = (confirmed_at is null) and (confirmed_at is null) = (confirmed_plan_node_id is null)
    and (confirmed_plan_node_id is null) = (confirmed_element_id is null)
    and (confirmed_by is null or (btrim(confirmed_by) <> '' and confirmed_by <> registered_by))),
  constraint repository_archived check ((archived_by is null) = (archived_at is null) and (archived_by is null or btrim(archived_by) <> ''))
);
-- One live registration of a URL per kolab, whatever its case; and one implementation per binding.
create unique index repository_url_per_kolab on repository(kolab_id, lower(url)) where archived_at is null;
create unique index one_implementation_per_binding on repository(binding_node_id) where binding_node_id is not null and archived_at is null;

create trigger kolab_fixed before update of kolab_id on repository for each row execute function kj_kolab_fixed();

-- A repository implements a binding, never another kind of node (D38, KON7).
create function kj_repository_binding() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.binding_node_id is not null and not exists (select 1 from node n where n.id = new.binding_node_id and n.kind = 'binding') then
    raise exception 'repository: % is not a binding, and a repository implements a binding (KON7, D38)', new.binding_node_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_repository_binding() from public;
create trigger repository_binding before insert on repository for each row execute function kj_repository_binding();

-- What identifies a repository never changes, for any role, Kolab's login included: its kolab, URL,
-- root commit, binding and registration. It is confirmed once and archived once; a repository is
-- never deleted, so the evidence that names it always can.
create function kj_repository_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and (new.id, new.kolab_id, new.url, new.root_sha, new.binding_node_id, new.registered_by, new.registered_at)
         is not distinct from (old.id, old.kolab_id, old.url, old.root_sha, old.binding_node_id, old.registered_by, old.registered_at)
     and (old.confirmed_at is null or (new.confirmed_by, new.confirmed_at, new.confirmed_plan_node_id, new.confirmed_element_id)
          is not distinct from (old.confirmed_by, old.confirmed_at, old.confirmed_plan_node_id, old.confirmed_element_id))
     and (old.archived_at is null or (new.archived_by, new.archived_at) is not distinct from (old.archived_by, old.archived_at)) then
    return new;
  end if;
  raise exception 'repository: a repository''s URL, root commit, binding and registration never change, it is confirmed and archived once, and it is never removed (D98)'
    using errcode = 'check_violation';
end
$$;
revoke execute on function kj_repository_fixed() from public;
create trigger repository_fixed before update or delete on repository for each row execute function kj_repository_fixed();
create trigger repository_kept before truncate on repository for each statement execute function kj_repository_fixed();

create trigger kolab_writable_insert after insert on repository referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on repository referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on repository referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

-- Row-level security, as work state's (0030, 0031): a session reads its own kolab's repositories,
-- whatever its access there, and no other kolab's (D49, LNK10). Only Kolab's trusted role writes them.
alter table repository enable row level security;
create policy kolab_read on repository for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on repository for all to kj_system using (true) with check (true);
grant select on repository to kj_agent;
grant select, insert, update on repository to kj_system;

-- ---- evidence names its repository (D98 ruling 2) ----

alter table evidence add column repository_id text;
-- Every row recorded before this migration is `before_repositories` (the column's default as it is
-- added, which fills the rows already there without touching them); every row recorded after it isn't.
alter table evidence add column before_repositories boolean not null default true;
alter table evidence alter column before_repositories set default false;
alter table evidence add constraint evidence_repository_kolab_fkey foreign key (repository_id, kolab_id) references repository(id, kolab_id);
-- A commit or a pull request names its repository, unless it was recorded before repositories
-- existed; a test run names none.
alter table evidence add constraint evidence_repository check (
  case when kind = 'test_run' then repository_id is null else (repository_id is not null) <> before_repositories end);
create index evidence_repository on evidence(repository_id) where repository_id is not null;

-- Nothing recorded from now on is from before repositories, whatever an insert says.
create function kj_evidence_pinned() returns trigger
language plpgsql as $$
begin
  new.before_repositories := false;
  return new;
end
$$;
revoke execute on function kj_evidence_pinned() from public;
create trigger evidence_pinned before insert on evidence for each row execute function kj_evidence_pinned();

-- Evidence stays immutable (0031), its repository included: a redaction by Kolab's trusted role
-- clears its text, and changes nothing else.
create or replace function kj_evidence_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.title is null and new.files is null
     and (new.id, new.kolab_id, new.plan_node_id, new.element_id, new.event_id, new.kind, new.ref, new.url, new.recorded_by, new.at,
          new.repository_id, new.before_repositories)
         is not distinct from
         (old.id, old.kolab_id, old.plan_node_id, old.element_id, old.event_id, old.kind, old.ref, old.url, old.recorded_by, old.at,
          old.repository_id, old.before_repositories) then
    return new;
  end if;
  raise exception 'evidence: evidence is never edited or removed (PLN5); only Kolab redacts its text' using errcode = 'check_violation';
end
$$;

-- ---- the audit log's new actions ----
--   repository.registered   a person registered a repository (konjir_register_repository, D98): subject is
--                           the repository's id; detail holds its URL, root commit and binding
--   repository.archived     a person archived one (konjir_archive_repository): subject is its id
alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set', 'repository.registered', 'repository.archived'));   -- AUDIT_ACTIONS in @konjir/types
