-- Migration 0010: durable waits (W1.8; REV3, VER2, CAS7, API5, D43).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- The transactional outbox. Review requests, verdicts and questions are rows already (0007); what
-- happened after a verdict was in memory: an approval that commits a version runs its cascade, and
-- a version that Kolab's rebases overtook (an approved one, a ruling applied through the admin
-- token, a submitted draft) is folded onto the newer version, each over several transactions
-- after the one that records the verdict. A process that stopped part way lost that work. Now the
-- transaction that commits a version, or records the verdict on an overtaken one, also writes the
-- work still owed as a job here. The process that wrote it runs it at once and deletes it when
-- done; if it stops first, any Kolab process on the database runs it, on boot or when it is next
-- due (Kolab's outbox worker). Every job's work is idempotent, so running one again after a stop
-- part way through does each thing once.
--
--   after_commit  a committed version's cascade (marks, superseded edges, its variants' rebases,
--                 its catch-up) and its reviewers' layer leaks, as marks and questions (VER9).
--                 A node's after_commit jobs run one at a time, in the order its versions
--                 committed: each carries the one before it forward.
--   settle        a version that was overtaken while it waited: folded onto Kolab's rebase,
--                 carrying its approval or its ruling (D47), or rejected as stale if someone else
--                 committed (CAS7, D38)
--
-- Durable asynchronous rebasing (D43, Plan P6) adds its kinds here: a parent's commit enqueues its
-- variants' rebases, unclaimed, and the worker runs them level by level.
--
-- A job is claimed by one process at a time: `claim` is a token fresh for each claim, which the
-- claimant's renewals, deletion and release must match, so a process whose claim lapsed touches
-- nothing; `claimed_by` names the process (its origin), for the logs, and `claimed_until` its
-- lease, renewed while it runs. A claim is taken with `for update skip locked`, so two processes
-- never take one job; a lease that lapses (its process stopped) frees the job for any other. A job
-- that fails waits until `run_after`, backing off, with the failure in `last_error`; after ten
-- attempts it is `dead`, and waits for an admin to retry it (konjir_admin_outbox).

create table outbox (
  id            text primary key,                    -- a ULID: jobs run oldest first
  kolab_id      text not null references kolab(id),  -- the version's, set on insert (kj_outbox_kolab)
  kind          text not null
                  constraint outbox_kind_check check (kind in
                    ('after_commit','settle')),             -- OUTBOX_KINDS in @konjir/types
  state         text not null default 'pending'
                  constraint outbox_state_check check (state in
                    ('pending','dead')),                    -- OUTBOX_STATES in @konjir/types
  version_id    text not null,
  payload       jsonb,
  attempts      int not null default 0,
  run_after     timestamptz not null default clock_timestamp(),
  claim         text,
  claimed_by    text,
  claimed_until timestamptz,
  last_error    text,
  created_at    timestamptz not null default clock_timestamp(),
  foreign key (version_id, kolab_id) references version(id, kolab_id)
);
-- One job of a kind per version: a second approval of an overtaken version adds nothing.
create unique index one_job_per_version on outbox(kind, version_id);
create index outbox_due on outbox(run_after, id) where state = 'pending';

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
-- claims, releases and deletes them as its own login. The outbox is Kolab's internals (its errors
-- name other nodes), so no agent reads it: kj_agent has no grant, and no policy lets it in.
grant select, insert, update, delete on outbox to kj_system;
alter table outbox enable row level security;
create policy system_all on outbox for all to kj_system using (true) with check (true);
