-- Migration 0050: messages between a kolab's members.
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A message is a few words from one member of a kolab to another: a person or an agent, on any
-- machine. It names no element, belongs to no layer, blocks no work, and no job takes it: questions,
-- notes, reviews and work go on as they were. It stays in the kolab it was sent in, and only its
-- sender and its recipient ever read it.
--
--   message          one row per message, never edited or removed; reply_to names the message of
--                    the same two members it answers, in the same kolab
--   message_receipt  one row once its recipient has read it (konjir_read_messages); a message
--                    without one is unread
--
-- Kolab reads and writes both as kj_system or on its own login, after the engine's checks. No
-- session's role is granted either: a message is its two members' alone, which the kolab-wide read
-- every other table gives kj_agent would not keep.
--
-- Two new tables and one more kind of rate event. No row that exists changes, so it can neither
-- refuse a database nor change what is in one, and needs no preflight.

create table message (
  id        text primary key,                               -- a ULID: messages sort by when they were sent
  kolab_id  text not null references kolab(id),
  sent_by   text not null references actor(id),
  sent_to   text not null references actor(id),
  body      text not null constraint message_body_check check (btrim(body) <> ''),
  reply_to  text,
  sent_at   timestamptz not null default clock_timestamp(),
  constraint message_kolab_key unique (id, kolab_id),
  constraint message_not_to_self check (sent_by <> sent_to),
  constraint message_reply_kolab_fkey foreign key (reply_to, kolab_id) references message(id, kolab_id)
);
create index message_to on message(kolab_id, sent_to, id);
create index message_by on message(kolab_id, sent_by, id);
create index message_replies on message(reply_to) where reply_to is not null;

create table message_receipt (
  message_id text primary key,
  kolab_id   text not null references kolab(id),
  actor_id   text not null references actor(id),            -- its recipient, who read it
  read_at    timestamptz not null default clock_timestamp(),
  constraint message_receipt_message_kolab_fkey foreign key (message_id, kolab_id) references message(id, kolab_id)
);
create index message_receipt_actor on message_receipt(kolab_id, actor_id);

-- Messages and receipts are never edited or removed, by any role.
create function kj_message_fixed() returns trigger
language plpgsql as $$
begin
  raise exception '%: a message and its receipt are never edited or removed', tg_table_name using errcode = 'check_violation';
end
$$;
revoke execute on function kj_message_fixed() from public;
create trigger message_fixed before update or delete on message for each row execute function kj_message_fixed();
create trigger message_kept before truncate on message for each statement execute function kj_message_fixed();
create trigger message_fixed before update or delete on message_receipt for each row execute function kj_message_fixed();
create trigger message_kept before truncate on message_receipt for each statement execute function kj_message_fixed();

-- An archived kolab takes no new messages and no new receipts, like the rest of its data (0014):
-- what was unread when it was archived stays unread.
create trigger kolab_writable_insert after insert on message referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on message referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on message referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_insert after insert on message_receipt referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on message_receipt referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on message_receipt referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

alter table message enable row level security;
alter table message_receipt enable row level security;
create policy system_all on message for all to kj_system using (true) with check (true);
create policy system_all on message_receipt for all to kj_system using (true) with check (true);
grant select, insert on message, message_receipt to kj_system;

-- ---- the message rate ----
-- Messages have a budget of their own, beside questions and notes (`ask`) and drafts, counted the
-- same way (0025): a conversation doesn't spend the budget for questions, nor the other way round.
alter table rate_event drop constraint rate_event_kind_check;
alter table rate_event add constraint rate_event_kind_check check (kind in ('ask', 'draft', 'message'));

-- kj_rate_use as 0025 made it, reading a message's hold too.
create or replace function kj_rate_use(p_hold text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_parts text[] := regexp_match(p_hold, '^(ask|draft|message):(.+):[0-9a-f]{32}$');
begin
  if v_parts is null then raise exception 'not a rate hold: %', p_hold; end if;
  insert into public.rate_event(id, owner_id, kind, held) values (p_hold, v_parts[2], v_parts[1], false)
    on conflict (id) do update set held = false;
end $$;
