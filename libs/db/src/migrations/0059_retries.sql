-- Migration 0059: what lets konnect's phone app retry without harm.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A phone loses responses: a refresh whose answer never arrives, a message whose Send it retries.
--
--   oauth_refresh_token.successor  the tokens a refresh gave in place of this one, sealed with a key
--                                  only this refresh token derives (AES-256-GCM under HKDF-SHA256 of
--                                  it, Kolab.refreshGrant), so the same refresh retried within the
--                                  grace window (refreshGraceS) gets the same answer instead of
--                                  being refused, and nothing in the database alone opens it: Kolab
--                                  keeps only the token's sha256, as it always has. Cleared once the
--                                  successor is used in turn, and null for every token before.
--   message.nonce,                 a client's own id for a send (konjir_send_message,
--   channel_message.nonce          konjir_send_channel_message), unique for its sender in its kolab,
--                                  so a send repeated with the same nonce returns the message it
--                                  sent instead of sending it twice. Null for every message before,
--                                  and for any send that gives none.
--
-- Three new nullable columns and two partial unique indexes. No row that exists changes, so it
-- needs no preflight. The message tables stay append-only (0050, 0052): a nonce is written once,
-- with its message.

alter table oauth_refresh_token add column successor text;

alter table message add column nonce text constraint message_nonce_form check (nonce is null or (length(nonce) between 1 and 100));
create unique index message_nonce on message(kolab_id, sent_by, nonce) where nonce is not null;

alter table channel_message add column nonce text constraint channel_message_nonce_form check (nonce is null or (length(nonce) between 1 and 100));
create unique index channel_message_nonce on channel_message(kolab_id, sent_by, nonce) where nonce is not null;
