-- Migration 0057: indexes for a member's direct conversations, one per member they talk with (konnect's app).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- konjir_list_conversations lists one row per member the caller has exchanged a direct message with
-- (0050), with the newest message either way. It finds those members by skipping through the
-- indexes below a member at a time (a recursive query, so it reads one entry per member talked
-- with, not one per message), then each conversation's newest message, its unread count, and the
-- newest message the other way, each a short range of the same indexes.
--
--   message_to_from  the messages to a member, by sender, newest last
--   message_from_to  the messages from a member, by recipient, newest last
--
-- Two new indexes. No row or table changes, so it needs no preflight.

create index message_to_from on message(kolab_id, sent_to, sent_by, id);
create index message_from_to on message(kolab_id, sent_by, sent_to, id);
