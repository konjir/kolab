-- Migration 0029: a work package's fields, on a plan's elements (W5.1a; PLN1, PLN2, PLN3, D98).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A work package is an element of a plan (KON5). Its text says what to do; its fields say when it
-- is done, which work packages of the same plan version it depends on, its size, whether it is a
-- milestone and, for a milestone, its target date, and the repository it is done in when that is
-- not its binding's own (KON7). What it delivers stays a link (a dependency link to a binding
-- element, PLN1), because the cascade needs it; Depends on is a field, because links pin committed
-- versions (VER4), and two new work packages in one draft often depend on each other.
--
-- Both columns are nullable and nothing is rewritten: every element and delta written before this
-- migration has no work fields, and keeps its fingerprint.

alter table element add column work jsonb;
alter table delta   add column work jsonb;

-- Whether `w` is a work package's fields as Kolab stores them: null, or an object of at least one
-- of done_when (text, at most 4,000 characters), depends_on (1 to 50 element ids, each a non-empty
-- string, none twice), size (S, M or L), milestone (true; a work package that isn't one leaves it
-- out), target_date (a date, YYYY-MM-DD) and repo (a repository's id, at most 200 characters), and
-- nothing else. Only a milestone carries a target date (PLN2). Kolab's own constants are
-- MAX_DONE_WHEN, MAX_DEPENDS_ON, MAX_WORK_REPO and WORK_SIZES in @konjir/types.
create function kj_work_valid(w jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare d date;
begin
  if w is null then return true; end if;
  if jsonb_typeof(w) <> 'object' or w = '{}'::jsonb then return false; end if;
  if exists (select 1 from jsonb_object_keys(w) k
              where k not in ('done_when', 'depends_on', 'size', 'milestone', 'target_date', 'repo')) then
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
  if w ? 'repo' and (jsonb_typeof(w->'repo') <> 'string' or char_length(w->>'repo') not between 1 and 200) then
    return false;
  end if;
  if w ? 'target_date' then
    -- Only a milestone carries a target date (PLN2).
    if not w ? 'milestone' or jsonb_typeof(w->'target_date') <> 'string' or w->>'target_date' !~ '^\d{4}-\d{2}-\d{2}$' then
      return false;
    end if;
    begin
      d := (w->>'target_date')::date;
    exception when others then
      return false;
    end;
    -- A date that exists, written as it reads back: 2026-02-30 is no date.
    if to_char(d, 'YYYY-MM-DD') <> w->>'target_date' then return false; end if;
  end if;
  return true;
end
$$;

alter table element add constraint element_work_valid check (kj_work_valid(work));
alter table delta   add constraint delta_work_valid   check (kj_work_valid(work));

-- Work fields only on the versions of a plan, for every role: an agent's raw insert and Kolab's
-- own login alike. After row-level security, so an agent it refuses learns nothing more.
create function kj_element_work_plan_only() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n record;
begin
  if new.work is null then return null; end if;
  select n2.name, n2.kind into n from public.version v join public.node n2 on n2.id = v.node_id where v.id = new.version_id;
  if n.kind is distinct from 'plan' then
    raise exception '%: work fields (done_when, depends_on, size, milestone, target_date, repo) are only on a plan''s elements, its work packages (PLN1, D98); % is a %',
      tg_table_name, n.name, n.kind using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_element_work_plan_only() from public;
create constraint trigger element_work_plan_only after insert or update of work, version_id on element
  for each row execute function kj_element_work_plan_only();
create constraint trigger delta_work_plan_only after insert or update of work, version_id on delta
  for each row execute function kj_element_work_plan_only();
