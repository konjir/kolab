-- Migration 0052: channels in a kolab, and the loop cap on agents waking each other.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A channel is a named room in a kolab that every member may read and write: a person or an agent,
-- on any machine. Like a message (0050), a channel message names no element, belongs to no layer,
-- blocks no work, and no job takes it. Unlike one, every member of the kolab reads it, members who
-- join later included: a channel keeps all its history.
--
--   kolab_chat        one row per kolab, made here for every kolab and by the trigger below for each
--                     new one: agent_run, how many agent-sent messages in a row the kolab holds, in
--                     its channels and its direct messages together, since the last a person sent
--                     anywhere in it; and agent_reply_cap, past which an agent-sent message wakes no
--                     agent (100 unless its owner changes it, cap_set_by). Every send locks this row
--                     (for no key update), so the kolab's messages are counted one at a time, and so is
--                     making a channel, so the count of channels holds (MAX_CHANNELS).
--   channel           one row per channel; its name is unique in its kolab (CHANNEL_NAME in
--                     @konjir/types). Every kolab has `general`, made with the kolab by the trigger
--                     below, and made here for every kolab that exists (made_by is null for it).
--                     Never removed.
--   channel_follow    a member's choice to follow a channel or not; without a row, a member follows
--                     `general` and no other. So a new member follows `general` with nothing written.
--   channel_message   one row per message, never edited or removed; reply_to names a message of the
--                     same channel. agent_run is the kolab's agent_run as it was sent, this message
--                     counted (0 for one a person sent).
--   channel_mention   the members a message mentions, resolved as it is sent; never edited or removed
--   channel_read      each member's read position in each channel: the newest message id read, or
--                     null for none. A person without a row has read nothing, so a later joiner reads
--                     the whole history; an agent's row is written at the channel's newest message
--                     when it is first seen following it, since history is no use to it unread.
--   message.agent_run the same count for a direct message (0 for those sent before this migration):
--                     past the cap, one from an agent to an agent wakes no one.
--
-- Kolab reads and writes them as kj_system, after the engine's checks, as it does messages: no
-- session's role is granted any of them.
--
-- New tables, a `general` channel and a kolab_chat row for each kolab, triggers that make both for
-- each new kolab, and one column of message whose default holds for every row. No row that exists
-- changes, so it needs no preflight.

create table kolab_chat (
  kolab_id        text primary key references kolab(id),
  agent_run       int not null default 0 constraint kolab_chat_agent_run check (agent_run >= 0),
  agent_reply_cap int not null default 100 constraint kolab_chat_agent_reply_cap check (agent_reply_cap between 1 and 100000),
  cap_set_by      text references actor(id),                    -- who set agent_reply_cap; null while it is the default
  cap_set_at      timestamptz
);

create table channel (
  id        text primary key,                                -- a ULID, or general:<kolab> for `general`
  kolab_id  text not null references kolab(id),
  name      text not null constraint channel_name_check check (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  made_by   text references actor(id),                       -- null only for `general`, made with its kolab
  made_at   timestamptz not null default clock_timestamp(),
  constraint channel_name_key unique (kolab_id, name),
  constraint channel_kolab_key unique (id, kolab_id),
  constraint channel_made_by check (made_by is not null or name = 'general')
);

create table channel_follow (
  channel_id text not null,
  kolab_id   text not null references kolab(id),
  actor_id   text not null references actor(id),
  following  boolean not null,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (channel_id, actor_id),
  constraint channel_follow_channel_fkey foreign key (channel_id, kolab_id) references channel(id, kolab_id)
);
create index channel_follow_actor on channel_follow(kolab_id, actor_id);

create table channel_message (
  id         text primary key,                               -- a ULID: messages sort by when they were sent
  kolab_id   text not null references kolab(id),
  channel_id text not null,
  sent_by    text not null references actor(id),
  body       text not null constraint channel_message_body_check check (btrim(body) <> ''),
  reply_to   text,
  agent_run  int not null constraint channel_message_agent_run check (agent_run >= 0),
  sent_at    timestamptz not null default clock_timestamp(),
  constraint channel_message_channel_fkey foreign key (channel_id, kolab_id) references channel(id, kolab_id),
  constraint channel_message_channel_key unique (id, channel_id),
  constraint channel_message_reply_fkey foreign key (reply_to, channel_id) references channel_message(id, channel_id)
);
create index channel_message_in on channel_message(channel_id, id);

create table channel_mention (
  message_id text not null,
  channel_id text not null,
  kolab_id   text not null references kolab(id),
  actor_id   text not null references actor(id),               -- the member it mentions
  primary key (message_id, actor_id),
  constraint channel_mention_message_fkey foreign key (message_id, channel_id) references channel_message(id, channel_id)
);
-- A member's mentions in a channel, after their read position.
create index channel_mention_actor on channel_mention(channel_id, actor_id, message_id);

create table channel_read (
  channel_id text not null,
  kolab_id   text not null references kolab(id),
  actor_id   text not null references actor(id),
  read_to    text references channel_message(id),              -- the newest message read; null for none
  read_at    timestamptz not null default clock_timestamp(),
  primary key (channel_id, actor_id),
  constraint channel_read_channel_fkey foreign key (channel_id, kolab_id) references channel(id, kolab_id)
);

alter table message add column agent_run int not null default 0 constraint message_agent_run check (agent_run >= 0);

-- Every kolab has `general` and its count: those there now, and each made from now on.
insert into kolab_chat(kolab_id) select k.id from kolab k;
insert into channel(id, kolab_id, name, made_by, made_at)
  select 'general:' || k.id, k.id, 'general', null, clock_timestamp() from kolab k;
create function kj_kolab_general() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  insert into public.kolab_chat(kolab_id) values (new.id);
  insert into public.channel(id, kolab_id, name, made_by) values ('general:' || new.id, new.id, 'general', null);
  return null;
end
$$;
revoke execute on function kj_kolab_general() from public;
create trigger kolab_general after insert on kolab for each row execute function kj_kolab_general();

-- A channel is never removed, nor moved to another kolab; messages, mentions and their kolab never change.
create function kj_channel_fixed() returns trigger
language plpgsql as $$
begin
  raise exception '%: a channel, its messages and their mentions are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;
revoke execute on function kj_channel_fixed() from public;
create trigger channel_fixed before delete on channel for each row execute function kj_channel_fixed();
create trigger channel_moved before update of id, kolab_id on channel for each row execute function kj_channel_fixed();
create trigger channel_kept before truncate on channel for each statement execute function kj_channel_fixed();
create trigger channel_message_fixed before update or delete on channel_message for each row execute function kj_channel_fixed();
create trigger channel_message_kept before truncate on channel_message for each statement execute function kj_channel_fixed();
create trigger channel_mention_fixed before update or delete on channel_mention for each row execute function kj_channel_fixed();
create trigger channel_mention_kept before truncate on channel_mention for each statement execute function kj_channel_fixed();
create trigger kolab_chat_fixed before delete or update of kolab_id on kolab_chat for each row execute function kj_channel_fixed();
create trigger kolab_chat_kept before truncate on kolab_chat for each statement execute function kj_channel_fixed();

-- An archived kolab changes no more (0014): no channel, follow, message, mention, read or count.
do $$
declare t text;
begin
  foreach t in array array['kolab_chat', 'channel', 'channel_follow', 'channel_message', 'channel_mention', 'channel_read'] loop
    execute format('create trigger kolab_writable_insert after insert on %I referencing new table as kj_rows
                      for each statement execute function kj_kolab_writable()', t);
    execute format('create trigger kolab_writable_update after update on %I referencing new table as kj_rows
                      for each statement execute function kj_kolab_writable()', t);
    execute format('create trigger kolab_writable_delete after delete on %I referencing old table as kj_rows
                      for each statement execute function kj_kolab_writable()', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy system_all on %I for all to kj_system using (true) with check (true)', t);
  end loop;
end
$$;
grant select, insert on channel, channel_message, channel_mention to kj_system;
grant select, insert, update on kolab_chat, channel_follow, channel_read to kj_system;
