-- Migration 0034: jobs (W5.4a; D103, D104, JOB1–JOB3).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Agents are jobs, not colleagues (D103): a person's machine runs `konjir work`, which takes items
-- from Kolab and runs one headless agent per item, and Kolab is the queue and the ledger. Kolab still
-- runs no model (REV5, DEL4). A job is one row here: the person who started it, a label for their
-- machine, the pool agent doing it (`<person>-engineer-<n>`, its own actor, TEN11, TEN14), the
-- person's session that took it (the runner: only it renews or ends the job), the agent's session
-- opened for it (its only one, ENF4), its item (a work package to build, or a review request to
-- answer: a work package In review or a technical version in review), its lease, and how it ended.
--
-- Each item and each agent has at most one live job. The lease is the kolab's work lease (PLN15),
-- renewed by the job session's calls and the runner's heartbeat, never past four hours from the
-- start; a job whose lease lapses is ended by Kolab (`lapsed`), its package back To do, its session
-- ended. Agents read their own kolab's jobs and never write them: every write is Kolab's, as
-- kj_system, after the engine's checks (ENF2).
--
-- It makes one new, empty table and changes no existing row, so it can neither refuse a database nor
-- change what is in one: it needs no preflight.

create table job (
  id                text primary key,                        -- a ULID: jobs sort by when they started
  kolab_id          text not null references kolab(id),      -- set by Kolab, fixed once written
  person_id         text not null references actor(id),      -- who started it: the runner's person
  runner_session_id text not null references session(id),    -- the person's session that took it
  machine           text not null
                      constraint job_machine_check check (char_length(machine) between 1 and 64 and btrim(machine) = machine and machine !~ '[[:cntrl:]]'),
  agent_id          text not null references actor(id),      -- the pool agent doing it
  session_id        text not null references session(id),    -- the agent's session, opened for the job
  kind              text not null
                      constraint job_kind_check check (kind in ('build', 'review')),   -- JOB_KINDS in @konjir/types
  -- Its item: a work package (built, or reviewed), or a version in review.
  binding_node_id   text,
  element_id        text,
  version_id        text,
  review_request_id text references review_request(id),     -- the request Kolab gave a review job's agent, withdrawn if it gives no verdict
  lease_until       timestamptz not null,
  started_at        timestamptz not null default clock_timestamp(),
  ended_at          timestamptz,
  outcome           text
                      constraint job_outcome_check check (outcome in ('submitted', 'reviewed', 'released', 'lapsed', 'stopped')),   -- JOB_OUTCOMES
  said              text
                      constraint job_said_check check (said in ('done', 'stopped', 'failed')),   -- JOB_ENDS: what its runner said, ending it
  note              text,                                    -- the runner's note, or Kolab's
  ended_by          text,                                    -- the runner's person, or `kolab` for a lapse
  constraint job_kolab_key unique (id, kolab_id),
  constraint job_work_kolab_fkey foreign key (binding_node_id, element_id, kolab_id) references work_package(binding_node_id, element_id, kolab_id),
  constraint job_version_kolab_fkey foreign key (version_id, kolab_id) references version(id, kolab_id),
  constraint job_item check ((version_id is null) <> (binding_node_id is null) and (binding_node_id is null) = (element_id is null)
                             and (kind = 'review' or binding_node_id is not null) and (kind = 'review' or review_request_id is null)),
  constraint job_agent_not_person check (agent_id <> person_id),
  constraint job_lease check (lease_until <= started_at + interval '4 hours'),
  constraint job_ended check ((ended_at is null) = (outcome is null) and (ended_at is null) = (ended_by is null)
                              and (ended_at is not null or said is null) and (ended_by is null or btrim(ended_by) <> ''))
);
-- JOB1: each agent and each item has at most one live job.
create unique index one_live_job_per_agent on job(agent_id) where ended_at is null;
create unique index one_live_job_per_package on job(binding_node_id, element_id) where ended_at is null and binding_node_id is not null;
create unique index one_live_job_per_version on job(version_id) where ended_at is null and version_id is not null;
create index job_live_person on job(person_id) where ended_at is null;
create index job_live_kolab on job(kolab_id) where ended_at is null;
create index job_live_session on job(session_id) where ended_at is null;
create index job_lapse on job(lease_until) where ended_at is null;
create index job_of_kolab on job(kolab_id, started_at desc, id desc);

create trigger kolab_fixed before update of kolab_id on job for each row execute function kj_kolab_fixed();

-- A job is a ledger entry: never deleted, by any role, and what it was never changes. While live,
-- only its lease moves; it ends once, with its outcome, and stays as it ended.
create function kj_job_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.ended_at is null
     and (new.id, new.kolab_id, new.person_id, new.runner_session_id, new.machine, new.agent_id, new.session_id, new.kind,
          new.binding_node_id, new.element_id, new.version_id, new.review_request_id, new.started_at)
         is not distinct from
         (old.id, old.kolab_id, old.person_id, old.runner_session_id, old.machine, old.agent_id, old.session_id, old.kind,
          old.binding_node_id, old.element_id, old.version_id, old.review_request_id, old.started_at) then
    return new;
  end if;
  raise exception 'job: a job is never deleted, and changes only its lease until it ends, once (JOB1)' using errcode = 'check_violation';
end
$$;
revoke execute on function kj_job_fixed() from public;
create trigger job_fixed before update or delete on job for each row execute function kj_job_fixed();
create trigger job_kept before truncate on job for each statement execute function kj_job_fixed();

-- An archived kolab's jobs change no more than the rest of its data (0014): their leases wait, as
-- work leases do, and lapse once it is unarchived.
create trigger kolab_writable_insert after insert on job referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on job referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on job referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

-- Row-level security, as work state's (0030): a session reads its own kolab's jobs, whatever its
-- access there, and no other kolab's (D49). Only Kolab's trusted role writes them (ENF2).
alter table job enable row level security;
create policy kolab_read on job for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on job for all to kj_system using (true) with check (true);
grant select on job to kj_agent;
grant select, insert, update on job to kj_system;
