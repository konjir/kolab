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
