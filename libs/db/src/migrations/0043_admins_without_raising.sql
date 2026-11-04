-- Migration 0043: an admin's own session runs the admin verbs, with no raising (W6.5; D111).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A Konjir admin's own session, signed in with the identity provider, runs the admin verbs for as
-- long as it lasts, and whether its person is still an admin is read on every request, so nothing
-- about it is stored on the session. What 0026 added for raising a session goes: session.admin_until,
-- the admin_raise requests, and oauth_request.raise_id. A sign-in in progress for a raise goes with
-- its column: without it, it would pass for a client's sign-in, under a client that doesn't exist.
--
-- audit_event_action_check keeps 'admin.elevated' and 'admin.lowered', and AUDIT_ACTIONS with it, so
-- the audit log's past rows stay valid and readable. Nothing writes either one now.
delete from oauth_request where raise_id is not null;
alter table oauth_request drop column raise_id;
drop table admin_raise;
alter table session drop column admin_until;
