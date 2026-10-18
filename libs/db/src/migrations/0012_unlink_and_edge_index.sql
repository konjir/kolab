-- Migration 0012: removing links, and the indexes the cascade's walks need (D50; LNK6, CAS3, D48).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A link's owner can remove it (D48: the owner of an orphaned link "re-points or removes it").
-- A removal is part of a version, reviewed like any edit (W1.6): a draft records the links it
-- drops, one link_removal row each, and when it commits, the links it was built on carry
-- forward without them (CAS3), and their open marks settle. Nothing changes before the commit, so
-- a draft abandoned, rejected or sent back changes nothing. A link is named as copyEdges carries it
-- forward: its kind, its source element (null for the whole version), and the target's node,
-- element and quote, whatever version of the target it is pinned to.

create table link_removal (
  id                text primary key,
  kolab_id          text not null references kolab(id),   -- the draft's, set on insert (kj_link_removal_kolab)
  version_id        text not null,                        -- the draft that drops the link
  kind              text not null check (kind in ('derivation','dependency','equivalence')),
  source_element_id text,
  target_node_id    text not null,
  target_element_id text,
  target_selector   jsonb,
  created_at        timestamptz not null default now(),
  check (target_selector is null or target_element_id is not null),
  unique nulls not distinct (version_id, kind, source_element_id, target_node_id, target_element_id, target_selector),
  foreign key (version_id, kolab_id) references version(id, kolab_id),
  foreign key (target_node_id, kolab_id) references node(id, kolab_id)
);

-- Its kolab is its draft's, whatever the writer gave, and never changes (as 0006 does for every
-- other row of kolab data). The target node's key then holds the target in that kolab too.
create function kj_link_removal_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  new.kolab_id := (select v.kolab_id from version v where v.id = new.version_id);
  return new;
end
$$;
revoke execute on function kj_link_removal_kolab() from public;
create trigger kolab_of_parent before insert on link_removal for each row execute function kj_link_removal_kolab();
create trigger kolab_fixed before update of kolab_id on link_removal for each row execute function kj_kolab_fixed();

-- An agent records removals only on a draft of its own, in its session's layer and kolab, and may
-- take one back (linking the same link again in that draft). Kolab, as kj_system, copies them
-- onto a fold (CAS7) and reads them as the draft commits.
grant select, insert, delete on link_removal to kj_agent, kj_system;
alter table link_removal enable row level security;
create policy kolab_read on link_removal for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy agent_layer on link_removal for insert to kj_agent
  with check (exists (select 1 from version v where v.id = version_id
                       and v.state = 'drafted' and v.layer = (select kj_session_layer())
                       and v.actor_id = (select kj_session_actor())));
create policy kolab_write on link_removal as restrictive for insert to kj_agent with check (kolab_id = (select kj_session_kolab()));
create policy agent_draft on link_removal for delete to kj_agent
  using (exists (select 1 from version v where v.id = version_id
                  and v.state = 'drafted' and v.layer = (select kj_session_layer())
                  and v.actor_id = (select kj_session_actor())));
create policy kolab_delete on link_removal as restrictive for delete to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on link_removal for all to kj_system using (true) with check (true);

-- A link a draft declared itself goes at once when the draft removes it: an agent may delete an
-- edge only from a draft of its own, in its session's layer and kolab. Nothing marks a draft's
-- links, so no mark refers to one.
grant delete on edge to kj_agent;
create policy agent_draft on edge for delete to kj_agent
  using (exists (select 1 from version v where v.id = source_version_id
                  and v.state = 'drafted' and v.layer = (select kj_session_layer())
                  and v.actor_id = (select kj_session_actor())));
create policy kolab_delete on edge as restrictive for delete to kj_agent using (kolab_id = (select kj_session_kolab()));

-- Indexes the cascade's walks need (W2.5's follow-up, Plan P7), measured with explain analyze on
-- Postgres 18 over 38,400 links, 2,280 versions and 2,820 marks: without them every query below
-- read all of edge. The propagate walk (edges into any version of a node it reaches) went from
-- 11.7 ms to 0.4 ms per step, the inbound links a commit re-checks from 6.7 to 0.9 ms, lineage
-- downstream from 9.3 to 0.8 ms, and a version's outbound links, which every commit carries
-- forward, from 2.9 to 0.06 ms. The open-mark lookups run in the same walks and checks.
create index edge_target_version on edge(target_version_id);
create index edge_source_version on edge(source_version_id);
create index invalidation_open_edge on invalidation(edge_id) where state = 'open';
create index invalidation_open_version on invalidation(version_id) where state = 'open';
create index invalidation_cause_cause on invalidation_cause(cause_id);
