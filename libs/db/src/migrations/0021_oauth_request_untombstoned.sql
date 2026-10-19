-- Migration 0021: the sign-ins still to be made tombstones, by index (D55; API1).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Each sign-in's start (Kolab.beginAuthorization) clears what an expired sign-in kept of the
-- client's request, leaving a tombstone: its keys and times only. That comes from a request no one
-- has signed in to, so it reaches only the sign-ins still holding something, by this index, never
-- walking the tombstones already made. Its predicate is the sweep's own, so the planner can use it.

create index oauth_request_untombstoned on oauth_request(expires_at)
  where redirect_uri <> '' or client_state is not null or scope is not null or resource is not null or invite_key is not null;
