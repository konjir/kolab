-- Migration 0027: typed konstruct kinds, their limits and parent links (W4.1; KON1–KON6, KON8;
-- D77, D78, D79, D80, D95).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A node's kind was a label from 0001's list with no limit enforced. It becomes one of four fixed
-- kinds (D77, named by D95): spec and prototype, in the functional layer, and binding and plan, in
-- the technical layer. A work package is an element of a plan (KON5) and implementation is a
-- repository (KON7), so neither is a kind of node any more.
--
--   - A kolab holds at most one spec (KON1): a unique index. A kolab starts with none, so "exactly
--     one" is enforced as "never a second"; a variant of a spec lives in another kolab (KON9).
--   - A node's layer follows from its kind (KON8, D77): a check.
--   - Each binding names exactly one spec, and each plan exactly one binding, by a node-level
--     parent link set when it is created (D78): node.parent_node_id, in the node's own kolab, of
--     the right kind, required of a binding and a plan and given to nothing else. A binding's spec
--     is its kolab's one spec.
--   - Each binding has at most one plan (KON5): a unique index.
--   - A node's kind, layer and parent never change once written.
--   - A variant is of its parent's kind, except that a prototype may be derived from the spec
--     (D95, KON3): no plan or binding inherits a spec's elements (KON6).
--   - Element links point inside the parent (D78): a link from a plan targets its own binding (or
--     the plan itself), never the spec (KON6), and a link from a binding to a spec targets the
--     binding's own spec. Checked as each link is written, for every role.
--
-- Prototypes (D79) need no column: a prototype is a node whose elements are its screens, each
-- linked by equivalence links to the requirements it shows, and the cascade already marks a
-- screen when the requirement it links to changes. A prototype names no parent, since either it
-- or the spec may come first (KON3).
--
-- Existing nodes are mapped by their labels (D77, D95): functional_spec becomes spec,
-- technical_binding binding and wbs plan; prototype stays. Nothing is guessed: before anything
-- changes, the migration stops, naming the nodes, if any node is a work_package or an
-- implementation, if a node's layer isn't its kind's, if a kolab holds more than one spec, if a
-- binding's kolab has no spec, if a plan's binding can't be told (its live versions' links reach
-- no binding of its kolab and the kolab hasn't exactly one, or they reach more than one), if two
-- plans would share a binding, if a link Kolab may still write again breaks the rules above (one
-- of a draft, a version in review or a node's latest committed version, or one a cascade still
-- owed in the outbox will carry forward), or if a live version is a variant of another kind.
-- Each needs a decision first, which only a person can make.

-- ---------------------------------------------------------------------------
-- What can't be mapped, refused before anything changes
-- ---------------------------------------------------------------------------

-- One query finds every refusal, on the database as 0026 leaves it, and deploy/preflight/0027.sql
-- runs the same query, text for text (libs/engine/test/migrations.test.ts compares them), so it
-- returns no rows exactly when this migration applies.
do $$
declare bad text;
begin
  select string_agg(format(case q.ord
      when 1 then 'A node''s kind is now one of spec, prototype, binding or plan (D77, D95): a work package is an element of a plan (KON5) and implementation is a repository (KON7). These nodes have no kind to map to: %s. Decide what each becomes.'
      when 2 then 'A node''s layer follows from its kind (KON8, D77), and these nodes'' don''t: %s. Decide what each is.'
      when 3 then 'A kolab holds exactly one spec (KON1, D77), and these hold more: %s. Kolab won''t choose which is the spec: decide, and change the others'' kind.'
      when 4 then 'Each binding names the spec it binds (D78), but these bindings'' kolabs hold no spec: %s. Add the spec, or decide what each becomes.'
      when 5 then 'Each plan names the binding it plans (D78), and these plans'' bindings can''t be told: %s. Their live versions'' links reach no binding of their kolab and it hasn''t exactly one, or they reach more than one. Decide each one''s binding.'
      when 6 then 'Each binding has exactly one plan (KON5, D77), and these bindings would have more: %s. Decide which is the plan.'
      when 7 then 'A plan''s links deliver its own binding''s elements, never the spec (KON6, D78), and a binding''s links to a spec serve its own spec (D78). These links don''t: %s. Decide what each should link to, and remove the others.'
      when 8 then 'A cascade Kolab still owes (an after_commit job in the outbox, waiting or dead) would carry these links forward, and they break the same rules: %s. Let the outbox drain first, retrying a dead job with konjir_admin_outbox retry=<id>; the links then stand on their nodes'' latest versions, where this check names them.'
      when 9 then 'A variant is of its parent''s kind, and only a prototype may be derived from the spec (KON3, KON6, D95), and these live versions aren''t: %s. Decide what each should be built on.'
    end, q.nodes), ' ' order by q.ord) into bad
    from (
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
   where p.kind = 'wbs' and t.kind = 'technical_binding' and t.kolab_id = p.kolab_id
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
   where n.kind in ('technical_binding', 'wbs')
)
select r.ord, r.why, string_agg(r.detail, case when r.ord in (3, 6) then '; ' else ', ' end order by r.detail) as nodes
  from (
    select 1 as ord, 'not a kind' as why, format('%s/%s (%s)', kolab_id, name, kind) as detail
      from node where kind not in ('functional_spec', 'prototype', 'technical_binding', 'wbs')
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
      from inferred where kind = 'wbs' and parent_id is null
    union all
    select 6, 'two plans of one binding', format('%s/%s: %s', b.kolab_id, b.name, string_agg(i.name, ', ' order by i.name))
      from inferred i join node b on b.id = i.parent_id where i.kind = 'wbs' group by b.kolab_id, b.name having count(*) > 1
    union all
    select case when c.owed then 8 else 7 end, case when c.owed then 'link a cascade still owed would carry' else 'link outside its parent' end,
           format('%s/%s@%s%s -> %s/%s@%s%s', s.kolab_id, s.name, sv.seq, coalesce('#' || e.source_element_id, ''),
                  t.kolab_id, t.name, tv.seq, coalesce('#' || e.target_element_id, ''))
      from edge e join checked c on c.id = e.source_version_id
      join version sv on sv.id = e.source_version_id join node s on s.id = sv.node_id
      join version tv on tv.id = e.target_version_id join node t on t.id = tv.node_id
      left join inferred i on i.id = s.id
     where not coalesce(case when s.kind = 'wbs' then t.id = i.parent_id or t.id = s.id
                             when s.kind = 'technical_binding' and t.kind = 'functional_spec' then t.id = i.parent_id
                             else true end, true)
    union all
    -- A variant is of its parent's kind, but a prototype may be derived from the spec (D95, KON3):
    -- never a plan or a binding on a spec's version (KON6). A live version's parent is the one its
    -- next draft and its rebases build on.
    select 9, 'variant of another kind', format('%s/%s@%s (%s) on %s/%s@%s (%s)', c.kolab_id, c.name, v.seq, c.kind, p.kolab_id, p.name, pv.seq, p.kind)
      from live l join version v on v.id = l.id join node c on c.id = v.node_id
      join version pv on pv.id = v.parent_version_id join node p on p.id = pv.node_id
     where p.id <> c.id and not (c.kind = p.kind or (c.kind = 'prototype' and p.kind = 'functional_spec'))
  ) r
 group by r.ord, r.why
-- check:end
    ) q;
  if bad is not null then
    raise exception 'migration 0027: % Each needs a person''s decision before 0027 applies; deploy/preflight/0027.sql lists the same.', bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Parent links (D78): a binding's spec, a plan's binding
-- ---------------------------------------------------------------------------

alter table node add column parent_node_id text;

-- Each parent as the check above inferred it, which it found for every binding and plan, set
-- while the nodes still carry 0026's labels.
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
   where p.kind = 'wbs' and t.kind = 'technical_binding' and t.kolab_id = p.kolab_id
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
   where n.kind in ('technical_binding', 'wbs')
)
-- parents:end
update node n set parent_node_id = i.parent_id from inferred i where n.id = i.id;

-- ---------------------------------------------------------------------------
-- The kinds, and the layer each fixes
-- ---------------------------------------------------------------------------

alter table node drop constraint node_kind_check;
update node set kind = case kind when 'functional_spec' then 'spec' when 'technical_binding' then 'binding' when 'wbs' then 'plan' else kind end;
alter table node add constraint node_kind_check check (kind in
  ('spec', 'prototype', 'binding', 'plan'));   -- KINDS in @konjir/types
alter table node add constraint node_layer_of_kind check (layer =
  case when kind in ('spec', 'prototype') then 'functional' else 'technical' end);   -- LAYER_OF_KIND in @konjir/types

-- A kolab never holds a second spec (KON1).
create unique index node_one_spec_per_kolab on node(kolab_id) where kind = 'spec';

alter table node add constraint node_parent_kolab_fkey foreign key (parent_node_id, kolab_id) references node(id, kolab_id);
alter table node add constraint node_parent_given check ((parent_node_id is not null) = (kind in ('binding', 'plan')));
create index node_parent on node(parent_node_id) where parent_node_id is not null;
-- A binding has at most one plan (KON5).
create unique index node_one_plan_per_binding on node(parent_node_id) where kind = 'plan';

-- A binding's parent is a spec, and a plan's a binding, for every role.
create function kj_node_parent_kind() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare p text;
begin
  if new.parent_node_id is null then return new; end if;
  select n.kind into p from public.node n where n.id = new.parent_node_id and n.kolab_id = new.kolab_id;
  if new.kind = 'binding' and p is distinct from 'spec' then
    raise exception 'node: a binding names the spec it binds (D78), and % is no spec of its kolab', new.parent_node_id using errcode = 'check_violation';
  elsif new.kind = 'plan' and p is distinct from 'binding' then
    raise exception 'node: a plan names the binding it plans (D78), and % is no binding of its kolab', new.parent_node_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_node_parent_kind() from public;
create trigger node_parent_kind before insert on node for each row execute function kj_node_parent_kind();

-- A node's kind, layer and parent never change once written, for kj_agent and kj_system. A later
-- migration may (kj_migrating), as it may for archived kolabs' rows; so may Kolab's own login,
-- which can set kj.migrating as the runner does (0014's design).
create function kj_node_kind_fixed() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if public.kj_migrating() then return new; end if;
  if new.kind is distinct from old.kind or new.layer is distinct from old.layer or new.parent_node_id is distinct from old.parent_node_id then
    raise exception 'node: a node''s kind, layer and parent never change once written (D77, D78)' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_node_kind_fixed() from public;
create trigger node_kind_fixed before update of kind, layer, parent_node_id on node for each row execute function kj_node_kind_fixed();

-- An agent reads a node's parent where it reads the node (0024's column grants).
grant select (parent_node_id) on node to kj_agent;

-- ---------------------------------------------------------------------------
-- A variant is of its parent's kind (D95, KON3, KON6)
-- ---------------------------------------------------------------------------

-- A version whose parent is another node's version is a variant of it: of the same kind, or a
-- prototype derived from the spec. So no plan or binding inherits a spec's elements. Checked for
-- every role after row-level security (like 0017's kolab_ref_check), so its message names only a
-- parent the writer may already read.
create function kj_version_parent_kind() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare c record; p record;
begin
  if new.parent_version_id is null then return null; end if;
  select n.name, n.kind into c from public.node n where n.id = new.node_id;
  select n.name, n.kind into p from public.version v join public.node n on n.id = v.node_id
   where v.id = new.parent_version_id and v.node_id <> new.node_id;
  if p.kind is not null and not (c.kind = p.kind or (c.kind = 'prototype' and p.kind = 'spec')) then
    raise exception 'version: a variant is of its parent''s kind, and only a prototype may be derived from the spec (KON3, KON6, D95); % is a %, and its parent % a %',
      c.name, c.kind, p.name, p.kind using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_version_parent_kind() from public;
create constraint trigger version_parent_kind after insert or update of parent_version_id on version
  for each row execute function kj_version_parent_kind();

-- ---------------------------------------------------------------------------
-- Element links point inside the parent (D78, KON6)
-- ---------------------------------------------------------------------------

-- Whether a link from a node of kind `src_kind` (`src`, whose parent is `src_parent`) may target
-- the node `tgt` of kind `tgt_kind`: a plan's links deliver its own binding's elements, or depend
-- on its own; a binding serves its own spec, and no other.
create function kj_link_within_parent(src text, src_kind text, src_parent text, tgt text, tgt_kind text) returns boolean
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case
    when src_kind = 'plan' then tgt = src_parent or tgt = src
    when src_kind = 'binding' and tgt_kind = 'spec' then tgt = src_parent
    else true
  end
$$;
revoke execute on function kj_link_within_parent(text, text, text, text, text) from public;

-- Every link written from now on, for every role: after row-level security, like 0017's
-- kolab_ref_check, so an agent refused there learns nothing more. A new row, or a row moved to
-- another source. Not a re-pin (an update of target_version_id): 0017 lets a link be re-pinned
-- only to another version of the node it names, and a node's kind and parent never change, so a
-- re-pin can't change the verdict, and the links of versions this migration leaves as history
-- (rejected and superseded ones) are re-pinned by the cascade as before.
create function kj_edge_within_parent() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare s record; t record;
begin
  select n.id, n.name, n.kind, n.parent_node_id into s
    from public.version v join public.node n on n.id = v.node_id where v.id = new.source_version_id;
  select n.id, n.name, n.kind into t
    from public.version v join public.node n on n.id = v.node_id where v.id = new.target_version_id;
  if not public.kj_link_within_parent(s.id, s.kind, s.parent_node_id, t.id, t.kind) then
    if s.kind = 'plan' then
      raise exception 'edge: a plan''s links deliver its own binding''s elements, never the spec or another node (KON6, D78); % targets %', s.name, t.name
        using errcode = 'check_violation';
    end if;
    raise exception 'edge: a binding serves its own spec, and no other (D78); % targets %', s.name, t.name using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_edge_within_parent() from public;
create constraint trigger edge_within_parent after insert or update of source_version_id on edge
  for each row execute function kj_edge_within_parent();
