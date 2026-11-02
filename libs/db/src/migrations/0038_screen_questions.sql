-- Migration 0038: what a question Kolab raises for a prototype's screen asks about (W4.4, D79).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A committed change to a prototype's screen asks the spec requirements it shows by equivalence.
-- Kolab records, on each such question, the requirements it asks about: a list of
-- {"node": <node id>, "element": <element id, or null for the whole spec>}. Kolab settles the
-- question when a spec change marks the screen's link to one of them, withdraws it when the screen
-- or those links go, and knows its own questions by it, without reading any of that back out of the
-- question's words. Across kolabs, the words name none of them, since a reader here may not read that
-- kolab (D49, D53). Null for every other question.
--
-- One nullable column, and no row changed: it can neither refuse a database nor change what is in
-- one, so it needs no preflight.

alter table query add column about_links jsonb;
