-- Migration 0014: archiving kolabs, organizations and actors (D52; DAT10, TEN2, TEN4, TEN11).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- An admin can archive a kolab, an organization or an actor (D52). An archived one disappears from
-- listings and can't be used, its data is kept for audit, and its name stays reserved: nothing is
-- ever deleted, so its row keeps holding its primary key, and a new kolab, account or actor of
-- that name is refused. Unarchiving puts it back as it was.
--
-- Where it is stored:
--   kolab.archived_at    a kolab
--   account.archived_at  an organization, or a person (whose user account has the person's id)
--   actor.archived_at    an agent; a person's lives on their account, so there is one place for it
--
-- What follows from it, computed, never stored, so unarchiving restores exactly what was there:
--   a kolab is archived if it is, or the account that owns it is: archiving an organization (or a
--     person) archives its kolabs, and every grant, membership and team grant stops counting there
--   an actor is archived if it is, or, for an agent, its owner is (D30: an agent never holds more
--     than its owner): archiving a person or an organization archives their agents
--
-- kj_access gives an archived actor, and anyone in an archived kolab, no access at all. So
-- row-level security, which asks kj_access through kj_session_kolab, kj_session_layer and
-- kj_session_readable_kolabs, gives kj_agent nothing there, and the engine ends every open session
-- that can no longer reach its kolab in the same transaction as the archive, telling its streams
-- (D41). Beyond kj_access, no role may write an archived kolab's data at all, nor open a session
-- in one or as an archived actor: Kolab's own login and kj_system included, so a bug or a direct
-- database path can't either. Reads by Kolab's own login, for the admin token, still work: the
-- data is kept for audit.

alter table kolab   add column archived_at timestamptz;
alter table account add column archived_at timestamptz;
alter table actor   add column archived_at timestamptz;
alter table actor   add constraint actor_archived_is_agent check (archived_at is null or kind = 'agent');

-- Whether a kolab is archived, by itself or through the account that owns it.
create function kj_kolab_archived(p_kolab text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.kolab k join public.account o on o.id = k.owner_id
                  where k.id = p_kolab and (k.archived_at is not null or o.archived_at is not null))
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

-- No role writes an archived kolab's data: no insert, update or delete of its rows. Named to fire
-- after kolab_of_parent (triggers fire in name order), so a new row's kolab is already its parent's.
create function kj_kolab_writable() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
  k := case when tg_op = 'DELETE' then old.kolab_id else new.kolab_id end;
  if kj_kolab_archived(k) then
    raise exception 'kolab % is archived: its data is kept, and nothing in it can change until an admin unarchives it', k
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke execute on function kj_kolab_writable() from public;
create trigger kolab_writable before insert or update or delete on node               for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on version            for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on element            for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on delta              for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on edge               for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on invalidation       for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on invalidation_cause for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on query              for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on case_file          for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on position           for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on ruling             for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on precedent          for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on review_request     for each row execute function kj_kolab_writable();
create trigger kolab_writable before insert or update or delete on link_removal       for each row execute function kj_kolab_writable();
-- A new grant on an archived kolab gives nothing, and is refused; removing one is allowed. The
-- outbox isn't here: its jobs for an archived kolab wait, unclaimed, until it is unarchived.
create trigger kolab_writable before insert or update on kolab_grant for each row execute function kj_kolab_writable();

-- No session opens in an archived kolab, or for an archived actor. Ending one is always allowed.
create function kj_session_openable() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
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
create trigger session_openable before insert on session for each row execute function kj_session_openable();
