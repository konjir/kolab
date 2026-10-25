-- Migration 0027: typed konstruct kinds, their limits and parent links (W4.1; KON1–KON6, KON8;
-- D77, D78, D79, D80).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A node's kind was a label from 0001's list with no limit enforced. It becomes one of four fixed
-- kinds (D77): functional_spec and prototype, in the functional layer, and technical_binding and
-- plan, in the technical layer. A work package is an element of a plan (KON5) and implementation
-- is a git repository (KON7), so neither is a kind of node any more.
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
--   - Element links point inside the parent (D78): a link from a plan targets its own binding (or
--     the plan itself), never the spec (KON6), and a link from a binding to a spec targets the
--     binding's own spec. Checked as each link is written, for every role.
--
-- Prototypes (D79) need no column: a prototype is a node whose elements are its screens, each
-- linked by equivalence links to the requirements it shows, and the cascade already marks a
-- screen when the requirement it links to changes. A prototype names no parent, since either it
-- or the spec may come first (KON3).
--
-- Existing nodes are mapped by their current labels (D77): functional_spec, prototype and
-- technical_binding keep theirs, and wbs becomes plan. Nothing is guessed: before anything changes,
-- the migration stops, naming the nodes, if any node is a work_package or an implementation, if a
-- node's layer isn't its kind's, if a kolab holds more than one spec, if a binding's kolab has no
-- spec, if a plan's binding can't be told (its links reach no binding of its kolab and the kolab
-- hasn't exactly one, or they reach more than one), if two plans would share a binding, or if a
-- link that a draft would carry forward breaks the rules above. Each needs a decision first,
-- which only a person can make.

-- ---------------------------------------------------------------------------
-- What can't be mapped, refused before anything changes
-- ---------------------------------------------------------------------------

do $$
declare bad text;
begin
  select string_agg(format('%s/%s (%s)', kolab_id, name, kind), ', ' order by kolab_id, name) into bad
    from node where kind not in ('functional_spec', 'prototype', 'technical_binding', 'wbs');
  if bad is not null then
    raise exception 'migration 0027: a node''s kind is now one of functional_spec, prototype, technical_binding or plan (D77): a work package is an element of a plan (KON5) and implementation is a git repository (KON7). These nodes have no kind to map to: %. Decide what each becomes before applying 0027', bad;
  end if;

  -- Kolab has always set a node's layer from its kind; one written otherwise is refused, not fixed.
  select string_agg(format('%s/%s (%s in the %s layer)', kolab_id, name, kind, layer), ', ' order by kolab_id, name) into bad
    from node where layer <> case when kind in ('functional_spec', 'prototype') then 'functional' else 'technical' end;
  if bad is not null then
    raise exception 'migration 0027: a node''s layer follows from its kind (KON8, D77), and these nodes'' don''t: %. Decide what each is before applying 0027', bad;
  end if;

  select string_agg(format('kolab %s: %s', kolab_id, specs), '; ' order by kolab_id) into bad
    from (select kolab_id, string_agg(name, ', ' order by name) as specs
            from node where kind = 'functional_spec' group by kolab_id having count(*) > 1) x;
  if bad is not null then
    raise exception 'migration 0027: a kolab holds exactly one spec (KON1, D77), and these hold more: %. Kolab won''t choose which is the spec: decide, and change the others'' kind, before applying 0027', bad;
  end if;

  select string_agg(format('%s/%s', b.kolab_id, b.name), ', ' order by b.kolab_id, b.name) into bad
    from node b where b.kind = 'technical_binding'
     and not exists (select 1 from node s where s.kolab_id = b.kolab_id and s.kind = 'functional_spec');
  if bad is not null then
    raise exception 'migration 0027: each binding names the spec it binds (D78), but these bindings'' kolabs hold no spec: %. Add the spec, or decide what each becomes, before applying 0027', bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The kinds, and the layer each fixes
-- ---------------------------------------------------------------------------

alter table node drop constraint node_kind_check;
update node set kind = 'plan' where kind = 'wbs';
alter table node add constraint node_kind_check check (kind in
  ('functional_spec', 'prototype', 'technical_binding', 'plan'));   -- KINDS in @konjir/types
alter table node add constraint node_layer_of_kind check (layer =
  case when kind in ('functional_spec', 'prototype') then 'functional' else 'technical' end);   -- LAYER_OF_KIND in @konjir/types

-- A kolab never holds a second spec (KON1).
create unique index node_one_spec_per_kolab on node(kolab_id) where kind = 'functional_spec';

-- ---------------------------------------------------------------------------
-- Parent links (D78): a binding's spec, a plan's binding
-- ---------------------------------------------------------------------------

alter table node add column parent_node_id text;

-- A binding's spec is its kolab's one spec.
update node b set parent_node_id = s.id
  from node s where b.kind = 'technical_binding' and s.kolab_id = b.kolab_id and s.kind = 'functional_spec';

-- A plan's binding is the one its links deliver, if they reach exactly one binding of its kolab;
-- if they reach none, its kolab's binding, if the kolab has exactly one.
with reached as (
  select p.id as plan, array_agg(distinct t.id order by t.id) as bindings
    from node p
    join version pv on pv.node_id = p.id and pv.state <> 'rejected'
    join edge e on e.source_version_id = pv.id
    join version tv on tv.id = e.target_version_id
    join node t on t.id = tv.node_id
   where p.kind = 'plan' and t.kind = 'technical_binding' and t.kolab_id = p.kolab_id
   group by p.id
), sole as (
  select kolab_id, min(id) as id from node where kind = 'technical_binding' group by kolab_id having count(*) = 1
)
update node p set parent_node_id = case when r.bindings is null then o.id when cardinality(r.bindings) = 1 then r.bindings[1] end
  from node k left join reached r on r.plan = k.id left join sole o on o.kolab_id = k.kolab_id
 where p.kind = 'plan' and k.id = p.id;

do $$
declare bad text;
begin
  select string_agg(format('%s/%s', kolab_id, name), ', ' order by kolab_id, name) into bad
    from node where kind = 'plan' and parent_node_id is null;
  if bad is not null then
    raise exception 'migration 0027: each plan names the binding it plans (D78), and these plans'' bindings can''t be told: %. Their links reach no binding of their kolab and it hasn''t exactly one, or they reach more than one. Decide each one''s binding before applying 0027', bad;
  end if;

  select string_agg(format('%s/%s: %s', b.kolab_id, b.name, plans), '; ' order by b.kolab_id, b.name) into bad
    from (select parent_node_id, string_agg(name, ', ' order by name) as plans
            from node where kind = 'plan' group by parent_node_id having count(*) > 1) x
    join node b on b.id = x.parent_node_id;
  if bad is not null then
    raise exception 'migration 0027: each binding has exactly one plan (KON5, D77), and these bindings would have more: %. Decide which is the plan before applying 0027', bad;
  end if;
end
$$;

alter table node add constraint node_parent_kolab_fkey foreign key (parent_node_id, kolab_id) references node(id, kolab_id);
alter table node add constraint node_parent_given check ((parent_node_id is not null) = (kind in ('technical_binding', 'plan')));
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
  if new.kind = 'technical_binding' and p is distinct from 'functional_spec' then
    raise exception 'node: a binding names the spec it binds (D78), and % is no spec of its kolab', new.parent_node_id using errcode = 'check_violation';
  elsif new.kind = 'plan' and p is distinct from 'technical_binding' then
    raise exception 'node: a plan names the binding it plans (D78), and % is no binding of its kolab', new.parent_node_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_node_parent_kind() from public;
create trigger node_parent_kind before insert on node for each row execute function kj_node_parent_kind();

-- A node's kind, layer and parent never change once written, for any role. A later migration may
-- (kj_migrating), as it may for archived kolabs' rows.
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
-- Element links point inside the parent (D78, KON6)
-- ---------------------------------------------------------------------------

-- Whether a link from a node of kind `src_kind` (`src`, whose parent is `src_parent`) may target
-- the node `tgt` of kind `tgt_kind`: a plan's links deliver its own binding's elements, or depend
-- on its own; a binding serves its own spec, and no other.
create function kj_link_within_parent(src text, src_kind text, src_parent text, tgt text, tgt_kind text) returns boolean
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case
    when src_kind = 'plan' then tgt = src_parent or tgt = src
    when src_kind = 'technical_binding' and tgt_kind = 'functional_spec' then tgt = src_parent
    else true
  end
$$;
revoke execute on function kj_link_within_parent(text, text, text, text, text) from public;

do $$
declare bad text;
begin
  -- The links a draft would carry forward: those of each node's latest committed version, and of
  -- its drafts and versions in review.
  with live as (
    select v.id from version v where v.state in ('drafted', 'in_review')
    union
    select l.id from (select distinct on (node_id) id from version where state = 'committed' order by node_id, seq desc) l
  )
  select string_agg(distinct format('%s/%s@%s%s -> %s/%s@%s%s', s.kolab_id, s.name, sv.seq, coalesce('#' || e.source_element_id, ''),
                                    t.kolab_id, t.name, tv.seq, coalesce('#' || e.target_element_id, '')), ', ') into bad
    from edge e
    join live on live.id = e.source_version_id
    join version sv on sv.id = e.source_version_id join node s on s.id = sv.node_id
    join version tv on tv.id = e.target_version_id join node t on t.id = tv.node_id
   where not kj_link_within_parent(s.id, s.kind, s.parent_node_id, t.id, t.kind);
  if bad is not null then
    raise exception 'migration 0027: a plan''s links deliver its own binding''s elements, never the spec (KON6, D78), and a binding''s links to a spec serve its own spec (D78). These links don''t: %. Decide what each should link to, and remove the others, before applying 0027', bad;
  end if;
end
$$;

-- Every link written from now on, for every role: after row-level security, like 0017's
-- kolab_ref_check, so an agent refused there learns nothing more.
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
create constraint trigger edge_within_parent after insert or update of target_version_id on edge
  for each row execute function kj_edge_within_parent();
