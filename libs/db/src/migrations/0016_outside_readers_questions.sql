-- Migration 0016: a reader outside a kolab reads none of the questions its marks raised (D49, D51).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- 0008 lets kj_agent read, in another kolab it holds Read on, the questions on that kolab's
-- committed versions. Some of those a mark raised: a role-boundary finding, or a ruling that
-- changes the intent (D51), whose question quotes the ruling and whose row names the mark. That
-- kolab's marks and rulings stay private to its work (D49), so a reader outside it now reads only
-- the questions and notes people raised there, with no mark. Its own kolab reads as before.
drop policy kolab_read on query;
create policy kolab_read on query for select to kj_agent
  using (kolab_id = (select kj_session_kolab())
         or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
             and invalidation_id is null
             and exists (select 1 from version v where v.id = query.version_id and v.state = 'committed')));
