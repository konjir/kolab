-- Migration 0037: indexes for when a person's agents last used Kolab (W5.6, D106).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- konjir_list_agents, and the refusal at the cap on live agents, say when each of a person's agents
-- last used Kolab, derived from what Kolab already records: the latest of a session of its opening,
-- its grant being issued or renewed (oauth_grant's expiry, by oauth_grant_actor), and a job of its
-- ending. These two indexes find the first and the last by the agent, in its own rows only.
--
-- Two indexes, and no table or row changed: it can neither refuse a database nor change what is in
-- one, so it needs no preflight.

create index session_actor_started on session(actor_id, started_at);
create index job_agent_ended on job(agent_id, ended_at);
