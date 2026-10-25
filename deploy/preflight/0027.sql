-- Preflight for migration 0027 (W4.1): read-only, against a database at 0026, before the release
-- that carries 0027 is deployed. Run as is, for example with psql against the RDS database.
--
-- The first query is 0027's own check, text for text (libs/engine/test/migrations.test.ts compares
-- them): it returns no rows exactly when 0027 applies, and otherwise one row per kind of refusal,
-- naming the nodes or links, in the order 0027 reports them. The second lists the parent 0027 will
-- give each binding and each plan, and why: it refuses nothing.

-- check:begin
with
-- The versions whose links Kolab may write again, as new rows: a draft or a version in review
-- (a draft is built on its node's latest committed version, a fold copies the version it folds),
-- and each node's latest committed version (the next commit's cascade carries its links forward,
-- supersedePrevious). A rejected version's links are never copied again, nor are a superseded
-- version's, so they are history; a re-pin only updates a row, to another version of the node it
-- names, which can't change whether it is within its parent.
live as (
  select v.id, v.node_id from version v where v.state in ('drafted', 'in_review')
  union
  select l.id, l.node_id from (select distinct on (node_id) id, node_id from version where state = 'committed' order by node_id, seq desc) l
),
-- And the versions a cascade still owed will copy from: an after_commit job, waiting or dead,
-- carries forward the links of the committed version just before its own (supersedePrevious).
owed as (
  select p.id, p.node_id from outbox o join version v on v.id = o.version_id
    cross join lateral (select c.id, c.node_id from version c
                         where c.node_id = v.node_id and c.state = 'committed' and c.seq < v.seq order by c.seq desc limit 1) p
   where o.kind = 'after_commit' and p.id not in (select id from live)
),
checked as (select id, node_id, false as owed from live union all select id, node_id, true from owed),
spec as (select kolab_id, min(id) as id from node where kind = 'functional_spec' group by kolab_id having count(*) = 1),
sole as (select kolab_id, min(id) as id from node where kind = 'technical_binding' group by kolab_id having count(*) = 1),
-- The bindings of its own kolab that a plan's checked versions link.
reached as (
  select p.id as plan, array_agg(distinct t.id order by t.id) as bindings
    from node p join checked c on c.node_id = p.id join edge e on e.source_version_id = c.id
    join version tv on tv.id = e.target_version_id join node t on t.id = tv.node_id
   where p.kind in ('wbs', 'plan') and t.kind = 'technical_binding' and t.kolab_id = p.kolab_id
   group by p.id
),
-- Each binding's spec, its kolab's one spec; each plan's binding, the one its links reach, or
-- else its kolab's only binding.
inferred as (
  select n.id, n.kolab_id, n.name, n.kind,
         case when n.kind = 'technical_binding' then s.id
              when cardinality(r.bindings) = 1 then r.bindings[1]
              when r.bindings is null then o.id end as parent_id,
         case when n.kind = 'technical_binding' then 'its kolab''s one spec'
              when cardinality(r.bindings) = 1 then 'the one binding its links reach'
              when r.bindings is null then 'its kolab''s only binding' end as how
    from node n left join spec s on s.kolab_id = n.kolab_id left join reached r on r.plan = n.id left join sole o on o.kolab_id = n.kolab_id
   where n.kind in ('technical_binding', 'wbs', 'plan')
)
select r.ord, r.why, string_agg(r.detail, case when r.ord in (3, 6) then '; ' else ', ' end order by r.detail) as nodes
  from (
    select 1 as ord, 'not a kind' as why, format('%s/%s (%s)', kolab_id, name, kind) as detail
      from node where kind not in ('functional_spec', 'prototype', 'technical_binding', 'wbs', 'plan')
    union all
    select 2, 'layer not its kind''s', format('%s/%s (%s in the %s layer)', kolab_id, name, kind, layer)
      from node where layer <> case when kind in ('functional_spec', 'prototype') then 'functional' else 'technical' end
    union all
    select 3, 'more than one spec', format('kolab %s: %s', kolab_id, string_agg(name, ', ' order by name))
      from node where kind = 'functional_spec' group by kolab_id having count(*) > 1
    union all
    select 4, 'binding with no spec', format('%s/%s', b.kolab_id, b.name)
      from node b where b.kind = 'technical_binding'
       and not exists (select 1 from node s where s.kolab_id = b.kolab_id and s.kind = 'functional_spec')
    union all
    select 5, 'plan whose binding can''t be told', format('%s/%s', kolab_id, name)
      from inferred where kind in ('wbs', 'plan') and parent_id is null
    union all
    select 6, 'two plans of one binding', format('%s/%s: %s', b.kolab_id, b.name, string_agg(i.name, ', ' order by i.name))
      from inferred i join node b on b.id = i.parent_id where i.kind in ('wbs', 'plan') group by b.kolab_id, b.name having count(*) > 1
    union all
    select case when c.owed then 8 else 7 end, case when c.owed then 'link a cascade still owed would carry' else 'link outside its parent' end,
           format('%s/%s@%s%s -> %s/%s@%s%s', s.kolab_id, s.name, sv.seq, coalesce('#' || e.source_element_id, ''),
                  t.kolab_id, t.name, tv.seq, coalesce('#' || e.target_element_id, ''))
      from edge e join checked c on c.id = e.source_version_id
      join version sv on sv.id = e.source_version_id join node s on s.id = sv.node_id
      join version tv on tv.id = e.target_version_id join node t on t.id = tv.node_id
      left join inferred i on i.id = s.id
     where not coalesce(case when s.kind in ('wbs', 'plan') then t.id = i.parent_id or t.id = s.id
                             when s.kind = 'technical_binding' and t.kind = 'functional_spec' then t.id = i.parent_id
                             else true end, true)
  ) r
 group by r.ord, r.why
-- check:end
 order by r.ord;

-- parents:begin
with
-- The versions whose links Kolab may write again, as new rows: a draft or a version in review
-- (a draft is built on its node's latest committed version, a fold copies the version it folds),
-- and each node's latest committed version (the next commit's cascade carries its links forward,
-- supersedePrevious). A rejected version's links are never copied again, nor are a superseded
-- version's, so they are history; a re-pin only updates a row, to another version of the node it
-- names, which can't change whether it is within its parent.
live as (
  select v.id, v.node_id from version v where v.state in ('drafted', 'in_review')
  union
  select l.id, l.node_id from (select distinct on (node_id) id, node_id from version where state = 'committed' order by node_id, seq desc) l
),
-- And the versions a cascade still owed will copy from: an after_commit job, waiting or dead,
-- carries forward the links of the committed version just before its own (supersedePrevious).
owed as (
  select p.id, p.node_id from outbox o join version v on v.id = o.version_id
    cross join lateral (select c.id, c.node_id from version c
                         where c.node_id = v.node_id and c.state = 'committed' and c.seq < v.seq order by c.seq desc limit 1) p
   where o.kind = 'after_commit' and p.id not in (select id from live)
),
checked as (select id, node_id, false as owed from live union all select id, node_id, true from owed),
spec as (select kolab_id, min(id) as id from node where kind = 'functional_spec' group by kolab_id having count(*) = 1),
sole as (select kolab_id, min(id) as id from node where kind = 'technical_binding' group by kolab_id having count(*) = 1),
-- The bindings of its own kolab that a plan's checked versions link.
reached as (
  select p.id as plan, array_agg(distinct t.id order by t.id) as bindings
    from node p join checked c on c.node_id = p.id join edge e on e.source_version_id = c.id
    join version tv on tv.id = e.target_version_id join node t on t.id = tv.node_id
   where p.kind in ('wbs', 'plan') and t.kind = 'technical_binding' and t.kolab_id = p.kolab_id
   group by p.id
),
-- Each binding's spec, its kolab's one spec; each plan's binding, the one its links reach, or
-- else its kolab's only binding.
inferred as (
  select n.id, n.kolab_id, n.name, n.kind,
         case when n.kind = 'technical_binding' then s.id
              when cardinality(r.bindings) = 1 then r.bindings[1]
              when r.bindings is null then o.id end as parent_id,
         case when n.kind = 'technical_binding' then 'its kolab''s one spec'
              when cardinality(r.bindings) = 1 then 'the one binding its links reach'
              when r.bindings is null then 'its kolab''s only binding' end as how
    from node n left join spec s on s.kolab_id = n.kolab_id left join reached r on r.plan = n.id left join sole o on o.kolab_id = n.kolab_id
   where n.kind in ('technical_binding', 'wbs', 'plan')
)
-- parents:end
select i.kolab_id, i.name as node, case when i.kind = 'wbs' then 'plan' else i.kind end as kind, p.name as parent, i.how
  from inferred i join node p on p.id = i.parent_id
 order by i.kolab_id, i.kind, i.name;
