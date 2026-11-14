-- Migration 0051: work found already built.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A kolab's spec need not cover the whole of its product, and a product may be older than its
-- kolab: what a work package asks for can already be there when the package is pulled. Its
-- assignee then builds nothing and submits it as found built (konjir_submit_work found_built=true),
-- with the commit it was checked at as evidence, and it is reviewed like any other. `found_built`
-- records that, while the package is In review or Done: such a run says nothing of how long work of
-- its size takes, so a forecast leaves it out, and a reader can tell it from work Kolab watched.
--
-- One column whose default holds for every row, so nothing in the database changes.

alter table work_package add column found_built boolean not null default false;
-- Only In review or Done: whatever returns a package to its assignee or to To do (a request for
-- changes, a reopening, a removal) starts work that is built, not found.
create function kj_work_found_built() returns trigger
language plpgsql as $$
begin
  if new.state not in ('in_review', 'done') then new.found_built := false; end if;
  return new;
end
$$;
revoke execute on function kj_work_found_built() from public;
create trigger work_found_built before insert or update on work_package for each row execute function kj_work_found_built();
alter table work_package add constraint work_package_found_built check (not found_built or state in ('in_review', 'done'));
