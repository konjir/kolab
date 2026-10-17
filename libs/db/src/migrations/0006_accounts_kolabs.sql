-- Migration 0006: accounts, kolabs, teams and grants, and every row keyed by its kolab
-- (W1.3; DAT10, TEN1–TEN12, D3, D7, D12, D30, D37).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- An account is a user or an organization, in one namespace. A person actor is a user: the
-- same id. An agent belongs to an account, a user or an organization, and holds no more access
-- than its owner (D30). A kolab belongs to one account, and its name is its primary key, so it
-- is unique across the whole database (D7, D12). Access to a kolab comes from owning it, owning
-- the organization that owns it, the organization's base permission, a grant to the person, a
-- grant to a team the person is in (or to a parent of one), or the kolab being public (TEN6–TEN10).
-- An agent's access is its own grant, cut down to its owner's: computed, never stored, so it
-- narrows the moment its owner's does.
--
-- A session works in one kolab. Row-level security limits kj_agent to the rows of its session's
-- kolab, and only while the session's actor can still reach it, and lets it write a layer only
-- while its access covers that layer.
--
-- Existing data is one implicit kolab: Konjir's own (the mirror's spec, binding and plan,
-- D32). If the database holds any actor or node, it becomes the kolab `kolab`, owned by the
-- organization `konjir`. Each existing person becomes a user and a member of that organization,
-- and each existing person and agent gets Write on both layers of `kolab`, which is what any
-- actor could do before. Open sessions work in `kolab`. A fresh database gets none of this.

-- ---------------------------------------------------------------------------
-- Accounts, organizations and teams
-- ---------------------------------------------------------------------------

create table account (
  id   text primary key,
  kind text not null constraint account_kind_check check (kind in ('user', 'organization')),   -- ACCOUNT_KINDS in @konjir/types
  name text not null,
  unique (id, kind)
);

create table org_member (
  org_id    text not null,
  org_kind  text not null generated always as ('organization') stored,
  user_id   text not null,
  user_kind text not null generated always as ('user') stored,
  role      text not null default 'member'
              constraint org_member_role_check check (role in ('member', 'owner')),   -- ORG_ROLES in @konjir/types
  primary key (org_id, user_id),
  foreign key (org_id, org_kind) references account(id, kind),
  foreign key (user_id, user_kind) references account(id, kind)
);
create index org_member_user on org_member(user_id);

-- A team belongs to one organization and holds no konstructs (TEN9). Its id is '<org>/<name>'.
-- A team may sit under a parent of the same organization; its members inherit the parent's
-- access. The parent is set when the team is made and never changes, so teams can't loop.
create table team (
  id        text primary key,
  org_id    text not null,
  org_kind  text not null generated always as ('organization') stored,
  name      text not null constraint team_name_check check (name ~ '^[a-z0-9][a-z0-9-]*$'),
  parent_id text,
  unique (id, org_id),
  check (id = org_id || '/' || name),
  foreign key (org_id, org_kind) references account(id, kind),
  foreign key (parent_id, org_id) references team(id, org_id)
);

create table team_member (
  team_id   text not null references team(id),
  user_id   text not null,
  user_kind text not null generated always as ('user') stored,
  primary key (team_id, user_id),
  foreign key (user_id, user_kind) references account(id, kind)
);
create index team_member_user on team_member(user_id);

-- ---------------------------------------------------------------------------
-- Kolabs and grants
-- ---------------------------------------------------------------------------

-- The id is the kolab's short name, its addresses' kolab segment (D8): unique across all of
-- Konjir (TEN4), lowercase so that two names never differ by case alone.
create table kolab (
  id              text primary key
                    constraint kolab_name_check check (id ~ '^[a-z0-9][a-z0-9-]*$' and length(id) <= 100),
  owner_id        text not null references account(id),
  title           text not null,
  visibility      text not null default 'private'
                    constraint kolab_visibility_check check (visibility in ('public', 'private', 'internal')),   -- VISIBILITIES in @konjir/types
  base_permission text
                    constraint kolab_base_permission_check check (base_permission in ('read', 'triage', 'write', 'maintain', 'admin')),
  created_at      timestamptz not null default now()
);
create index kolab_owner on kolab(owner_id);

-- One grant per kolab and grantee: a person (by their user account), a team or an agent (TEN9).
-- A Write grant names its layers (TEN8); Read and Triage write none; Maintain and Admin both.
create table kolab_grant (
  kolab_id   text not null references kolab(id),
  user_id    text,
  user_kind  text generated always as (case when user_id is not null then 'user' end) stored,
  team_id    text references team(id),
  agent_id   text,
  agent_kind text generated always as (case when agent_id is not null then 'agent' end) stored,
  level      text not null
               constraint kolab_grant_level_check check (level in ('read', 'triage', 'write', 'maintain', 'admin')),   -- ACCESS_LEVELS in @konjir/types
  functional boolean not null,
  technical  boolean not null,
  foreign key (user_id, user_kind) references account(id, kind),
  foreign key (agent_id, agent_kind) references actor(id, kind),
  constraint kolab_grant_one_grantee check (num_nonnulls(user_id, team_id, agent_id) = 1),
  constraint kolab_grant_layers check (case
    when level in ('read', 'triage') then not functional and not technical
    when level = 'write' then functional or technical
    else functional and technical end)
);
create unique index kolab_grant_user  on kolab_grant(kolab_id, user_id)  where user_id is not null;
create unique index kolab_grant_team  on kolab_grant(kolab_id, team_id)  where team_id is not null;
create unique index kolab_grant_agent on kolab_grant(kolab_id, agent_id) where agent_id is not null;
create index kolab_grant_agent_id on kolab_grant(agent_id) where agent_id is not null;

-- ---------------------------------------------------------------------------
-- Actors: a person is a user; an agent's owner is an account (D30, D37)
-- ---------------------------------------------------------------------------

insert into account(id, kind, name) select id, 'user', name from actor where kind = 'person';

-- Until now an agent's owner had to be a person actor. Now it is any account: a user (a person)
-- or an organization. The ids are the same, so every agent keeps its owner.
alter table actor drop constraint actor_owner_is_person;
alter table actor drop column owner_kind;
alter table actor
  add constraint actor_owner_is_account foreign key (owner_id) references account(id),
  add column account_kind text generated always as (case when kind = 'person' then 'user' end) stored,
  add constraint actor_person_is_user foreign key (id, account_kind) references account(id, kind);

-- An account id is an actor id's shape (actor_id_check). not valid: the check binds new accounts
-- only, so an older person's id, made before 0002's check, can never stop this migration.
alter table account add constraint account_id_check
  check (id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]*$' and id <> 'kolab') not valid;

-- ---------------------------------------------------------------------------
-- The implicit kolab of existing data
-- ---------------------------------------------------------------------------

insert into account(id, kind, name)
  select 'konjir', 'organization', 'Konjir'
   where exists (select 1 from actor) or exists (select 1 from node)
  on conflict (id) do nothing;
insert into kolab(id, owner_id, title)
  select 'kolab', 'konjir', 'Kolab'
   where exists (select 1 from actor) or exists (select 1 from node);
insert into org_member(org_id, user_id)
  select o.id, u.id from account o, account u
   where o.id = 'konjir' and o.kind = 'organization' and u.kind = 'user';
insert into kolab_grant(kolab_id, user_id, level, functional, technical)
  select 'kolab', a.id, 'write', true, true from actor a where a.kind = 'person' and exists (select 1 from kolab where id = 'kolab');
insert into kolab_grant(kolab_id, agent_id, level, functional, technical)
  select 'kolab', a.id, 'write', true, true from actor a where a.kind = 'agent' and exists (select 1 from kolab where id = 'kolab');

-- ---------------------------------------------------------------------------
-- Every row of Konjir data carries its kolab
-- ---------------------------------------------------------------------------

-- A session works in one kolab. Each actor still holds at most one open session (ENF4).
alter table session add column kolab_id text references kolab(id);
update session set kolab_id = 'kolab';
alter table session alter column kolab_id set not null;

alter table node add column kolab_id text references kolab(id);
update node set kolab_id = 'kolab';
alter table node alter column kolab_id set not null;
create index node_kolab on node(kolab_id);

alter table version            add column kolab_id text references kolab(id);
alter table element            add column kolab_id text references kolab(id);
alter table delta              add column kolab_id text references kolab(id);
alter table edge               add column kolab_id text references kolab(id);
alter table invalidation       add column kolab_id text references kolab(id);
alter table invalidation_cause add column kolab_id text references kolab(id);
alter table query              add column kolab_id text references kolab(id);
alter table case_file          add column kolab_id text references kolab(id);
alter table position           add column kolab_id text references kolab(id);
alter table ruling             add column kolab_id text references kolab(id);
alter table precedent          add column kolab_id text references kolab(id);
-- All of it is in the one kolab there was: every ruling's case file or version is in it too.
update version            set kolab_id = 'kolab';
update element            set kolab_id = 'kolab';
update delta              set kolab_id = 'kolab';
update edge               set kolab_id = 'kolab';
update invalidation       set kolab_id = 'kolab';
update invalidation_cause set kolab_id = 'kolab';
update query              set kolab_id = 'kolab';
update case_file          set kolab_id = 'kolab';
update position           set kolab_id = 'kolab';
update ruling             set kolab_id = 'kolab';
update precedent          set kolab_id = 'kolab';
alter table version            alter column kolab_id set not null;
alter table element            alter column kolab_id set not null;
alter table delta              alter column kolab_id set not null;
alter table edge               alter column kolab_id set not null;
alter table invalidation       alter column kolab_id set not null;
alter table invalidation_cause alter column kolab_id set not null;
alter table query              alter column kolab_id set not null;
alter table case_file          alter column kolab_id set not null;
alter table position           alter column kolab_id set not null;
alter table ruling             alter column kolab_id set not null;
alter table precedent          alter column kolab_id set not null;

-- A row's kolab is its parent's, set on insert whatever the writer gave, so no row can claim a
-- kolab its parent isn't in. A node's kolab is the session's (Kolab sets it), and a precedent's
-- the version it was ruled on. An edge belongs to its source, and a ruling to its case file or,
-- given directly, the version it rules on.
create function kj_kolab_of_parent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'version' then
    new.kolab_id := (select n.kolab_id from node n where n.id = new.node_id);
  elsif tg_table_name in ('element', 'delta', 'invalidation', 'query', 'case_file') then
    new.kolab_id := (select v.kolab_id from version v where v.id = new.version_id);
  elsif tg_table_name = 'edge' then
    new.kolab_id := (select v.kolab_id from version v where v.id = new.source_version_id);
  elsif tg_table_name = 'invalidation_cause' then
    new.kolab_id := (select i.kolab_id from invalidation i where i.id = new.mark_id);
  elsif tg_table_name = 'position' then
    new.kolab_id := (select c.kolab_id from case_file c where c.id = new.case_file_id);
  elsif tg_table_name = 'ruling' then
    -- A ruling rules on a case file, or, given directly (D16), on a version (ruling_subject_check).
    new.kolab_id := coalesce((select c.kolab_id from case_file c where c.id = new.case_file_id),
                             (select v.kolab_id from version v where v.id = new.version_id));
  end if;
  return new;
end
$$;
create trigger kolab_of_parent before insert on version            for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on element            for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on delta              for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on edge               for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on invalidation       for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on invalidation_cause for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on query              for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on case_file          for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on position           for each row execute function kj_kolab_of_parent();
create trigger kolab_of_parent before insert on ruling             for each row execute function kj_kolab_of_parent();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- 0 none, 1 read, 2 triage, 3 write, 4 maintain, 5 admin.
create function kj_level_rank(level text) returns int
language sql immutable as $$
  select case level when 'read' then 1 when 'triage' then 2 when 'write' then 3
                    when 'maintain' then 4 when 'admin' then 5 else 0 end
$$;

-- A person's access to a kolab: the highest level any source gives, and every layer any of
-- them may write.
create function kj_person_access(p_user text, p_kolab text,
  out rank int, out functional boolean, out technical boolean)
language sql stable security definer set search_path = public as $$
  with recursive teams(id) as (
    select tm.team_id from team_member tm where tm.user_id = p_user
    union
    select t.parent_id from team t join teams on t.id = teams.id where t.parent_id is not null
  ), k as (
    select k.owner_id, k.visibility, k.base_permission, m.role as member_role
      from kolab k left join org_member m on m.org_id = k.owner_id and m.user_id = p_user
     where k.id = p_kolab
  ), src(rank, functional, technical) as (
    select 5, true, true from k where k.owner_id = p_user or k.member_role = 'owner'
    union all
    select kj_level_rank(k.base_permission), kj_level_rank(k.base_permission) >= 3, kj_level_rank(k.base_permission) >= 3
      from k where k.member_role is not null and k.base_permission is not null
    union all
    select 1, false, false from k where k.visibility = 'public' or (k.visibility = 'internal' and k.member_role is not null)
    union all
    select kj_level_rank(g.level), g.functional, g.technical
      from kolab_grant g
     where g.kolab_id = p_kolab and (g.user_id = p_user or g.team_id in (select id from teams))
  )
  select coalesce(max(src.rank), 0), coalesce(bool_or(src.functional), false), coalesce(bool_or(src.technical), false) from src
$$;

-- An actor's access to a kolab. A person's is their own. An agent's is its own grant, never more
-- than its owner's (TEN11, D30): the lower level, and only the layers both may write. An
-- organization holds all of its own kolabs and nothing of anyone else's.
create function kj_access(p_actor text, p_kolab text,
  out rank int, out functional boolean, out technical boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  a_kind text; a_owner text; o_kind text;
  o_rank int; o_functional boolean; o_technical boolean;
begin
  rank := 0; functional := false; technical := false;
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

-- The kolab the current session works in, while its actor can still reach it; otherwise null.
create function kj_session_kolab() returns text
language sql stable security definer set search_path = public as $$
  select s.kolab_id from session s
   where s.id = current_setting('kj.session', true) and s.ended_at is null
     and (select a.rank from kj_access(s.actor_id, s.kolab_id) a) >= 1
$$;

-- The layer the current session may write now: its role's layer, while its actor's access in
-- its kolab covers that layer. Null otherwise, which every agent_layer policy then refuses.
create or replace function kj_session_layer() returns text
language sql stable security definer set search_path = public as $$
  select l.layer
    from session s
   cross join lateral (select case s.active_role when 'product' then 'functional' when 'engineer' then 'technical' end as layer) l
   cross join lateral kj_access(s.actor_id, s.kolab_id) a
   where s.id = current_setting('kj.session', true) and s.ended_at is null
     and a.rank >= 3
     and case l.layer when 'functional' then a.functional else a.technical end
$$;

grant execute on function kj_session_kolab() to kj_agent;

-- ---------------------------------------------------------------------------
-- Row-level security: an agent reads and writes only its session's kolab (TEN12, DAT10)
-- ---------------------------------------------------------------------------

alter table node               enable row level security;
alter table invalidation       enable row level security;
alter table invalidation_cause enable row level security;
alter table case_file          enable row level security;
alter table position           enable row level security;
alter table ruling             enable row level security;
alter table precedent          enable row level security;

drop policy read_all on version;
drop policy read_all on element;
drop policy read_all on delta;
drop policy read_all on edge;
drop policy read_all on query;

create policy kolab_read on node               for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on version            for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on element            for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on delta              for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on edge               for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on invalidation       for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on invalidation_cause for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on query              for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on case_file          for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on position           for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on ruling             for select to kj_agent using (kolab_id = kj_session_kolab());
create policy kolab_read on precedent          for select to kj_agent using (kolab_id = kj_session_kolab());

-- An agent's inserts must land in its session's kolab too. Each agent_layer policy already
-- looks its node or version up, which the reads above now limit to the session's kolab; this
-- says so outright. Restrictive, so it holds on top of agent_layer rather than instead of it.
create policy kolab_write on version as restrictive for insert to kj_agent with check (kolab_id = kj_session_kolab());
create policy kolab_write on element as restrictive for insert to kj_agent with check (kolab_id = kj_session_kolab());
create policy kolab_write on delta   as restrictive for insert to kj_agent with check (kolab_id = kj_session_kolab());
create policy kolab_write on edge    as restrictive for insert to kj_agent with check (kolab_id = kj_session_kolab());
create policy kolab_write on query   as restrictive for insert to kj_agent with check (kolab_id = kj_session_kolab());

create policy system_all on node               for all to kj_system using (true) with check (true);
create policy system_all on invalidation       for all to kj_system using (true) with check (true);
create policy system_all on invalidation_cause for all to kj_system using (true) with check (true);
create policy system_all on case_file          for all to kj_system using (true) with check (true);
create policy system_all on position           for all to kj_system using (true) with check (true);
create policy system_all on ruling             for all to kj_system using (true) with check (true);
create policy system_all on precedent          for all to kj_system using (true) with check (true);
