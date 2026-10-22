-- Migration 0023: a question about a version in review, which carries over or is withdrawn as that version settles (D65).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A question may now be asked of an element of a version in review, never of a draft (D65). It
-- records the version it was asked of (asked_version_id), which stays as it was while version_id
-- follows the question: when that version commits, the question is on the committed version
-- already; when it is abandoned or returned to its author, the question moves to its node's latest
-- committed version if the element is there, or is settled as withdrawn, with the reason as its
-- answer. Null, as for every question asked before this migration, is the version it is on.
alter table query add column asked_version_id text references version(id);

alter table query drop constraint query_state_check;
alter table query add constraint query_state_check check (state in ('open','answered','withdrawn'));  -- QUERY_STATES in @konjir/types
