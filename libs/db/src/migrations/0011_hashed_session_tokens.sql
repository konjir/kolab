-- Migration 0011: store only a hash of each session token (P1, D50; ENF5, DAT10).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A session's id was its bearer token, so anyone who could read the session table, or a backup
-- or snapshot of it, could act as every open session. Now the id is the session's key: the
-- sha256 of its token, base64url without padding, which is what the engine's sessionKey computes
-- and what session-ended events already carried (D41). Kolab hashes the token it is handed and
-- looks the session up by that key; the token itself is shown once, when the session opens, and
-- never reaches the database again. kj.session carries the key too, so the row-level security
-- helpers (kj_session_kolab, kj_session_layer, kj_session_actor, kj_session_role and
-- kj_session_readable_kolabs) keep comparing session.id to it unchanged.
--
-- Every existing session, open or ended, is hashed in place, so each token handed out before this
-- release keeps working, its agent's included. No table references session, so nothing else
-- changes. The check keeps a token from ever being stored as an id again: a token is kjs_ and 32
-- characters, a key exactly 43 base64url characters.

update session set id = rtrim(translate(encode(sha256(convert_to(id, 'UTF8')), 'base64'), '+/', '-_'), '=');

alter table session add constraint session_id_is_key check (id ~ '^[A-Za-z0-9_-]{43}$');
