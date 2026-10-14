import { readFileSync } from 'node:fs';

/** The full schema, applied to a fresh database. */
export const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * Brings a database created by an earlier release up to schema.sql. Every
 * statement is idempotent, so it runs on every open; on a fresh database it
 * changes nothing.
 */
export const MIGRATE = `
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
`;
