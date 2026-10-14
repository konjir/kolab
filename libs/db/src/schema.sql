-- Konjir core schema (prototype).
-- Implements the three decisions in "Konjir — Open Design Decisions":
--   1. Addressing: identity at the element; each address carries its own scope
--      (node version | element | span selector) plus a fingerprint.
--   2. Overrides: every delta records its base; three-way rule on rebase.
--   3. Roles: one active role per session (dynamic separation of duty),
--      layer writes checked by Kolab AND by row-level security.

create table actor (
  id   text primary key,
  name text not null
);

-- Dynamic separation of duty: an actor may hold both roles over time,
-- but has at most one open session, and a session has exactly one role.
create table session (
  id          text primary key,
  actor_id    text not null references actor(id),
  active_role text not null check (active_role in ('product', 'engineer')),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create unique index one_open_session_per_actor on session(actor_id) where ended_at is null;

create table node (
  id    text primary key,
  kind  text not null check (kind in
          ('functional_spec','prototype','technical_binding','wbs','work_package','implementation')),
  layer text not null check (layer in ('functional','technical')),
  title text not null
);

-- A version is a delta-defined subclass of parent_version_id. That parent is
-- either the same node's previous version (evolution over time) or another
-- node's version (a variant). Same mechanism, two directions.
create table version (
  id                text primary key,
  node_id           text not null references node(id),
  seq               int  not null,
  parent_version_id text references version(id),
  layer             text not null check (layer in ('functional','technical')),
  state             text not null check (state in ('drafted','committed','rejected')),
  actor_id          text not null,
  active_role       text not null,          -- 'product' | 'engineer' | 'system'
  review_note       text,
  created_at        timestamptz not null default now(),
  unique (node_id, seq)
);

-- An element as it appears in one version, materialized (inherited + delta).
-- element_id is the stable identity that addresses point at.
create table element (
  version_id        text not null references version(id),
  element_id        text not null,
  parent_element_id text,
  ord               int  not null,
  text              text not null,
  fingerprint       text not null,          -- hash of normalized own text
  primary key (version_id, element_id)
);

-- What a version changes relative to its parent version.
create table delta (
  id               text primary key,
  version_id       text not null references version(id),
  element_id       text not null,
  kind             text not null check (kind in ('add','override','remove')),
  text             text,
  parent_element_id text,
  ord              int,
  base_version_id  text references version(id),   -- parent version it was written against
  base_fingerprint text,                           -- parent's element content at that time
  state            text not null default 'clean' check (state in ('clean','dirty','orphaned'))
);

-- Typed edge between node versions. Source depends on target.
-- target_element_id null  => the whole target version is the scope.
-- target_selector non-null => a span inside target_element_id.
-- source_element_id says WHICH part of the source depends on the target;
-- null means the whole source. It is what keeps transitive propagation
-- element-precise instead of version-wide.
create table edge (
  id                 text primary key,
  kind               text not null check (kind in ('derivation','dependency','equivalence')),
  source_version_id  text not null references version(id),
  source_element_id  text,
  target_version_id  text not null references version(id),
  target_element_id  text,
  target_selector    jsonb,
  target_fingerprint text not null,
  check (target_selector is null or target_element_id is not null)
);

-- Dirty marks. The system's work queue.
create table invalidation (
  id                 text primary key,
  version_id         text not null references version(id),  -- the version now suspect
  element_id         text,                                  -- the part of it that's suspect (null = all)
  edge_id            text references edge(id),
  delta_id           text references delta(id),
  triggered_by       text not null references version(id),  -- the upstream commit
  reason             text not null,                         -- checked by invalidation_reason_check, from @konjir/db
  state              text not null default 'open' check (state in ('open','cleared')),
  note               text,                                  -- e.g. the review gate's explanation
  cleared_by         text,
  created_at         timestamptz not null default now()
);

-- A transitive (upstream_dirty) mark can have several direct causes from one
-- commit. It clears only when the last of them clears.
create table invalidation_cause (
  mark_id  text not null references invalidation(id),
  cause_id text not null references invalidation(id),
  primary key (mark_id, cause_id)
);

-- Questions and notes. Both land on the layer that owns the address and wait
-- for its reply; a question also blocks the element it was asked from.
create table query (
  id          text primary key,
  version_id  text not null references version(id),   -- the layer that owns the answer
  element_id  text,
  selector    jsonb,                                  -- a quoted span inside element_id
  invalidation_id text references invalidation(id),
  kind        text not null default 'question',          -- checked by query_kind_check, from @konjir/db
  question    text not null,
  raised_by   text,
  from_version_id text references version(id),        -- the asker's own element that waits on it
  from_element_id text,
  state       text not null default 'open' check (state in ('open','answered')),
  answer      text,
  answered_by text,
  created_at  timestamptz not null default now()
);

-- Dispute machinery (not exercised by this prototype beyond the schema).
create table case_file (
  id          text primary key,
  version_id  text not null references version(id),
  element_id  text,
  state       text not null default 'open' check (state in ('open','ruled'))
);
create table position (
  id           text primary key,
  case_file_id text not null references case_file(id),
  actor_id     text not null,
  claim        text not null,
  evidence     jsonb not null
);
create table ruling (
  id           text primary key,
  case_file_id text not null references case_file(id),
  actor_id     text not null,
  verdict      text not null check (verdict in ('sustained','overruled')),
  text         text not null
);

-- Precedent for stale overrides: the same (base, new parent, child) triple
-- resolved once is resolved the same way again (git rerere, i.e. stare decisis).
create table precedent (
  id                 text primary key,
  base_fingerprint   text not null,
  parent_fingerprint text not null,
  child_fingerprint  text not null,
  resolution         text not null check (resolution in ('reaffirm','adopt_parent','amend')),
  amended_text       text,
  ruled_by           text not null,
  unique (base_fingerprint, parent_fingerprint, child_fingerprint)
);

-- ---------------------------------------------------------------------------
-- Row-level security backstop.
-- Agent writes run as kj_agent. The DB looks up the layer from the session
-- row itself, so a service bug can't spoof the layer without a real session.
-- ---------------------------------------------------------------------------
create role kj_agent nologin;
create role kj_system nologin;

create function kj_session_layer() returns text
language sql stable security definer as $$
  select case s.active_role when 'product' then 'functional' when 'engineer' then 'technical' end
  from session s
  where s.id = current_setting('kj.session', true) and s.ended_at is null
$$;

grant select on all tables in schema public to kj_agent, kj_system;
grant insert on version, element, delta, edge, query to kj_agent;
grant insert, update, delete on all tables in schema public to kj_system;
grant execute on function kj_session_layer() to kj_agent;

alter table version enable row level security;
alter table element enable row level security;
alter table delta   enable row level security;
alter table edge    enable row level security;
alter table query   enable row level security;

create policy read_all on version for select using (true);
create policy read_all on element for select using (true);
create policy read_all on delta   for select using (true);
create policy read_all on edge    for select using (true);
create policy read_all on query   for select using (true);

-- An agent may only draft (never commit: the review gate does that), only in
-- its session's layer, and only on a node whose layer matches.
create policy agent_layer on version for insert to kj_agent
  with check (state = 'drafted'
              and layer = kj_session_layer()
              and layer = (select n.layer from node n where n.id = node_id));
create policy agent_layer on element for insert to kj_agent
  with check (exists (select 1 from version v where v.id = version_id
                       and v.state = 'drafted' and v.layer = kj_session_layer()));
create policy agent_layer on delta for insert to kj_agent
  with check (exists (select 1 from version v where v.id = version_id
                       and v.state = 'drafted' and v.layer = kj_session_layer()));
-- An edge belongs to its source: only that layer's role may declare a dependency.
create policy agent_layer on edge for insert to kj_agent
  with check (exists (select 1 from version v where v.id = source_version_id and v.layer = kj_session_layer()));
create policy agent_layer on query for insert to kj_agent
  with check (exists (select 1 from version v where v.id = version_id and v.layer = kj_session_layer()));

-- Kolab's own system work (rebases, review transitions, cascade) is trusted.
create policy system_all on version for all to kj_system using (true) with check (true);
create policy system_all on element for all to kj_system using (true) with check (true);
create policy system_all on delta   for all to kj_system using (true) with check (true);
create policy system_all on edge    for all to kj_system using (true) with check (true);
create policy system_all on query   for all to kj_system using (true) with check (true);
