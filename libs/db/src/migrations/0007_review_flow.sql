-- Migration 0007: the review flow (W1.6; REV2, REV4, DAT3, VER2, VER6, VER11, VER12, D19, D25, D33).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A version moves from drafted, to in review, to committed. Submitting a version that passes
-- Kolab's structural checks moves it to in_review and opens a review request for each actor
-- other than its author whose access in the version's kolab includes Write on its layer (0006's
-- kj_access), connected or not. One approval commits it. A request for
-- changes returns it to drafted. When there is no such reviewer, the structural checks alone
-- commit it, and its review note says so. Kolab's own rebases commit after structural checks only.
--
-- No version is in review yet, so the new state needs no data change (D40: the whole list is
-- written out here, and VERSION_STATES in @konjir/types must match it).

alter table version drop constraint version_state_check;
alter table version add constraint version_state_check check (state in
  ('drafted','in_review','committed','rejected'));            -- VERSION_STATES in @konjir/types

-- A resolution of a dirty or orphaned override, waiting for its version to commit: which mark it
-- settles, how, and the fingerprints its precedent records. Kolab writes it, as kj_system, and
-- reads it when the version commits, whether at once or after review.
alter table version add column resolves jsonb;

-- What Kolab's checks at submission found that doesn't stop a commit (layer leaks, VER9), kept
-- until the version commits after review, when they become marks and questions.
alter table version add column findings jsonb;

-- A fold: the version of a person's that Kolab rebased this one from, keeping its author, its
-- edit and its approval (CAS7, D38). The original is then settled as folded into this one.
alter table version add column folded_from text,
  add constraint version_folded_from_kolab_fkey foreign key (folded_from, kolab_id) references version(id, kolab_id);

-- One review request per reviewer of a version in review: it waits in the reviewer's inbox,
-- whether or not the reviewer is connected (VER16), until they approve or request changes, or
-- the version leaves review some other way (another approval, a request for changes, stale, or
-- abandoned) and the request is withdrawn. Its subject is a version; work packages come later
-- (VER17). A version resubmitted after a request for changes gets new requests, so a reviewer
-- holds at most one open request per version, and older ones stay as its review history.
create table review_request (
  id          text primary key,
  kolab_id    text not null references kolab(id),           -- the version's, set on insert (kj_review_request_kolab)
  version_id  text not null,
  reviewer_id text not null references actor(id),
  state       text not null default 'open'
                constraint review_request_state_check check (state in
                  ('open','approved','changes_requested','withdrawn')),  -- REVIEW_REQUEST_STATES in @konjir/types
  note        text,
  findings    jsonb,                                  -- contradiction and layer_leak findings (VER8)
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  foreign key (version_id, kolab_id) references version(id, kolab_id)
);
create unique index one_open_request_per_reviewer on review_request(version_id, reviewer_id) where state = 'open';
create index review_request_reviewer on review_request(reviewer_id) where state = 'open';

-- A request's kolab is its version's, set on insert whatever the writer gave, and never changes
-- (as 0006 does for every other row of kolab data).
create function kj_review_request_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  new.kolab_id := (select v.kolab_id from version v where v.id = new.version_id);
  return new;
end
$$;
revoke execute on function kj_review_request_kolab() from public;
create trigger kolab_of_parent before insert on review_request for each row execute function kj_review_request_kolab();
create trigger kolab_fixed before update of kolab_id on review_request for each row execute function kj_kolab_fixed();

-- Verdicts go through Kolab's verbs, which write as kj_system (ENF3): an agent never writes a
-- request or a verdict directly. An agent reads the requests of its session's kolab, as it reads
-- versions and questions there (TEN12): all of them, its own and others', with their notes and
-- findings.
grant select on review_request to kj_agent, kj_system;
grant insert, update on review_request to kj_system;
alter table review_request enable row level security;
create policy kolab_read on review_request for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on review_request for all to kj_system using (true) with check (true);
