-- Migration 0002: agents are actors of their own, each owned by a person (W1.14; D30, DAT10, ENF4, ENF5).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- An actor is a person or an agent. An agent belongs to the person who owns it, holds its own
-- sessions (one open at a time, by one_open_session_per_actor, so two agents of one person can
-- each hold one at once) and is the author of what it writes. Agents owned by an organization
-- come with accounts and organizations (W1.3).
--
-- Every actor that exists already is a person, with no owner: the defaults say so. Adding the
-- stored owner_kind column rewrites the actor table, which holds one row per collaborator.

alter table actor
  add column kind text not null default 'person'
    constraint actor_kind_check check (kind in ('person', 'agent')),   -- ACTOR_KINDS in @konjir/types
  add column owner_id text,
  add constraint actor_owner_check check ((kind = 'agent') = (owner_id is not null));

-- The owner must be a person, never another agent. The pair (owner_id, owner_kind) points at
-- the owner's (id, kind), and owner_kind can only be 'person'. Because the pair is referenced,
-- a person who owns agents can't later be turned into an agent either.
alter table actor add constraint actor_id_kind_key unique (id, kind);
alter table actor
  add column owner_kind text generated always as (case when owner_id is not null then 'person' end) stored,
  add constraint actor_owner_is_person foreign key (owner_id, owner_kind) references actor(id, kind);

-- Finding a person's agents (the review gate counts another agent of the same person as a reviewer, D25/D33).
create index actor_owner on actor(owner_id) where owner_id is not null;

-- An actor's id is a short name: letters, digits, '.', '_', '-' and '@', starting with a letter
-- or digit. 'kolab' is the author of Kolab's own work (role 'system') and is never an actor.
-- not valid: the check binds new actors only, so an older id can never stop this migration.
alter table actor add constraint actor_id_check
  check (id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]*$' and id <> 'kolab') not valid;

-- An actor's kind and owner never change, so every version keeps the author and owner it was
-- written by, and an agent is always judged against the same owner (D30, D33).
create function kj_actor_frozen() returns trigger
language plpgsql as $$
begin
  if new.kind is distinct from old.kind or new.owner_id is distinct from old.owner_id then
    raise exception 'actor %: kind and owner never change once added', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger actor_frozen before update of kind, owner_id on actor
  for each row execute function kj_actor_frozen();

-- ---------------------------------------------------------------------------
-- Row-level security binds authorship to the session (ENF2, ENF5, ROL4).
-- An agent's session may write only as its own actor, in its own role: never as its owner,
-- another agent or anyone else. Only its own drafts take elements and deltas.
-- ---------------------------------------------------------------------------
create function kj_session_actor() returns text
language sql stable security definer as $$
  select s.actor_id from session s
  where s.id = current_setting('kj.session', true) and s.ended_at is null
$$;
create function kj_session_role() returns text
language sql stable security definer as $$
  select s.active_role from session s
  where s.id = current_setting('kj.session', true) and s.ended_at is null
$$;
grant execute on function kj_session_actor(), kj_session_role() to kj_agent;

drop policy agent_layer on version;
create policy agent_layer on version for insert to kj_agent
  with check (state = 'drafted'
              and layer = kj_session_layer()
              and layer = (select n.layer from node n where n.id = node_id)
              and actor_id = kj_session_actor()
              and active_role = kj_session_role());
drop policy agent_layer on element;
create policy agent_layer on element for insert to kj_agent
  with check (exists (select 1 from version v where v.id = version_id
                       and v.state = 'drafted' and v.layer = kj_session_layer()
                       and v.actor_id = kj_session_actor()));
drop policy agent_layer on delta;
create policy agent_layer on delta for insert to kj_agent
  with check (exists (select 1 from version v where v.id = version_id
                       and v.state = 'drafted' and v.layer = kj_session_layer()
                       and v.actor_id = kj_session_actor()));
drop policy agent_layer on query;
create policy agent_layer on query for insert to kj_agent
  with check (exists (select 1 from version v where v.id = version_id and v.layer = kj_session_layer())
              and raised_by = kj_session_actor()
              and answered_by is null);
