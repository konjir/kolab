-- Migration 0061: a first sign-in with Sign in with Apple waits for its person to choose a username (Lee, 2026-11-23).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Apple says who signed in by a stable id (`sub`) alone, with no username to name a new person
-- after, as GitHub's login does. So the first time an Apple account signs in, Kolab's page asks the
-- person to choose one, and only then makes them (Kolab.chooseUsername). Until then the sign-in
-- names no one (actor_id is null) and keeps the provider's id for whoever signed in here:
--
--   oauth_request.pending_subject  the identity provider's id for the person signing in, once
--                                  the provider has answered this browser with the sign-in's own
--                                  state, while it waits for them to choose a username; null
--                                  otherwise. Never both it and actor_id. Cleared when a person is
--                                  made or found for it, when the sign-in restarts, and with the
--                                  rest of an expired request's details (its tombstone).

alter table oauth_request
  add column pending_subject text check (pending_subject ~ '^[A-Za-z0-9._@|:-]{1,200}$'),
  add constraint oauth_request_pending_or_person check (pending_subject is null or actor_id is null);
