-- Migration 0047: Done means released where a package says so (W7.7; PLN16).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A work package that must be released says so in its work field (`release: true`). An approval
-- leaves such a package In review, approved (`approved`), until evidence of its release is recorded:
-- an evidence item of kind `release`, naming the deploy run (its https link) and the commit it
-- released (its sha, in a repository registered in the kolab), recorded with a `release_recorded`
-- event. That makes it Done. A package without the field is Done on approval, as before.
--
-- Every change here widens what is allowed, or adds a column whose default holds for every row, so
-- no existing row fails it and nothing in the database changes.

-- ---- the work field ----

create or replace function kj_work_valid(w jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare d date;
begin
  if w is null then return true; end if;
  if jsonb_typeof(w) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(w) k
              where k not in ('done_when', 'depends_on', 'size', 'milestone', 'target_date', 'repo', 'release')) then
    return false;
  end if;
  if w ? 'done_when' and (jsonb_typeof(w->'done_when') <> 'string' or char_length(w->>'done_when') not between 1 and 4000) then
    return false;
  end if;
  if w ? 'depends_on' then
    if jsonb_typeof(w->'depends_on') <> 'array' or jsonb_array_length(w->'depends_on') not between 1 and 50 then return false; end if;
    if exists (select 1 from jsonb_array_elements(w->'depends_on') x where jsonb_typeof(x) <> 'string' or x #>> '{}' = '') then
      return false;
    end if;
    if (select count(distinct x #>> '{}') from jsonb_array_elements(w->'depends_on') x) <> jsonb_array_length(w->'depends_on') then
      return false;
    end if;
  end if;
  if w ? 'size' and (jsonb_typeof(w->'size') <> 'string' or w->>'size' not in ('S', 'M', 'L')) then
    return false;
  end if;
  if w ? 'milestone' and w->'milestone' <> 'true'::jsonb then return false; end if;
  -- A milestone has no work of its own to release (PLN3): its members are released.
  if w ? 'release' and (w->'release' <> 'true'::jsonb or w ? 'milestone') then return false; end if;
  if w ? 'repo' and (jsonb_typeof(w->'repo') <> 'string' or char_length(w->>'repo') not between 1 and 200) then
    return false;
  end if;
  if w ? 'target_date' then
    if not w ? 'milestone' or jsonb_typeof(w->'target_date') <> 'string' or w->>'target_date' !~ '^\d{4}-\d{2}-\d{2}$' then
      return false;
    end if;
    begin
      d := (w->>'target_date')::date;
    exception when others then
      return false;
    end;
    if to_char(d, 'YYYY-MM-DD') <> w->>'target_date' then return false; end if;
  end if;
  return true;
end
$$;

-- ---- approved, waiting for its release ----

alter table work_package add column approved boolean not null default false;
-- Only In review: whatever moves a package out of review (its release, a removal, a reopening,
-- a binding that drops its release field) leaves it no longer waiting.
create function kj_work_approved() returns trigger
language plpgsql as $$
begin
  if new.state <> 'in_review' then new.approved := false; end if;
  return new;
end
$$;
revoke execute on function kj_work_approved() from public;
create trigger work_approved before insert or update on work_package for each row execute function kj_work_approved();
alter table work_package add constraint work_package_approved check (not approved or state = 'in_review');

-- ---- the evidence kind, and its event ----

alter table evidence drop constraint evidence_kind_check;
alter table evidence add constraint evidence_kind_check
  check (kind in ('commit', 'pull_request', 'test_run', 'release'));   -- EVIDENCE_KINDS in @konjir/types
-- A release names the commit it released, by its full sha, and the deploy run, by its link. Its
-- repository is required, as a commit's is (0032's evidence_repository).
alter table evidence add constraint evidence_release
  check (kind <> 'release' or (ref ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' and url is not null));

alter table work_event drop constraint work_event_kind_check;
alter table work_event add constraint work_event_kind_check check (kind in
  ('added', 'removed', 'restored', 'pulled', 'released', 'reassigned', 'lapsed',
   'evidence', 'submitted', 'approved', 'changes_requested', 'done_unreviewed', 'reopened', 'confirmed',
   'milestone_done', 'milestone_reopened', 'at_risk', 'release_recorded'));   -- WORK_EVENT_KINDS in @konjir/types
