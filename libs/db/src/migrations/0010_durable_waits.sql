-- Migration 0010: durable waits (W1.8; REV3, VER2, CAS7, API5, D43).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- The transactional outbox. Review requests, verdicts and questions are rows already (0007); what
-- happened after a verdict was in memory: an approval that commits a version runs its cascade, and
-- an approval of a version that Kolab's rebases overtook folds it onto the newer version, each over
-- several transactions after the one that records the verdict. A process that stopped part way lost
-- that work. Now the transaction that commits a version, or records the approval of an overtaken
-- one, also writes the work still owed as a job here. The process that wrote it runs it at once and
-- deletes it when done; if it stops first, any Kolab process on the database runs it, on boot or
-- when it is next due (Kolab's outbox worker). Every job's work is idempotent, so running one again
-- after a stop part way through does each thing once.
--
--   after_commit     a committed version's cascade (marks, superseded edges, its variants' rebases,
--                    its catch-up) and its reviewers' layer leaks, as marks and questions (VER9)
--   settle_approval  an approved version that was overtaken: folded onto Kolab's rebase, or
--                    rejected as stale if someone else committed (CAS7, D38)
--
-- Durable asynchronous rebasing (D43, Plan P6) adds its kinds here: a parent's commit enqueues its
-- variants' rebases, unclaimed, and the worker runs them level by level.
--
-- A job is claimed by one process at a time: `claimed_by` names the Kolab process (its origin)
-- and `claimed_until` its lease, renewed while it runs. A claim is taken with
-- `for update skip locked`, so two processes never take one job; a lease that lapses (its process
-- stopped) frees the job for any other. A job that fails waits until `run_after`, backing off, with
-- the failure in `last_error`.

create table outbox (
  id            text primary key,                    -- a ULID: jobs run oldest first
  kolab_id      text not null references kolab(id),  -- the version's, set on insert (kj_outbox_kolab)
  kind          text not null
                  constraint outbox_kind_check check (kind in
                    ('after_commit','settle_approval')),     -- OUTBOX_KINDS in @konjir/types
  version_id    text not null,
  payload       jsonb,
  attempts      int not null default 0,
  run_after     timestamptz not null default now(),
  claimed_by    text,
  claimed_until timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  foreign key (version_id, kolab_id) references version(id, kolab_id)
);
-- One job of a kind per version: a second approval of an overtaken version adds nothing.
create unique index one_job_per_version on outbox(kind, version_id);
create index outbox_due on outbox(run_after, id);

-- A job's kolab is its version's, set on insert whatever the writer gave, and never changes
-- (as 0006 does for every other row of kolab data).
create function kj_outbox_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  new.kolab_id := (select v.kolab_id from version v where v.id = new.version_id);
  return new;
end
$$;
revoke execute on function kj_outbox_kolab() from public;
create trigger kolab_of_parent before insert on outbox for each row execute function kj_outbox_kolab();
create trigger kolab_fixed before update of kolab_id on outbox for each row execute function kj_kolab_fixed();

-- Kolab writes jobs as kj_system, in the transaction that commits or records the verdict, and
-- claims and deletes them as its own login. An agent writes none; it may read its own kolab's,
-- as it reads review requests there (TEN12).
grant select on outbox to kj_agent;
grant select, insert, update, delete on outbox to kj_system;
alter table outbox enable row level security;
create policy kolab_read on outbox for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on outbox for all to kj_system using (true) with check (true);
