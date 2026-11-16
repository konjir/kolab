-- Migration 0052: channels in a kolab.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A channel is a named room in a kolab that every member may read and write: a person or an agent,
-- on any machine. Like a message (0050), a channel message names no element, belongs to no layer,
-- blocks no work, and no job takes it. Unlike one, every member of the kolab reads it, members who
-- join later included: a channel keeps all its history.
--
--   channel           one row per channel; its name is unique in its kolab (CHANNEL_NAME in
--                     @konjir/types). Every kolab has `general`, made with the kolab by the trigger
--                     below, and made here for every kolab that exists (made_by is null for it).
--                     Never removed.
--   channel_follow    a member's choice to follow a channel or not; without a row, a member follows
--                     `general` and no other. So a new member follows `general` with nothing written.
--   channel_message   one row per message, never edited or removed; reply_to names a message of the
--                     same channel. agent_run is how many agent-sent messages in a row the channel
--                     holds up to and including this one since the last a person sent (0 for one a
--                     person sent), counted as it is sent, under the channel's row lock: the loop cap
--                     compares it with the kolab's agent_reply_cap.
--   channel_mention   the members a message mentions, resolved as it is sent; never edited or removed
--   channel_read      each member's read position in each channel: the newest message id read. A
--                     member without a row has read nothing, so a later joiner reads the whole history.
--   channel_setting   a kolab's channel settings, keyed by the kolab: agent_reply_cap, how many agent
--                     messages in a row wake agents before a person posts. A kolab without a row has
--                     the default, 100, so this migration writes none.
--
-- Kolab reads and writes them as kj_system, after the engine's checks, as it does messages: no
-- session's role is granted any of them.
--
-- New tables, a `general` row for each kolab, and a trigger that makes one for each new kolab. No
-- row that exists changes, so it needs no preflight.

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
  message_id text not null references channel_message(id),
  kolab_id   text not null references kolab(id),
  actor_id   text not null references actor(id),               -- the member it mentions
  primary key (message_id, actor_id)
);
create index channel_mention_actor on channel_mention(kolab_id, actor_id);

create table channel_read (
  channel_id text not null,
  kolab_id   text not null references kolab(id),
  actor_id   text not null references actor(id),
  read_to    text not null references channel_message(id),     -- the newest message read
  read_at    timestamptz not null default clock_timestamp(),
  primary key (channel_id, actor_id),
  constraint channel_read_channel_fkey foreign key (channel_id, kolab_id) references channel(id, kolab_id)
);

create table channel_setting (
  kolab_id        text primary key references kolab(id),
  agent_reply_cap int not null default 100 constraint channel_setting_agent_reply_cap check (agent_reply_cap between 1 and 100000),
  updated_by      text not null references actor(id),
  updated_at      timestamptz not null default clock_timestamp()
);

-- Every kolab has `general`: those there now, and each made from now on.
insert into channel(id, kolab_id, name, made_by, made_at)
  select 'general:' || k.id, k.id, 'general', null, clock_timestamp() from kolab k;
create function kj_kolab_general() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
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

-- An archived kolab changes no more (0014): no channel, follow, message, mention, read or setting.
do $$
declare t text;
begin
  foreach t in array array['channel', 'channel_follow', 'channel_message', 'channel_mention', 'channel_read', 'channel_setting'] loop
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
grant select, insert, update on channel_follow, channel_read, channel_setting to kj_system;
