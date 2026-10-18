-- Migration 0015: durable asynchronous rebasing (P6; D43, CAS7, CAS8, REV3).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A parent's commit no longer rebases its variants in the committing call. The transaction that
-- commits a version also writes a `rebase` job for each variant whose live version sits on an
-- older version of the committed node, unclaimed, and tells every process's worker. The commit
-- returns once the parent is committed, with the number of rebases queued, and the worker runs
-- them: one variant per job, each built on the variant's live version when it runs, never on a
-- list taken earlier. A rebase that commits writes its own variants' jobs in turn, so the worker,
-- taking jobs oldest first, rebases level by level, and resumes after a restart.
--
--   rebase  a variant to rebase onto its parent node's latest version. `version_id` is the
--           variant's live version when the job was written: the job's subject, one job per
--           version (a second parent commit before it runs adds nothing). `payload.onto` names
--           the parent version whose commit wrote it. The job rebases whatever is live when it
--           runs, onto whatever the parent's latest is then. A variant has one job waiting at a
--           time; a parent commit while a worker runs it sets `payload.again`, and the job runs
--           once more when it is done. A dead job is revived by the parent's next commit.

alter table outbox drop constraint outbox_kind_check;
alter table outbox add constraint outbox_kind_check check (kind in
  ('after_commit','settle','rebase'));                     -- OUTBOX_KINDS in @konjir/types

-- Finding a node's variants, which every commit now does in its commit step: version by the
-- version it was built on.
create index version_parent on version(parent_version_id);
