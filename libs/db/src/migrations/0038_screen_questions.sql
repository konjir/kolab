-- Migration 0038: what a question Kolab raises for a prototype's screen asks about (W4.4, D79).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A committed change to a prototype's screen asks the spec requirements it shows by equivalence.
-- Kolab records, on each such question, the requirements it asks about: a list of
-- {"node": <node id>, "element": <element id, or null for the whole spec>, "selector": <the words
-- the link quotes, if it does>, "fingerprint": <what the link pinned when it was asked>}. A person's answer stands only while the spec still has
-- that fingerprint. Kolab settles the
-- question when a spec change marks the screen's link to one of them, withdraws it when the screen
-- or those links go, and knows its own questions by it, without reading any of that back out of the
-- question's words. Across kolabs, the words name none of them, since a reader here may not read that
-- kolab (D49, D53). Null for every other question.
--
-- A query_answered mark records the question whose answer it carries, invalidation.query_id, so a
-- screen that settles that mark is known to obey that question, not read back out of the mark's
-- note. Marks raised before this have none, and count as answering nothing in particular.
-- It has no ON DELETE and no index: nothing deletes a question, and it is read only from the mark.
--
-- Two nullable columns, and no row changed: it can neither refuse a database nor change what is in
-- one, so it needs no preflight.

alter table query add column about_links jsonb;
alter table invalidation add column query_id text references query(id);
