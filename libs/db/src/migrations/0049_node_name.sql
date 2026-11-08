-- Migration 0049: every name a node has had, so its former names keep resolving and are never given
-- to another node (W8.5; DAT22, ADR11, D37).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- node.name stays a node's current name. node_name holds that name and every one the node had
-- before, one row each, unique in its kolab across current and former names alike: so a name a node
-- has had is never another's, for any role. A node's id never changes, and links, versions and marks
-- name it by its id, so a rename changes none of them.

create table node_name (
  kolab_id text not null references kolab(id),
  name     text not null constraint node_name_name_check check (name ~ '^[^/@#~[:space:]]+$'),
  node_id  text not null,
  named_at timestamptz not null default now(),
  constraint node_name_pkey primary key (kolab_id, name),
  constraint node_name_node_kolab_fkey foreign key (node_id, kolab_id) references node(id, kolab_id)
);
create index node_name_node_idx on node_name(node_id);
create trigger kolab_fixed before update of kolab_id on node_name for each row execute function kj_kolab_fixed();
-- An archived kolab's names are kept as they were, like the rest of its data (0014).
create trigger kolab_writable_insert after insert on node_name referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on node_name referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on node_name referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

-- A name, once a node's, stays that node's: only when the node is named it again does its row change,
-- and then only when it was named.
create function kj_node_name_kept() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.kolab_id, new.name, new.node_id) is not distinct from (old.kolab_id, old.name, old.node_id) then
    return new;
  end if;
  raise exception 'node_name: a name a node has had stays that node''s, and is never given to another (ADR11)' using errcode = 'check_violation';
end
$$;
create trigger node_name_kept before update or delete on node_name for each row execute function kj_node_name_kept();

-- Every node's current name, and the one former name D37 records: kolab-wbs, the kolab kolab's plan
-- before it was kolab-plan.
insert into node_name(kolab_id, name, node_id, named_at)
  select kolab_id, name, id, coalesce(created_at, now()) from node;
insert into node_name(kolab_id, name, node_id, named_at)
  select kolab_id, 'kolab-wbs', id, coalesce(created_at, now()) from node where kolab_id = 'kolab' and name = 'kolab-plan'
  on conflict (kolab_id, name) do nothing;

-- A new node's name is its first row, written by the database itself, so whichever role makes the
-- node, a name another node has had refuses it (node_name_pkey). Its id is its name, or '~' and a
-- ULID (0008); once a node is renamed its id is a former name, so this is checked as it is made.
alter table node drop constraint node_id_name_check;
create function kj_node_named() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not (new.id = new.name or new.id ~ '^~[0-9A-HJKMNP-TV-Z]{26}$') then
    raise exception 'node_id_name_check: a new node''s id is its name, or ''~'' and a ULID' using errcode = 'check_violation';
  end if;
  insert into public.node_name(kolab_id, name, node_id) values (new.kolab_id, new.name, new.id);
  return null;
end
$$;
revoke execute on function kj_node_named() from public;
create trigger node_named after insert on node for each row execute function kj_node_named();

-- A node's id never changes. Its name changes only as Kolab's trusted role renames it, writing the
-- new name's row in the same transaction, whose named_at is the transaction's time (now()): a former
-- name of its own it takes back, refreshing its named_at, and any name another node has had the
-- primary key refuses.
create or replace function kj_node_name_fixed() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id then
    raise exception 'node: a node''s id never changes once written' using errcode = 'check_violation';
  end if;
  if new.name is distinct from old.name and not (
       current_user = 'kj_system'
       and exists (select 1 from node_name nn where nn.kolab_id = new.kolab_id and nn.name = new.name and nn.node_id = new.id
                                               and nn.named_at = now())) then
    raise exception 'node: a node''s name changes only as Kolab renames it, naming it in node_name in the same transaction (ADR11)' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- Kolab writes it, as kj_system or its own login; an agent reads the names of the nodes it reads, as
-- node's own policy (0008) lets it, and never writes one.
alter table node_name enable row level security;
create policy kolab_read on node_name for select to kj_agent
  using (kolab_id = (select kj_session_kolab()) or kolab_id = any ((select kj_session_readable_kolabs())::text[]));
create policy system_all on node_name for all to kj_system using (true) with check (true);
grant select on node_name to kj_agent;
grant select, insert, update (named_at) on node_name to kj_system;
