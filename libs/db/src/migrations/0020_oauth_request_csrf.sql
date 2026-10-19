-- Migration 0020: a sign-in found by its consent form's token, by index (D55; API1).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A consent form names its sign-in, whose binding cookie the browser may have dropped (it expired,
-- or a newer sign-in in the browser took its place); Kolab then finds the sign-in by the form's
-- token alone, to say what became of it (Kolab.signInStatus). That lookup comes from a request
-- no one has signed in to, so it is by index, never a scan. Each token is 32 random bytes, so the
-- index is unique; a sign-in not yet identified has none.

create unique index oauth_request_csrf on oauth_request(csrf_key) where csrf_key is not null;
