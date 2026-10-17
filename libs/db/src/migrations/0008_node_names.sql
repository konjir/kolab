-- Migration 0008: a node's name is unique within its kolab, not across the whole database, and
-- a session may read the committed work of another kolab it holds Read on (W1.4; DAT11, ADR3,
-- D8, TEN12).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Addresses carry the kolab: kj:<kolab>/<node>, or kj:<node> inside a kolab (ADR3, D8). So a
-- node's name need only be unique within its kolab, and two kolabs may each have a node called
-- `checkout`, neither learning of the other (TEN12).
--
-- A node keeps its id, the primary key every version refers to; its name is a column of its own.
-- An existing node's id was its name, so each gets that name, in its kolab. A new node's id is its
-- name too, unless another kolab's node holds that id already; then it is '~' and a ULID, which
-- no name can be (a name has no '~'), and which says nothing of any kolab, so nothing need change
-- if a kolab is ever renamed. Addresses and every verb name a node by its name and kolab; the id
-- is Kolab's own.

alter table node add column name text;
update node set name = id;
alter table node alter column name set not null;

-- A node's name is unique in its kolab.
alter table node add constraint node_kolab_name_key unique (kolab_id, name);

-- The id is the name, or '~' and a ULID. Every existing node's id is its name, so this holds.
alter table node add constraint node_id_name_check check (id = name or id ~ '^~[0-9A-HJKMNP-TV-Z]{26}$');

-- No '/', '@', '#', '~' or whitespace, which the address grammar uses to find where the name ends
-- (NODE_NAME in @konjir/address). The server's verbs only ever made names of letters, digits, '_'
-- and '-', but Kolab itself took any id, so an existing name the grammar can't read stops the
-- migration, naming it, rather than leave a node no address can reach.
do $$
declare bad text;
begin
  select string_agg(format('%s (kolab %s)', id, kolab_id), ', ' order by id) into bad
    from node where name !~ '^[^/@#~[:space:]]+$';
  if bad is not null then
    raise exception 'migration 0008: these nodes have names no address can name, since a name may not contain ''/'', ''@'', ''#'', ''~'' or whitespace: %; rename them first', bad;
  end if;
end
$$;
alter table node add constraint node_name_check check (name ~ '^[^/@#~[:space:]]+$');

-- A node's id and name never change once written, for any role. Renaming a node, with its old
-- names kept as aliases (ADR11, D37), will relax this.
create function kj_node_name_fixed() returns trigger
language plpgsql as $$
begin
  if new.name is distinct from old.name or new.id is distinct from old.id then
    raise exception 'node: a node''s id and name never change once written' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger node_name_fixed before update of id, name on node for each row execute function kj_node_name_fixed();

-- ---------------------------------------------------------------------------
-- Reading another kolab (TEN12): row-level security, not only Kolab
-- ---------------------------------------------------------------------------

-- The kolabs the current session's actor may read now: each it is tied to (owning it, a member of
-- the organization that does, a grant to it or a team it is in) or, for a person, that is public,
-- where kj_access gives it at least Read. An agent reads only by grants of its own, cut down to
-- its owner's (D30). Empty for a session that has ended. Computed once per statement.
create function kj_session_readable_kolabs() returns text[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with recursive me as (
    select a.id, a.kind from public.session s join public.actor a on a.id = s.actor_id
     where s.id = current_setting('kj.session', true) and s.ended_at is null
  ), teams(id) as (
    select tm.team_id from public.team_member tm join me on tm.user_id = me.id
    union
    select t.parent_id from public.team t join teams on t.id = teams.id where t.parent_id is not null
  ), candidates(id) as (
    select g.kolab_id from public.kolab_grant g join me on g.agent_id = me.id or g.user_id = me.id
    union select g.kolab_id from public.kolab_grant g where g.team_id in (select id from teams)
    union select k.id from public.kolab k join me on me.kind = 'person' and k.owner_id = me.id
    union select k.id from public.kolab k join public.org_member m on m.org_id = k.owner_id
                                          join me on me.kind = 'person' and m.user_id = me.id
    union select k.id from public.kolab k join me on me.kind = 'person' and k.visibility = 'public'
  )
  select coalesce(array_agg(c.id order by c.id), '{}') from candidates c, me
   where (select a.rank from public.kj_access(me.id, c.id) a) >= 1
$$;
revoke execute on function kj_session_readable_kolabs() from public;
grant execute on function kj_session_readable_kolabs() to kj_agent;

-- As kj_agent, a session reads its own kolab as before, and in any other kolab it may read, the
-- nodes and their committed versions, with those versions' elements and questions: what
-- kj:<kolab>/<node> resolves and read_node shows. Never another kolab's drafts or rejected
-- versions, and none of its links, deltas, marks, case files or precedent.
drop policy kolab_read on node;
create policy kolab_read on node for select to kj_agent
  using (kolab_id = (select kj_session_kolab()) or kolab_id = any ((select kj_session_readable_kolabs())::text[]));
drop policy kolab_read on version;
create policy kolab_read on version for select to kj_agent
  using (kolab_id = (select kj_session_kolab())
         or (state = 'committed' and kolab_id = any ((select kj_session_readable_kolabs())::text[])));
drop policy kolab_read on element;
create policy kolab_read on element for select to kj_agent
  using (kolab_id = (select kj_session_kolab())
         or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
             and exists (select 1 from version v where v.id = element.version_id and v.state = 'committed')));
drop policy kolab_read on query;
create policy kolab_read on query for select to kj_agent
  using (kolab_id = (select kj_session_kolab())
         or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
             and exists (select 1 from version v where v.id = query.version_id and v.state = 'committed')));
