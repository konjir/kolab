-- Migration 0045: a delta records a move to the top level (W7.2, OVR3).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A delta's null parent_element_id means "keeps the parent's place", so a rebase or a fold, which
-- applies the delta to a new parent, put a moved element back in its section. top_level says the
-- delta moved it. The moves already standing are set too: a delta whose version holds its element at
-- the top level, where the version it builds on has it in a section. A move a rebase has put back
-- no longer stands, so it stays put back. Nothing else is rewritten.
alter table delta add column top_level boolean not null default false;

update delta d set top_level = true
  from version v, element e, element p
 where v.id = d.version_id
   and e.version_id = d.version_id and e.element_id = d.element_id
   and p.version_id = v.parent_version_id and p.element_id = d.element_id
   and d.kind = 'override' and d.parent_element_id is null
   and e.parent_element_id is null and p.parent_element_id is not null;

alter table delta add constraint delta_top_level_has_no_parent check (not top_level or parent_element_id is null);
