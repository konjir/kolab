-- Migration 0035: at risk and revisit (W5.2b; PLN10, WRK6, D98, D102).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A work package with work (In progress, In review or Done) that an open mark reaches is at risk
-- (PLN10). Whether it is at risk, and what to revisit (its repository, commits, files and pull
-- requests), are computed when read, from the marks and the evidence: nothing is stored for them.
-- What is new is the notice: when a mark makes a package at risk, Kolab records an `at_risk` event,
-- with its last assignee as the assignee on both sides, so it reaches them in their answers as the
-- other events others make to their work do. An event, not a change of state: the package keeps
-- its state, and its versions are untouched (PLN4).
--
-- It only widens work_event_kind_check by one value, so every existing row still passes it: it can
-- neither refuse a database nor change what is in one, and needs no preflight.

alter table work_event drop constraint work_event_kind_check;
alter table work_event add constraint work_event_kind_check check (kind in
  ('added', 'removed', 'restored', 'pulled', 'released', 'reassigned', 'lapsed',
   'evidence', 'submitted', 'approved', 'changes_requested', 'done_unreviewed', 'reopened', 'confirmed',
   'milestone_done', 'milestone_reopened', 'at_risk'));   -- WORK_EVENT_KINDS in @konjir/types
