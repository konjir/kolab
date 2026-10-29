-- Preflight for migration 0033 (W5.1d, D104): read-only, against a database at 0032, before the
-- release that carries 0033 is deployed. Run it with deploy/konjir-ops.sh preflight 0033, or as is:
-- psql "$DATABASE_URL" -f deploy/preflight/0033.sql
--
-- The first query is 0033's own check, text for text (libs/engine/test/migrations.test.ts compares
-- them): it returns no rows exactly when 0033 applies, and otherwise one row per kind of refusal, in
-- the order 0033 reports them. The second lists where each plan's work package moves: its binding,
-- its id there, and whether it is renamed (the binding has had an element of its id), with its state.
-- The third is the versions 0033 rejects, text for text: the drafts and versions in review of each
-- plan, of each binding that receives packages, and of its variants and forks. Neither refuses anything.

-- check:begin
with
plans as (
  select p.id, p.name, p.kolab_id, p.parent_node_id as binding from node p where p.kind = 'plan'
),
-- A cascade owed on a plan or its binding, and a rebase or a settle owed on a plan.
owed as (
  select o.id, o.kind, n.kolab_id, n.name, v.seq from outbox o join version v on v.id = o.version_id join node n on n.id = v.node_id
   where (o.kind = 'after_commit' and (n.id in (select id from plans) or n.id in (select binding from plans)))
      or (o.kind in ('rebase', 'settle') and n.id in (select id from plans))
),
taken as (
  select p.kolab_id, p.name as plan, w.element_id, b.name as binding
    from plans p join work_package w on w.plan_node_id = p.id join node b on b.id = p.binding
   where exists (select 1 from element e join version v on v.id = e.version_id where v.node_id = p.binding and e.element_id = w.element_id)
     and (exists (select 1 from element e join version v on v.id = e.version_id where v.node_id = p.binding and e.element_id = p.name || '.' || w.element_id)
          or exists (select 1 from work_package x where x.plan_node_id = p.id and x.element_id = p.name || '.' || w.element_id))
)
select r.ord, string_agg(r.detail, ', ' order by r.detail) as items
  from (
    select 1 as ord, format('%s job %s, %s/%s@%s', kind, id, kolab_id, name, seq) as detail from owed
    union all
    select 2, format('%s/%s#%s (%s#%s.%s)', kolab_id, plan, element_id, binding, plan, element_id) from taken
  ) r
 group by r.ord
-- check:end
;

select w.kolab_id, p.name as plan, w.element_id as plan_element, b.name as binding,
       case when exists (select 1 from element e join version v on v.id = e.version_id where v.node_id = p.parent_node_id and e.element_id = w.element_id)
            then p.name || '.' || w.element_id else w.element_id end as element_id,
       exists (select 1 from element e join version v on v.id = e.version_id where v.node_id = p.parent_node_id and e.element_id = w.element_id) as renamed,
       w.state, w.assignee_id, w.removed_in_version_id is not null as removed
  from work_package w join node p on p.id = w.plan_node_id join node b on b.id = p.parent_node_id
 where p.kind = 'plan'
 order by w.kolab_id, p.name, w.element_id;

-- rejected:begin
with
receiving as (
  select distinct p.parent_node_id as id from node p
   where p.kind = 'plan' and exists (select 1 from version v where v.node_id = p.id and v.state = 'committed')
),
variants as (
  select distinct c.node_id as id from version c join version pv on pv.id = c.parent_version_id
   where pv.node_id in (select id from receiving) and c.node_id not in (select id from receiving)
)
select v.id, n.kolab_id, n.name, v.seq, v.state, n.kind from version v join node n on n.id = v.node_id
 where v.state in ('drafted', 'in_review')
   and (n.kind = 'plan' or n.id in (select id from receiving) or n.id in (select id from variants))
 order by n.kolab_id, n.name, v.seq
-- rejected:end
;
