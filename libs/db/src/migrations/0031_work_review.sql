-- Migration 0031: submitting, reviewing and delivering work (W5.1c; PLN10, PLN16, PLN18, VER17, D98).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A review request's subject is a version or a work package (VER17): one inbox for a reviewer. A
-- work package's evidence (commits, pull requests and test runs, PLN16) is its own table, each item
-- an attributed claim recorded with the event that brought it in; Kolab never reads git (D36), so
-- the reviewer checks it outside Kolab. Repositories, and evidence pinned to one, are W5.2a's.
--
-- PLN18 as D98 amends it limits pulling only: a request for changes returns a package to its
-- assignee even if they have pulled another meanwhile. So the one-per-actor index counts only the
-- package an actor pulled (or was given), not one returned to them (`returned`), and each package
-- In progress knows when it was last pulled, given or returned (`touched_at`): a call that names
-- no package renews only that one, so a package its assignee neglects lapses (PLN15).

-- ---- the package returned to its assignee, and per-package renewal (PLN15, PLN18, D98) ----

alter table work_package add column returned boolean not null default false;   -- In progress again after a request for changes
alter table work_package add column touched_at timestamptz;                     -- when last pulled, given or returned
update work_package set touched_at = updated_at where state = 'in_progress';
alter table work_package add constraint work_package_returned check (not returned or state = 'in_progress');
alter table work_package add constraint work_package_touched check (state <> 'in_progress' or touched_at is not null);
-- The limit is on pulling (PLN18, D98): two pulls, or a pull and a reassignment, racing for one
-- actor still get one package; a package returned by a request for changes isn't counted.
drop index one_in_progress_per_actor;
create unique index one_pulled_per_actor on work_package(assignee_id) where state = 'in_progress' and not returned;
create index work_package_held on work_package(assignee_id, kolab_id) where state = 'in_progress';

-- ---- a review request's subject: a version or a work package (VER17) ----

alter table review_request alter column version_id drop not null;
alter table review_request add column plan_node_id text, add column element_id text;
alter table review_request add constraint review_request_subject
  check ((version_id is null) <> (plan_node_id is null) and (plan_node_id is null) = (element_id is null));
alter table review_request add constraint review_request_work_kolab_fkey
  foreign key (plan_node_id, element_id, kolab_id) references work_package(plan_node_id, element_id, kolab_id);
create unique index one_open_work_request_per_reviewer on review_request(plan_node_id, element_id, reviewer_id)
  where state = 'open' and plan_node_id is not null;
create index review_request_work on review_request(plan_node_id, element_id, created_at) where plan_node_id is not null;

-- A request's kolab is its subject's: its version's, or its work package's.
create or replace function kj_review_request_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.version_id is not null then
    new.kolab_id := (select v.kolab_id from version v where v.id = new.version_id);
  else
    new.kolab_id := (select w.kolab_id from work_package w where w.plan_node_id = new.plan_node_id and w.element_id = new.element_id);
  end if;
  return new;
end
$$;
revoke execute on function kj_review_request_kolab() from public;

-- ---- evidence (PLN16, D98) ----

-- Events are keyed with their kolab too, so evidence can name its event within its kolab.
alter table work_event add constraint work_event_kolab_key unique (id, kolab_id);

create table evidence (
  id           text primary key,                          -- a ULID
  kolab_id     text not null references kolab(id),        -- its package's, set on insert (kj_work_kolab)
  plan_node_id text not null,
  element_id   text not null,
  event_id     text not null,                             -- the evidence or submitted event that recorded it
  kind         text not null
                 constraint evidence_kind_check check (kind in ('commit', 'pull_request', 'test_run')),   -- EVIDENCE_KINDS in @konjir/types
  ref          text,                                      -- a commit's sha (lowercase hex), or a pull request's number
  url          text,                                      -- https, with no user or password in it
  title        text,                                      -- a commit's subject, a pull request's title, a test run's summary
  files        text[],                                    -- the paths a commit touched
  recorded_by  text not null constraint evidence_recorded_by_check check (btrim(recorded_by) <> ''),
  at           timestamptz not null default clock_timestamp(),
  redacted_at  timestamptz,
  redacted_by  text,
  constraint evidence_package_kolab_fkey foreign key (plan_node_id, element_id, kolab_id)
    references work_package(plan_node_id, element_id, kolab_id),
  constraint evidence_event_kolab_fkey foreign key (event_id, kolab_id) references work_event(id, kolab_id),
  constraint evidence_commit check (kind <> 'commit' or ref ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  constraint evidence_pull_request check (kind <> 'pull_request' or (url is not null and (ref is null or ref ~ '^[1-9][0-9]{0,9}$'))),
  constraint evidence_test_run check (kind <> 'test_run' or (ref is null and (url is not null or title is not null or redacted_at is not null))),
  constraint evidence_url check (url is null or (url ~ '^https://[^/@\s]+(/\S*)?$' and length(url) <= 2000)),
  constraint evidence_title check (title is null or char_length(title) <= 4000),
  constraint evidence_files check (files is null or (cardinality(files) between 1 and 500 and kind = 'commit'))
);
create index evidence_of_package on evidence(plan_node_id, element_id, at, id);
create index evidence_kolab on evidence(kolab_id);

create trigger kolab_of_parent before insert on evidence for each row execute function kj_work_kolab();
create trigger kolab_fixed before update of kolab_id on evidence for each row execute function kj_kolab_fixed();

-- Evidence is never edited or removed (PLN5), by any role. The one change retention may make is a
-- redaction, by Kolab's trusted role: the free text goes (title and files), and who redacted it
-- and when are recorded; the kind, the reference, the link, the package and the event stay.
create function kj_evidence_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.title is null and new.files is null
     and (new.id, new.kolab_id, new.plan_node_id, new.element_id, new.event_id, new.kind, new.ref, new.url, new.recorded_by, new.at)
         is not distinct from
         (old.id, old.kolab_id, old.plan_node_id, old.element_id, old.event_id, old.kind, old.ref, old.url, old.recorded_by, old.at) then
    return new;
  end if;
  raise exception 'evidence: evidence is never edited or removed (PLN5); only Kolab redacts its text' using errcode = 'check_violation';
end
$$;
revoke execute on function kj_evidence_fixed() from public;
create trigger evidence_fixed before update or delete on evidence for each row execute function kj_evidence_fixed();
create trigger evidence_kept before truncate on evidence for each statement execute function kj_evidence_fixed();

-- An archived kolab's evidence changes no more than the rest of its data (0014).
create trigger kolab_writable_insert after insert on evidence referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on evidence referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on evidence referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

-- Row-level security, as work state's (0030): a session reads its own kolab's evidence, whatever
-- its access there, and no other kolab's, ever (D49, LNK10). Only Kolab's trusted role writes it
-- (ENF2, D98).
alter table evidence enable row level security;
create policy kolab_read on evidence for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on evidence for all to kj_system using (true) with check (true);
grant select on evidence to kj_agent;
grant select, insert, update on evidence to kj_system;
