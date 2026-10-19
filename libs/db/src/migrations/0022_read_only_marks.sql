-- Migration 0022: a session that holds only Read reads none of its own kolab's marks, nor the questions they raised (D49, D51).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- D49 covers any reader who holds Read on a kolab without belonging to its work, such as anyone
-- reading a public kolab in a session opened there: its marks and rulings stay private to its work.
-- 0013 held case files, positions and rulings to that, and 0016 kept a reader from another kolab
-- off the questions marks raised, but the session's own kolab read whole: its marks (whose notes
-- quote a ruling's text, or the review gate's finding) and the questions they raised. Now, in the
-- session's own kolab, a mark, a mark's cause, and a question a mark raised read only for a session
-- that belongs (kj_session_belongs, 0013: Write on a layer of it, an agent capped by kj_agent_cap,
-- 0018). Questions and notes people raised read as before. Another kolab's marks never read, as
-- before, and 0016's rule for another kolab's questions is unchanged. Kolab's own writes run as
-- the owner or kj_system, which this doesn't touch.
drop policy kolab_read on query;
create policy kolab_read on query for select to kj_agent
  using ((kolab_id = (select kj_session_kolab())
          and (invalidation_id is null or (select kj_session_belongs())))
         or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
             and invalidation_id is null
             and exists (select 1 from version v where v.id = query.version_id and v.state = 'committed')));

drop policy kolab_read on invalidation;
create policy kolab_read on invalidation for select to kj_agent
  using (kolab_id = (select kj_session_kolab()) and (select kj_session_belongs()));

drop policy kolab_read on invalidation_cause;
create policy kolab_read on invalidation_cause for select to kj_agent
  using (kolab_id = (select kj_session_kolab()) and (select kj_session_belongs()));
