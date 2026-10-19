-- Migration 0022: a session that holds only Read reads none of the questions marks raised, in its own kolab too (D49, D51).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- 0016 kept a reader from another kolab off the questions that kolab's marks raised (a role
-- boundary, a ruling that changes the intent), but read the session's own kolab whole. D49 covers
-- any reader who holds Read on a kolab without belonging to its work, such as anyone reading a
-- public kolab in a session opened there: its marks and rulings stay private to its work. So in the
-- session's own kolab, a question a mark raised now reads only for a session that belongs
-- (kj_session_belongs, 0013: Write on a layer of it). Questions and notes people raised read as before.
drop policy kolab_read on query;
create policy kolab_read on query for select to kj_agent
  using ((kolab_id = (select kj_session_kolab())
          and (invalidation_id is null or (select kj_session_belongs())))
         or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
             and invalidation_id is null
             and exists (select 1 from version v where v.id = query.version_id and v.state = 'committed')));
