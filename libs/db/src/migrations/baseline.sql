-- Baseline: brings a database made before migrations began (W1.2) to migration 0001.
--
-- Such a database has Kolab's tables but no kj_migration table: the PGlite data directories
-- of releases 0.5 and later, and the test server's RDS database. Each statement is
-- idempotent, so it changes nothing that 0001 already has. The runner applies it once, inside
-- the migration transaction, and then records 0001 as applied. It is the MIGRATE string that
-- ran on every open before W1.2, with the value lists of that day written out.
--
-- Never edit this file: every later change is a numbered migration.

alter table query add column if not exists selector jsonb;
alter table query add column if not exists kind text not null default 'question';
alter table query add column if not exists from_version_id text references version(id);
alter table query add column if not exists from_element_id text;
alter table query add column if not exists answered_by text;
alter table query add column if not exists created_at timestamptz not null default now();

alter table query drop constraint if exists query_kind_check;
alter table query add constraint query_kind_check check (kind in ('question','note'));
alter table invalidation drop constraint if exists invalidation_reason_check;
alter table invalidation add constraint invalidation_reason_check check (reason in
  ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
   'upstream_dirty','review_failed','role_boundary','query_answered'));
