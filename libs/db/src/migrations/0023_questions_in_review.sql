-- Migration 0023: a question about a version in review, which carries over or is withdrawn as that version settles, and never reaches a reader outside the kolab unless the version it was asked of committed (D65).
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

-- A reader outside the kolab (0016, 0022) reads a question only if the version it was asked of
-- committed: one asked of a version in review that was then abandoned, returned or rejected may
-- have moved to a committed version, but its words are about text that never committed (D49, D58).
-- A question asked before this migration (null) was asked of the version it is on, as before.
drop policy kolab_read on query;
create policy kolab_read on query for select to kj_agent
  using ((kolab_id = (select kj_session_kolab())
          and (invalidation_id is null or (select kj_session_belongs())))
         or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
             and invalidation_id is null
             and exists (select 1 from version v where v.id = query.version_id and v.state = 'committed')
             and (asked_version_id is null
                  or exists (select 1 from version a where a.id = query.asked_version_id and a.state = 'committed'))));
