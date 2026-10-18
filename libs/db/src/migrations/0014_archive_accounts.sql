-- Migration 0014: archiving kolabs, organizations and actors (D52; DAT10, TEN2, TEN4, TEN11).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- An admin can archive a kolab, an organization or an actor (D52). An archived one disappears from
-- listings and can't be used, its data is kept for audit, and its name stays reserved: nothing is
-- ever deleted, so its row keeps holding its primary key, and a new kolab, account or actor of
-- that name, in any case, is refused. Unarchiving puts it back as it was.
--
-- Where it is stored:
--   kolab.archived_at    a kolab
--   account.archived_at  an organization, or a person (whose user account has the person's id)
--   actor.archived_at    an agent; a person's lives on their account, so there is one place for it
--   archive_event        every archive and unarchive, who did it and when: append-only
--
-- What follows from it, computed, never stored, so unarchiving restores exactly what was there:
--   a kolab is archived if it is, or the organization that owns it is: archiving an organization
--     archives its kolabs, and every grant, membership and team grant stops counting there. A
--     person's own kolabs stay live for the others who work in them (D52 names only an
--     organization's kolabs); the archived person holds nothing in them.
--   an actor is archived if it is, or, for an agent, its owner is (D30: an agent never holds more
--     than its owner): archiving a person or an organization archives their agents
--
-- kj_access gives an archived actor, and anyone in an archived kolab, no access at all. So
-- row-level security, which asks kj_access through kj_session_kolab, kj_session_layer and
-- kj_session_readable_kolabs, gives kj_agent nothing there, and the engine ends every open session
-- that can no longer reach its kolab in the same transaction as the archive, telling its streams
-- (D41). Beyond kj_access, no role may write an archived kolab's data at all, nor open (or reopen)
-- a session in one or as an archived actor: Kolab's own login and kj_system included, so a bug or
-- a direct database path can't either. The one exception is the migration runner, whose
-- transaction sets kj.migrating, so a later migration's backfill can still reach archived rows.
-- Reads by Kolab's own login, for the admin token, still work: the data is kept for audit.

alter table kolab   add column archived_at timestamptz;
alter table account add column archived_at timestamptz;
alter table actor   add column archived_at timestamptz;
alter table actor   add constraint actor_archived_is_agent check (archived_at is null or kind = 'agent');

-- Every archive and unarchive, for audit: what, which way, by whom and when. Rows are only ever
-- added (archive_event_fixed). Kolab writes them on its own login; no agent reads them.
create table archive_event (
  id          bigint generated always as identity primary key,
  target_kind text not null
                constraint archive_event_kind_check check (target_kind in ('kolab', 'organization', 'actor')),   -- ARCHIVABLE in @konjir/types
  target_id   text not null,
  archived    boolean not null,   -- true for an archive, false for an unarchive
  done_by     text not null,      -- who asked: 'admin' for the admin token
  done_at     timestamptz not null default clock_timestamp()
);
create index archive_event_target on archive_event(target_kind, target_id);
alter table archive_event enable row level security;
create function kj_archive_event_fixed() returns trigger
language plpgsql as $$
begin
  raise exception 'archive_event: the archive log is only ever added to' using errcode = 'check_violation';
end
$$;
create trigger archive_event_fixed before update or delete on archive_event for each row execute function kj_archive_event_fixed();
create trigger archive_event_kept before truncate on archive_event for each statement execute function kj_archive_event_fixed();

-- A name differs from every other in more than case, across people, agents and organizations
-- (one namespace) and kolabs (lowercase already). Two that differ only in case stop the migration,
-- naming them, rather than leave a lookalike next to an archived name.
do $$
declare bad text;
begin
  select string_agg(n, ', ' order by n) into bad from (
    select lower(id) as n from (select id from account union select id from actor) ids
     group by lower(id) having count(*) > 1) d;
  if bad is not null then
    raise exception 'migration 0014: these account or actor names differ only in case: %; rename one of each first', bad;
  end if;
end
$$;
create unique index account_id_lower on account(lower(id));
create unique index actor_id_lower on actor(lower(id));

-- Whether a kolab is archived, by itself or through the organization that owns it.
create function kj_kolab_archived(p_kolab text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.kolab k join public.account o on o.id = k.owner_id
                  where k.id = p_kolab
                    and (k.archived_at is not null or (o.kind = 'organization' and o.archived_at is not null)))
$$;

-- Whether an actor is archived: an agent by itself or through its owner, a person through their account.
create function kj_actor_archived(p_actor text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.actor a join public.account o on o.id = coalesce(a.owner_id, a.id)
                  where a.id = p_actor and (a.archived_at is not null or o.archived_at is not null))
$$;
revoke execute on function kj_kolab_archived(text), kj_actor_archived(text) from public;

-- 0006's kj_access, unchanged but for its first test: an archived actor holds nothing anywhere,
-- and nobody holds anything in an archived kolab. create or replace keeps its owner and grants.
create or replace function kj_access(p_actor text, p_kolab text,
  out rank int, out functional boolean, out technical boolean)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  a_kind text; a_owner text; o_kind text;
  o_rank int; o_functional boolean; o_technical boolean;
begin
  rank := 0; functional := false; technical := false;
  if kj_actor_archived(p_actor) or kj_kolab_archived(p_kolab) then return; end if;
  select a.kind, a.owner_id into a_kind, a_owner from actor a where a.id = p_actor;
  if a_kind is null then return; end if;
  if a_kind = 'person' then
    select p.rank, p.functional, p.technical into rank, functional, technical from kj_person_access(p_actor, p_kolab) p;
    return;
  end if;
  select kj_level_rank(g.level), g.functional, g.technical into rank, functional, technical
    from kolab_grant g where g.kolab_id = p_kolab and g.agent_id = p_actor;
  if not found then
    rank := 0; functional := false; technical := false;
    return;
  end if;
  select o.kind into o_kind from account o where o.id = a_owner;
  if o_kind = 'user' then
    select p.rank, p.functional, p.technical into o_rank, o_functional, o_technical from kj_person_access(a_owner, p_kolab) p;
  else
    o_rank := coalesce((select 5 from kolab k where k.id = p_kolab and k.owner_id = a_owner), 0);
    o_functional := o_rank >= 3;
    o_technical := o_rank >= 3;
  end if;
  rank := least(rank, o_rank);
  functional := rank >= 3 and functional and o_functional;
  technical := rank >= 3 and technical and o_technical;
end
$$;

-- Whether this transaction is the migration runner's: it sets kj.migrating on its own login, and
-- no other path of Kolab's sets it. A session acting as kj_agent or kj_system never counts, even
-- if something set the flag, since the role it set is still in force (current_setting('role')).
create function kj_migrating() returns boolean
language sql stable as $$
  select coalesce(current_setting('kj.migrating', true), '') = 'on' and current_setting('role') = 'none'
$$;

-- No role writes an archived kolab's data: no insert, update or delete of its rows. One check per
-- statement, over the distinct kolabs of the rows it touched (the transition table kj_rows), not
-- one per row. The migration runner alone may (kj_migrating).
create function kj_kolab_writable() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
  if kj_migrating() then return null; end if;
  select d.kolab_id into k from (select distinct kolab_id from kj_rows) d where kj_kolab_archived(d.kolab_id) limit 1;
  if k is not null then
    raise exception 'kolab % is archived: its data is kept, and nothing in it can change until an admin unarchives it', k
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_kolab_writable() from public;
do $$
declare t text;
begin
  -- Every table of kolab data (each with a kolab_id) but the session (session_openable, below) and
  -- the outbox, whose jobs for an archived kolab wait, unclaimed, until it is unarchived. A grant on
  -- an archived kolab can't be made or changed; removing one is allowed.
  foreach t in array array['node', 'version', 'element', 'delta', 'edge', 'invalidation', 'invalidation_cause',
                           'query', 'case_file', 'position', 'ruling', 'precedent', 'review_request', 'link_removal',
                           'kolab_grant'] loop
    execute format('create trigger kolab_writable_insert after insert on %I referencing new table as kj_rows
                      for each statement execute function kj_kolab_writable()', t);
    execute format('create trigger kolab_writable_update after update on %I referencing new table as kj_rows
                      for each statement execute function kj_kolab_writable()', t);
    if t <> 'kolab_grant' then
      execute format('create trigger kolab_writable_delete after delete on %I referencing old table as kj_rows
                        for each statement execute function kj_kolab_writable()', t);
    end if;
  end loop;
end
$$;

-- No session opens in an archived kolab, or for an archived actor, and none ended reopens there.
-- Ending one is always allowed.
create function kj_session_openable() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.ended_at is not null or kj_migrating() then return new; end if;
  if kj_kolab_archived(new.kolab_id) then
    raise exception 'kolab % is archived: no session opens in it', new.kolab_id using errcode = 'check_violation';
  end if;
  if kj_actor_archived(new.actor_id) then
    raise exception 'actor % is archived: it opens no session', new.actor_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_session_openable() from public;
create trigger session_openable before insert or update of ended_at, kolab_id, actor_id on session
  for each row execute function kj_session_openable();
