-- Migration 0005: a ruling's case file is optional (W1.9; DAT9, CASE2, CASE3, D16).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A ruling can be given directly, with no case file behind it, as the Decisions Log's entries
-- are (D16). It records its author (actor_id) and its body (text): what the Decisions Log calls
-- an entry's verdict is a ruling's text.
--
-- The verdict column is the other sense of the word: the sustained or overruled outcome on a
-- case file. CASE2 gives that outcome to each position, not to the ruling, so a position now
-- carries its own. ruling.verdict becomes optional and is no longer the place for it: a direct
-- ruling has no position to sustain, and a case file's ruling records its outcomes on its
-- positions. Every existing ruling keeps the verdict it has.

alter table ruling alter column case_file_id drop not null;
alter table ruling alter column verdict drop not null;

-- What a direct ruling rules on. A case file's ruling reaches its subject, and so its node and
-- kolab, through the case file. A direct ruling names the version it rules on, and optionally an
-- element in it, as a case file does. Exactly one of the two paths is set.
alter table ruling add column version_id text references version(id);
alter table ruling add column element_id text;
alter table ruling add constraint ruling_subject_check
  check ((case_file_id is null) <> (version_id is null) and (element_id is null or version_id is not null));

-- What the ruling overrules, in words, as the Decisions Log's "Replaces" says it.
alter table ruling add column replaces text;

-- Each position's outcome on its case file (CASE2), set when the case file is ruled on.
alter table position add column verdict text
  constraint position_verdict_check check (verdict in ('sustained','overruled'));
