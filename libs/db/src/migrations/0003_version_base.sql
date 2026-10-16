-- Migration 0003: each version records the version it was built on (W1.17; CAS7, DAT3).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- base_version_id is the node's live version when a version was drafted: the one its content
-- was built from. Null means the node had no committed version yet. Kolab commits a version only
-- while its base is still the node's live version, checked under a lock on the node's row, so
-- two commits to one node can't both build on the same version and one silently lose the other.
--
-- Committed and rejected versions get the base the old check implied: the node's latest
-- committed version below their own seq. That is a record only; nothing judges them again.
-- A draft still open when this runs keeps a null base. Its true base is unknowable: a version
-- below it may have committed after it was drafted, and nothing records when. With a null base,
-- review treats every committed version of the node as newer, so the draft commits only on a
-- node with none, and otherwise is rejected as stale, to be redrafted. Nothing it
-- would overwrite is lost.
-- The table grants that 0001 gives kj_agent (insert) and kj_system (insert, update) on version
-- cover the new column.

alter table version add column base_version_id text references version(id);

update version v set base_version_id = (
  select b.id from version b
   where b.node_id = v.node_id and b.seq < v.seq and b.state = 'committed'
   order by b.seq desc limit 1)
 where v.state <> 'drafted';

-- An agent's draft may only be built on a committed version of its own node.
drop policy agent_layer on version;
create policy agent_layer on version for insert to kj_agent
  with check (state = 'drafted'
              and layer = kj_session_layer()
              and layer = (select n.layer from node n where n.id = node_id)
              and actor_id = kj_session_actor()
              and active_role = kj_session_role()
              and (base_version_id is null
                   or exists (select 1 from version b where b.id = version.base_version_id
                               and b.node_id = version.node_id and b.state = 'committed')));
