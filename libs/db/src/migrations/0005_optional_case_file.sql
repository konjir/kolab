-- Migration 0005: a ruling's case file is optional (W1.9; DAT9, CASE3, D16).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A ruling can be given directly, with no case file behind it, as the Decisions Log's entries
-- are (D16). It still records its author (actor_id) and its text.
--
-- A verdict, sustained or overruled, is said of a case file's position (CASE2), so a direct
-- ruling has none: a ruling has a verdict exactly when it has a case file. Every existing ruling
-- resolves a case file and has a verdict, so none breaks the new check.

alter table ruling alter column case_file_id drop not null;
alter table ruling alter column verdict drop not null;
alter table ruling add constraint ruling_verdict_with_case_file
  check ((case_file_id is null) = (verdict is null));
