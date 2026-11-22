-- Migration 0059: what lets konnect's phone app retry without harm.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A phone loses responses: a refresh whose answer never arrives, a message whose Send it retries.
--
--   oauth_refresh_token.successor  the tokens a refresh gave in place of this one, sealed with a key
--                                  only this refresh token derives (AES-256-GCM under HKDF-SHA256 of
--                                  it, bound to the row's key and grant, Kolab.refreshGrant), so the
--                                  same refresh retried before its successor is used, within
--                                  refreshRetryS of its use, gets the same answer instead of being
--                                  a replay, and nothing in the database alone opens it: Kolab
--                                  keeps only the token's sha256, as it always has. Cleared once the
--                                  successor is used in turn, its refresh token or its access token
--                                  (oauth_refresh_token_sealed finds them), and null for every token
--                                  before.
--   notification_pref.agents       what the person is pushed of each of their own agents in the kolab
--                                  (Lee, 2026-11-22): by the agent's name, never, stuck (the default,
--                                  without a key) or all (AGENT_NOTIFY_LEVELS); a JSON object.
--   notification_pref.agents_stuck_pushed
--                                  when each agent's owner was last pushed that it is stuck, by the
--                                  agent's name, so it is at most once an hour (AGENT_STUCK_PUSH_EVERY_S).
--   message.nonce,                 a client's own id for a send (konjir_send_message,
--   channel_message.nonce          konjir_send_channel_message), unique for its sender in its kolab,
--                                  so a send repeated with the same nonce returns the message it
--                                  sent instead of sending it twice. Null for every message before,
--                                  and for any send that gives none.
--
-- And two indexes for an owner reading their agents' activity (Kolab.agentActivityRows): the
-- channel messages one member sent, and those that mention one, in a kolab, newest first.
--
-- Three new nullable columns, two with defaults, three partial indexes (two of them unique) and two
-- more. No row that exists changes but to take the defaults, so it needs no preflight. The message tables stay append-only (0050, 0052): a nonce is written once,
-- with its message.

alter table oauth_refresh_token add column successor text;
create index oauth_refresh_token_sealed on oauth_refresh_token(grant_id) where successor is not null;

alter table notification_pref
  add column agents jsonb not null default '{}' constraint notification_pref_agents_check check (jsonb_typeof(agents) = 'object'),
  add column agents_stuck_pushed jsonb not null default '{}' constraint notification_pref_agents_stuck_check check (jsonb_typeof(agents_stuck_pushed) = 'object');

alter table message add column nonce text constraint message_nonce_form check (nonce is null or (length(nonce) between 1 and 100));
create unique index message_nonce on message(kolab_id, sent_by, nonce) where nonce is not null;

alter table channel_message add column nonce text constraint channel_message_nonce_form check (nonce is null or (length(nonce) between 1 and 100));
create unique index channel_message_nonce on channel_message(kolab_id, sent_by, nonce) where nonce is not null;

create index channel_message_by on channel_message(kolab_id, sent_by, id);
create index channel_mention_in on channel_mention(kolab_id, actor_id, message_id);
