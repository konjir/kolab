import { readFileSync } from 'node:fs';
import { MARK_REASONS, QUERY_KINDS } from '@konjir/types';

export { openDb, type Db } from './connect.js';

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * The checks whose value lists live in @konjir/types. Both SCHEMA and MIGRATE
 * apply them, so a new value is added in one place.
 */
const CHECKS = `
  alter table query drop constraint if exists query_kind_check;
  alter table query add constraint query_kind_check check (kind in (${list(QUERY_KINDS)}));
  alter table invalidation drop constraint if exists invalidation_reason_check;
  alter table invalidation add constraint invalidation_reason_check check (reason in (${list(MARK_REASONS)}));
`;

/** The full schema, applied to a fresh database. */
export const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8') + CHECKS;

/**
 * Brings a database created by an earlier release up to SCHEMA. Every
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
${CHECKS}`;
