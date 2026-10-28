-- advisory
-- Preflight for migration 0029 (W5.1a, D98): read-only, against a database at 0028, before the
-- release that carries 0029 is deployed. Advisory, not a gate: 0029 itself can't fail (two nullable
-- columns, nothing rewritten). Run it with deploy/konjir-ops.sh preflight 0029, or as is:
-- psql "$DATABASE_URL" -f deploy/preflight/0029.sql
--
-- It lists each link a plan's next submission would be refused for by PLN2's Delivers checks
-- (planChecks): one row per kind of problem (ord, why, nodes), each naming the links with their
-- edge id, for konjir_draft's or konjir_admin_apply_ruling's unlink ({"link": "<id>"}). No rows
-- means every plan's next version passes them as things stand. It checks each plan's latest
-- committed version (its next draft carries every link forward) and each drafted or in-review plan
-- version (its own links, plus its base's that it doesn't unlink and whose source element it still
-- holds). Links into the plan itself aren't checked, as planChecks skips them.
-- libs/engine/test/migrations.test.ts checks that it names what planChecks then refuses.
with
plan_version as (
  select v.id, v.node_id, v.seq, v.state, v.base_version_id, p.parent_node_id, p.kolab_id, p.name
    from version v join node p on p.id = v.node_id
   where p.kind = 'plan'
     and (v.state in ('drafted', 'in_review')
          or v.id = (select c.id from version c where c.node_id = p.id and c.state = 'committed' order by c.seq desc limit 1))
),
held as (
  select pv.*, e.id as edge_id, e.kind as edge_kind, e.source_element_id, e.target_version_id, e.target_element_id, e.target_selector
    from plan_version pv join edge e on e.source_version_id = pv.id
  union all
  select pv.*, e.id, e.kind, e.source_element_id, e.target_version_id, e.target_element_id, e.target_selector
    from plan_version pv join edge e on e.source_version_id = pv.base_version_id join version t on t.id = e.target_version_id
   where pv.state <> 'committed'
     and (e.source_element_id is null
          or exists (select 1 from element el where el.version_id = pv.id and el.element_id = e.source_element_id))
     and not exists (select 1 from link_removal r where r.version_id = pv.id
                       and r.kind = e.kind and r.source_element_id is not distinct from e.source_element_id
                       and r.target_node_id = t.node_id and r.target_element_id is not distinct from e.target_element_id
                       and r.target_selector is not distinct from e.target_selector)
),
bad as (
  select format('%s/%s@%s%s -> %s/%s@%s%s%s [%s]', h.kolab_id, h.name, h.seq, coalesce('#' || h.source_element_id, ''),
                tn.kolab_id, tn.name, t.seq, coalesce('#' || h.target_element_id, ''),
                case when h.target_selector is not null then ' (a quote)' else '' end, h.edge_id) as detail,
         case when tn.id <> h.parent_node_id then 1
              when h.edge_kind <> 'dependency' then 2
              when h.source_element_id is null then 3
              when h.target_element_id is null then 4
              when h.target_selector is not null then 5
              when t.state <> 'committed' then 6 end as ord,
         h.edge_kind
    from held h join version t on t.id = h.target_version_id join node tn on tn.id = t.node_id
   where tn.id <> h.node_id
)
select ord,
       case ord when 1 then 'link from a plan outside its binding'
                when 2 then 'Delivers of another kind than dependency'
                when 3 then 'Delivers from the whole plan version'
                when 4 then 'Delivers to the whole binding'
                when 5 then 'Delivers that quotes inside a binding element'
                when 6 then 'Delivers to an uncommitted version' end as why,
       string_agg(detail || case when ord = 2 then ' ' || edge_kind else '' end, '; ' order by detail) as nodes
  from bad where ord is not null
 group by ord order by ord;
