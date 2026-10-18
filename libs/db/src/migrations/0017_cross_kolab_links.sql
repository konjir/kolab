-- Migration 0017: links and forks across kolabs, and the access_lost mark (W2.16; LNK8, KON9,
-- DAT10, DAT11, D3, D49, D50, D53).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Until now no row could reference another kolab's row, for any role (0006's composite keys). A
-- link into another kolab (LNK8) and a variant of another kolab's spec, a fork (KON9), need four of
-- those references to cross: an edge's target, a version's parent, an override's base (the parent
-- version it was written against) and a mark's trigger (the commit upstream that raised it). Each
-- keeps the plain key 0001 gave it, to version(id), and in place of the composite key:
--
--   - It may name another kolab's version only if that version is committed (kj_kolab_ref_check,
--     below, for every role): another kolab's drafts, versions in review and rejected versions are
--     as if they weren't there (D49), so nothing may rely on one.
--   - A link or a fork across kolabs has a holder: the actor whose Read on the other kolab it rests
--     on (edge.held_by, version.parent_held_by). At link time, and as a fork's version is drafted,
--     the holder is the session's own actor, who must hold Read there now. Row-level security says
--     so for kj_agent (edge_target, version_parent); Kolab checks it first. A rebase or a version
--     drafted by someone who can't read the parent carries the holder it was built on.
--   - Kolab marks the dependent `access_lost` when the holder no longer vouches for it (LNK8, D53):
--     Read on the other kolab, and Write on the dependent's layer in its own, so someone who has
--     left the dependent's kolab is no channel into it. It does so in the transaction that changes
--     the holder's access, and whenever the cascade meets the link. The mark settles
--     when the holder reads again, when someone who reads takes the link over, or when the link
--     goes. While it is open, nothing of the other kolab's later commits reaches the link: no
--     marks, no rebases.
--
-- An edge records its target's kolab (edge.target_kolab_id), set from the target, never changed:
-- an edge is re-pinned only to another version of the node it names. Every other reference stays
-- inside its kolab as 0006 made it: elements, deltas and marks to their own version, a mark's edge
-- and delta, a mark's causes (so transitive marks never cross a kolab: a mark spreads only within
-- its own kolab), questions, case files, positions, rulings, review requests and outbox jobs.
-- Questions across kolabs are still refused by Kolab.

-- ---------------------------------------------------------------------------
-- The references that may cross, and who holds them
-- ---------------------------------------------------------------------------

alter table edge
  add column target_kolab_id text references kolab(id),
  add column held_by text references actor(id);
-- Every edge so far is inside one kolab (edge_target_kolab_fkey): its target's kolab is its own.
update edge set target_kolab_id = kolab_id;
alter table edge alter column target_kolab_id set not null;
alter table edge drop constraint edge_target_kolab_fkey;
alter table edge add constraint edge_target_kolab_fkey foreign key (target_version_id, target_kolab_id) references version(id, kolab_id);
create index edge_cross_kolab on edge(target_kolab_id, held_by) where target_kolab_id <> kolab_id;

alter table version add column parent_held_by text references actor(id);
alter table version drop constraint version_parent_kolab_fkey;
create index version_forks on version(node_id) where parent_held_by is not null;

alter table delta drop constraint delta_base_kolab_fkey;
alter table invalidation drop constraint invalidation_triggered_kolab_fkey;

-- An edge's target kolab is its target version's, set on insert whatever the writer gave.
create function kj_edge_target_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  new.target_kolab_id := (select v.kolab_id from public.version v where v.id = new.target_version_id);
  return new;
end
$$;
revoke execute on function kj_edge_target_kolab() from public;
create trigger kolab_of_target before insert on edge for each row execute function kj_edge_target_kolab();

-- The rules for each reference that may cross, checked after the row is written, for every role:
-- after row-level security, so an agent refused there learns nothing more of another kolab. A
-- reference into another kolab names a committed version; a link or fork across kolabs names its
-- holder, and a version on a parent of its own kolab names none; an edge's target kolab never
-- changes, and a re-pin names another version of the same node.
create function kj_kolab_ref_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  ref text; ref_kolab text; ref_state text; ref_node text; old_node text;
begin
  if tg_table_name = 'edge' then
    ref := new.target_version_id;
  elsif tg_table_name = 'version' then
    ref := new.parent_version_id;
  elsif tg_table_name = 'delta' then
    ref := new.base_version_id;
  elsif tg_table_name = 'invalidation' then
    ref := new.triggered_by;
  end if;
  select v.kolab_id, v.state, v.node_id into ref_kolab, ref_state, ref_node from public.version v where v.id = ref;
  if tg_table_name = 'edge' then
    if tg_op = 'UPDATE' then
      select v.node_id into old_node from public.version v where v.id = old.target_version_id;
      if new.target_kolab_id is distinct from old.target_kolab_id or ref_node is distinct from old_node then
        raise exception 'edge: a link is re-pinned only to another version of the node it names' using errcode = 'check_violation';
      end if;
    end if;
    if ref_kolab is distinct from new.kolab_id and new.held_by is null then
      raise exception 'edge: a link into another kolab names the actor whose Read it rests on (held_by)' using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'version' then
    if (ref_kolab is not null and ref_kolab <> new.kolab_id) <> (new.parent_held_by is not null) then
      raise exception 'version: a fork of another kolab''s version names the actor whose Read it rests on (parent_held_by), and no other version does' using errcode = 'check_violation';
    end if;
  end if;
  if ref_kolab is not null and ref_kolab <> new.kolab_id and ref_state <> 'committed' then
    raise exception '%: a reference into another kolab must name a committed version', tg_table_name using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_kolab_ref_check() from public;
create constraint trigger kolab_ref_check after insert or update of target_version_id, target_kolab_id, held_by on edge
  for each row execute function kj_kolab_ref_check();
create constraint trigger kolab_ref_check after insert or update of parent_version_id, parent_held_by on version
  for each row execute function kj_kolab_ref_check();
create constraint trigger kolab_ref_check after insert or update of base_version_id on delta
  for each row execute function kj_kolab_ref_check();
create constraint trigger kolab_ref_check after insert or update of triggered_by on invalidation
  for each row execute function kj_kolab_ref_check();

-- ---------------------------------------------------------------------------
-- Row-level security: an agent links and forks only into what it reads now
-- ---------------------------------------------------------------------------

-- Whether the current session may read version `p_version`: one of its own kolab's, or a
-- committed version of another kolab its actor holds Read on now (0008's reading rule).
create function kj_session_reads_version(p_version text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.version v where v.id = p_version
                  and (v.kolab_id = (select public.kj_session_kolab())
                       or (v.state = 'committed' and v.kolab_id = any ((select public.kj_session_readable_kolabs())::text[]))))
$$;
-- Whether the current session may draft a version of `p_node` on parent `p_parent`, held by
-- `p_holder`: a parent of its own kolab (no holder); another kolab's committed version it reads
-- now, held by its own actor; or a parent a committed version of the node already has, with that
-- version's holder, which the drafter carries without needing Read itself.
create function kj_session_may_fork(p_parent text, p_node text, p_holder text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.version p where p.id = p_parent
                  and (p.kolab_id = (select public.kj_session_kolab())
                       or (p_holder = (select public.kj_session_actor()) and public.kj_session_reads_version(p_parent))
                       or exists (select 1 from public.version c where c.node_id = p_node and c.state = 'committed'
                                   and c.kolab_id = (select public.kj_session_kolab())
                                   and c.parent_version_id = p_parent and c.parent_held_by = p_holder)))
$$;
-- Whether the current session may write a delta of version `p_version` against base `p_base`:
-- a base it reads (its own kolab's, or a committed version of another it reads now), or one a
-- committed version of the same node of its own kolab already stands on, as its parent or as an
-- override's base, which a draft carries forward without its author needing Read.
create function kj_session_may_base(p_base text, p_version text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select public.kj_session_reads_version(p_base)
      or exists (select 1 from public.version v join public.version c on c.node_id = v.node_id
                  where v.id = p_version and c.state = 'committed' and c.kolab_id = (select public.kj_session_kolab())
                    and (c.parent_version_id = p_base
                         or exists (select 1 from public.delta d where d.version_id = c.id and d.base_version_id = p_base)))
$$;
revoke execute on function kj_session_reads_version(text), kj_session_may_fork(text, text, text), kj_session_may_base(text, text) from public;
grant execute on function kj_session_reads_version(text), kj_session_may_fork(text, text, text), kj_session_may_base(text, text) to kj_agent;

-- Restrictive, so they hold on top of agent_layer and kolab_write rather than instead of them.
create policy edge_target on edge as restrictive for insert to kj_agent
  with check (held_by = (select kj_session_actor()) and kj_session_reads_version(target_version_id));
create policy version_parent on version as restrictive for insert to kj_agent
  with check (parent_version_id is null or kj_session_may_fork(parent_version_id, node_id, parent_held_by));
create policy delta_base on delta as restrictive for insert to kj_agent
  with check (base_version_id is null or kj_session_may_base(base_version_id, version_id));

-- ---------------------------------------------------------------------------
-- Removing a link into another kolab (0012's link_removal)
-- ---------------------------------------------------------------------------

-- A removal names the node its link targets, which may now be another kolab's: it records that
-- node's kolab, set from the node, and its key is on that pair rather than on the draft's kolab.
alter table link_removal add column target_kolab_id text references kolab(id);
update link_removal set target_kolab_id = kolab_id;
alter table link_removal alter column target_kolab_id set not null;
alter table link_removal drop constraint link_removal_target_node_id_kolab_id_fkey;
alter table link_removal add constraint link_removal_target_kolab_fkey foreign key (target_node_id, target_kolab_id) references node(id, kolab_id);
create function kj_link_removal_target_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  new.target_kolab_id := (select n.kolab_id from public.node n where n.id = new.target_node_id);
  return new;
end
$$;
revoke execute on function kj_link_removal_target_kolab() from public;
create trigger kolab_of_target before insert on link_removal for each row execute function kj_link_removal_target_kolab();

-- ---------------------------------------------------------------------------
-- The access_lost mark (LNK8)
-- ---------------------------------------------------------------------------

alter table invalidation drop constraint invalidation_reason_check;
alter table invalidation add constraint invalidation_reason_check check (reason in
  ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
   'upstream_dirty','review_failed','rebase_failed','role_boundary','query_answered','ruled','access_lost'));
                                                            -- MARK_REASONS in @konjir/types

-- A dependent in another kolab (a link's source, a fork) is brought up to date with a commit here
-- by 0015's rebase job, written per dependent, so no new outbox kind is needed.
