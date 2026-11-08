-- Migration 0048: a test run's acceptance checks (W8.4; REV9, VER15).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A test_run evidence item may list the acceptance checks it ran: each a committed spec element,
-- by its full address (kj:<kolab>/<node>#<id>), the version it resolved to when it was recorded, and
-- whether it passed. Kolab resolves each address before it writes one. A failed check is an
-- acceptance_failed finding on the package's review request, which Kolab reads from this column: as
-- evidence is never edited or removed (PLN5), no verdict removes it. Redaction keeps the checks, which
-- carry addresses only, never an element's text (SRC1).
--
-- The column is new and null for every existing row, so no row fails its check.

create function kj_evidence_checks_valid(c jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
begin
  if c is null then return true; end if;
  if jsonb_typeof(c) <> 'array' or jsonb_array_length(c) not between 1 and 200 then return false; end if;
  if exists (select 1 from jsonb_array_elements(c) x
              where jsonb_typeof(x) <> 'object'
                 or exists (select 1 from jsonb_object_keys(x) k where k not in ('address', 'version', 'passed'))
                 or jsonb_typeof(x->'address') is distinct from 'string'
                 or x->>'address' !~ '^kj:[^/@#~\s]+/[^/@#~\s]+#[^~\s]+$'
                 or char_length(x->>'address') > 1000
                 or jsonb_typeof(x->'version') is distinct from 'number'
                 or (x->>'version') !~ '^[1-9][0-9]{0,9}$'
                 or jsonb_typeof(x->'passed') is distinct from 'boolean') then
    return false;
  end if;
  -- Each element once per test run.
  return (select count(distinct x->>'address') from jsonb_array_elements(c) x) = jsonb_array_length(c);
end
$$;

alter table evidence add column checks jsonb;
alter table evidence add constraint evidence_checks
  check (checks is null or (kind = 'test_run' and kj_evidence_checks_valid(checks)));

-- The checks are as fixed as the rest of an item of evidence: a redaction leaves them be.
create or replace function kj_evidence_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.title is null and new.files is null
     and (new.id, new.kolab_id, new.binding_node_id, new.element_id, new.event_id, new.kind, new.ref, new.url, new.recorded_by, new.at,
          new.repository_id, new.before_repositories, new.checks)
         is not distinct from
         (old.id, old.kolab_id, old.binding_node_id, old.element_id, old.event_id, old.kind, old.ref, old.url, old.recorded_by, old.at,
          old.repository_id, old.before_repositories, old.checks) then
    return new;
  end if;
  raise exception 'evidence: evidence is never edited or removed (PLN5); only Kolab redacts its text' using errcode = 'check_violation';
end
$$;
