-- Migration 0033: work planned in the binding (W5.1d; KON5, KON6, KON8, PLN1, PLN2, PLN4, PLN20, D104).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- The plan kind is retired (D104). A work package is a binding element that is work to do: one with
-- a work field. Every other binding element is a decision, which is never work. So the work field,
-- and the state, events, evidence and review requests 0029–0032 keyed to a plan's elements, are keyed
-- to the binding's elements now, and a binding version's work fields pass PLN2's checks at submit and
-- are then reviewed like any binding version (the engine's).
--
-- Each plan's packages move onto its binding (its parent, D78), in one new committed version of the
-- binding, written by Kolab (`kolab`, in the system role, as its own rebases are): the binding's
-- latest committed version with the plan's latest committed elements added after its own, with
-- their text, their place under each other, their work fields and their links into the binding.
--
--   - Each package keeps its element id, unless the binding has ever had an element of that id (in
--     any version: an element id is stable, so it would revive that element's history and links).
--     Then it becomes <plan name>.<id>, such as kolab-plan.W1.2, and every Depends on that names it
--     is rewritten. If that id is taken too, the migration stops, naming it.
--   - A plan element with no work field becomes a work package whose fields are still to be given
--     (`{}`): in a binding, an element with no work field would be a decision.
--   - Every moved element's fingerprint is worked out again, as the engine's elementFingerprint
--     does (work.ts): its fields changed if a Depends on was renamed or it gained `{}`.
--   - Its links into the binding (Delivers, D98) move with it, from the plan's latest committed version
--     to the binding's new one: it relies on those decisions now (PLN1). Their open marks move too,
--     so a package at risk stays at risk (PLN10). A link between two of the plan's packages (written
--     before D99) and a link from the whole plan version stay with the plan, as history.
--   - Its state, assignee, lease, events, evidence and review requests are kept as they are, keyed
--     to the binding and the package's id there. Its events still name the plan versions they stood
--     in, and the addresses they concerned then.
--   - work_package_moved records each move, so kj:<kolab>/<plan>#<id>, in an old address or a commit
--     trailer (Konjir-Work), still names the package.
--   - A plan's draft, or its version in review, is rejected, saying why: a plan takes no new version.
--     So is a draft or a version in review of a binding that receives packages, or of one of its
--     variants and forks: a variant's would otherwise be folded onto the new version, dropping them.
--   - A mark on a link that stays with the plan is settled, its question answered.
--   - The new version's cascade is queued (an after_commit job), as any commit's is, so its variants
--     and forks are rebased onto it, and links into the binding catch up, once Kolab starts.
--
-- Then the kind is retired: no role creates a node of kind plan, or writes a version of one. Plans
-- stay, read-only, as history; a binding's at-most-one-plan index goes with them (KON5, D96).

-- ---------------------------------------------------------------------------
-- What can't be moved, refused before anything changes
-- ---------------------------------------------------------------------------

-- One query finds every refusal, on the database as 0032 leaves it, and deploy/preflight/0033.sql
-- runs the same query, text for text (libs/engine/test/migrations.test.ts compares them), so it
-- returns no rows exactly when this migration applies.
do $$
declare bad text;
begin
  select string_agg(format(case q.ord
      when 1 then 'A job Kolab still owes (in the outbox, waiting or dead) would run on a plan after 0033 retires it, or carry a binding''s links forward after the version 0033 writes, and lose them: %s. Let the outbox drain first, retrying a dead job with konjir_admin_outbox retry=<id>.'
      when 2 then 'A plan''s package moves onto its binding as <plan>.<id> when the binding has had an element of its id, and these names are taken too, by the binding or by another of the plan''s packages: %s. Decide what each package is called, and draft the plan with it renamed, before 0033 applies.'
    end, q.items), ' ' order by q.ord) into bad
    from (
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
    ) q;
  if bad is not null then
    raise exception 'migration 0033: % Each needs doing before 0033 applies; deploy/preflight/0033.sql lists the same (deploy/konjir-ops.sh preflight 0033).', bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- An element's fingerprint, as the engine computes it (elementFingerprint, work.ts), for the
-- elements this migration writes. Dropped at the end.
-- ---------------------------------------------------------------------------

-- normalize(): every run of what JavaScript's \s matches becomes one space, trimmed.
create function kj_0033_normalize(t text) returns text
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select btrim(regexp_replace(t, '[\t\n\v\f\r    -     　﻿]+', ' ', 'g'), ' ')
$$;

-- With no work fields, the hash of the normalized text; with them, of that text, a newline and the
-- fields' canonical JSON (canonicalWork: keys sorted, Depends on sorted, a done-when normalized).
-- base64url, its first 22 characters.
create function kj_0033_fingerprint(t text, w jsonb) returns text
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select left(translate(encode(sha256(convert_to(
           case when w is null then kj_0033_normalize(t)
                else kj_0033_normalize(t) || E'\n' || '{' || coalesce((
                  select string_agg(format('"%s":%s', k,
                           case k when 'depends_on' then (select '[' || string_agg(to_json(x #>> '{}')::text, ',' order by x #>> '{}' collate "C") || ']'
                                                           from jsonb_array_elements(w->'depends_on') x)
                                  when 'done_when' then to_json(kj_0033_normalize(w->>'done_when'))::text
                                  when 'milestone' then 'true'
                                  else to_json(w->>k)::text end), ',' order by k collate "C")
                    from jsonb_object_keys(w) k), '') || '}' end, 'UTF8')), 'base64'), '+/', '-_'), 22)
$$;

-- ---------------------------------------------------------------------------
-- The plans, and where each package goes
-- ---------------------------------------------------------------------------

-- Each plan, its latest committed version and its binding's, and the binding version this writes.
create table kj_0033_plan as
select p.id, p.name, p.kolab_id, p.parent_node_id as binding,
       (select v.id from version v where v.node_id = p.id and v.state = 'committed' order by v.seq desc limit 1) as plan_version,
       (select v.id from version v where v.node_id = p.parent_node_id and v.state = 'committed' order by v.seq desc limit 1) as binding_version,
       null::text as new_version
  from node p where p.kind = 'plan';
update kj_0033_plan p set new_version = '0033v' || lpad(n::text, 21, '0')
  from (select id, row_number() over (order by kolab_id, name) as n from kj_0033_plan where plan_version is not null) x
 where x.id = p.id;

-- Each package a plan has had, and its id in the binding.
create table kj_0033_moved as
select w.kolab_id, w.plan_node_id as plan, w.element_id as plan_element, p.binding,
       case when exists (select 1 from element e join version v on v.id = e.version_id where v.node_id = p.binding and e.element_id = w.element_id)
            then p.name || '.' || w.element_id else w.element_id end as element_id
  from work_package w join kj_0033_plan p on p.id = w.plan_node_id;

-- ---------------------------------------------------------------------------
-- Open versions that would lose what moves: rejected, saying why
-- ---------------------------------------------------------------------------

-- A plan's drafts and versions in review: a plan takes no new version. And those of each binding
-- that receives packages, and of its variants and forks: built on the version before 0033's, a
-- binding's would go back stale, but a variant's would be folded onto Kolab's newer version, its
-- own elements kept and the moved packages dropped, flagging them removed. deploy/preflight/0033.sql
-- lists the same versions, text for text.
create table kj_0033_rejected as
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
update review_request r set state = 'withdrawn', decided_at = now()
  from kj_0033_rejected x where r.version_id = x.id and r.state = 'open';
update version v set state = 'rejected',
       review_note = case when x.kind = 'plan'
         then 'rejected by migration 0033: the plan kind is retired (D104), so a plan takes no new version. Its work packages moved onto its binding: draft them there'
         else 'rejected by migration 0033: a plan''s work packages moved into a binding this was built on, in a version Kolab wrote (D104), which this one would have dropped: redraft it on the latest version' end
  from kj_0033_rejected x where v.id = x.id;

-- ---------------------------------------------------------------------------
-- Work fields are a binding's now
-- ---------------------------------------------------------------------------

-- Work fields only on a binding's elements, for every role (0029's rule, moved from plans).
drop trigger element_work_plan_only on element;
drop trigger delta_work_plan_only on delta;
drop function kj_element_work_plan_only();
create function kj_element_work_binding_only() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n record;
begin
  if new.work is null then return null; end if;
  select n2.name, n2.kind into n from public.version v join public.node n2 on n2.id = v.node_id where v.id = new.version_id;
  if n.kind is distinct from 'binding' then
    raise exception '%: work fields (done_when, depends_on, size, milestone, target_date, repo) are only on a binding''s elements, its work packages (PLN1, D104); % is a %',
      tg_table_name, n.name, n.kind using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_element_work_binding_only() from public;
create constraint trigger element_work_binding_only after insert or update of work, version_id on element
  for each row execute function kj_element_work_binding_only();
create constraint trigger delta_work_binding_only after insert or update of work, version_id on delta
  for each row execute function kj_element_work_binding_only();

-- A work package with no fields yet is `{}` (0029 refused it): a work field, so not a decision.
alter table element drop constraint element_work_valid;
alter table delta   drop constraint delta_work_valid;
create or replace function kj_work_valid(w jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare d date;
begin
  if w is null then return true; end if;
  if jsonb_typeof(w) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(w) k
              where k not in ('done_when', 'depends_on', 'size', 'milestone', 'target_date', 'repo')) then
    return false;
  end if;
  if w ? 'done_when' and (jsonb_typeof(w->'done_when') <> 'string' or char_length(w->>'done_when') not between 1 and 4000) then
    return false;
  end if;
  if w ? 'depends_on' then
    if jsonb_typeof(w->'depends_on') <> 'array' or jsonb_array_length(w->'depends_on') not between 1 and 50 then return false; end if;
    if exists (select 1 from jsonb_array_elements(w->'depends_on') x where jsonb_typeof(x) <> 'string' or x #>> '{}' = '') then
      return false;
    end if;
    if (select count(distinct x #>> '{}') from jsonb_array_elements(w->'depends_on') x) <> jsonb_array_length(w->'depends_on') then
      return false;
    end if;
  end if;
  if w ? 'size' and (jsonb_typeof(w->'size') <> 'string' or w->>'size' not in ('S', 'M', 'L')) then
    return false;
  end if;
  if w ? 'milestone' and w->'milestone' <> 'true'::jsonb then return false; end if;
  if w ? 'repo' and (jsonb_typeof(w->'repo') <> 'string' or char_length(w->>'repo') not between 1 and 200) then
    return false;
  end if;
  if w ? 'target_date' then
    if not w ? 'milestone' or jsonb_typeof(w->'target_date') <> 'string' or w->>'target_date' !~ '^\d{4}-\d{2}-\d{2}$' then
      return false;
    end if;
    begin
      d := (w->>'target_date')::date;
    exception when others then
      return false;
    end;
    if to_char(d, 'YYYY-MM-DD') <> w->>'target_date' then return false; end if;
  end if;
  return true;
end
$$;
alter table element add constraint element_work_valid check (kj_work_valid(work));
alter table delta   add constraint delta_work_valid   check (kj_work_valid(work));

-- ---------------------------------------------------------------------------
-- The binding's new version, with the plan's packages added
-- ---------------------------------------------------------------------------

-- A binding that is a variant keeps its foreign parent, as the engine's next draft would; any other
-- builds on its own latest version.
insert into version(id, node_id, seq, parent_version_id, base_version_id, layer, state, actor_id, active_role, review_note, submitted_by, parent_held_by)
select p.new_version, p.binding, (select coalesce(max(x.seq), 0) + 1 from version x where x.node_id = p.binding),
       case when pv.node_id is not null and pv.node_id <> p.binding then bv.parent_version_id else bv.id end,
       bv.id, 'technical', 'committed', 'kolab', 'system',
       format('Written by migration 0033 (D104): the plan kind is retired, and plan %s''s work packages moved onto this binding, each with its state and history.', p.name),
       'kolab',
       case when pv.node_id is not null and pv.node_id <> p.binding then bv.parent_held_by end
  from kj_0033_plan p
  left join version bv on bv.id = p.binding_version
  left join version pv on pv.id = bv.parent_version_id
 where p.new_version is not null;

-- The binding's own elements, as they were.
insert into element(version_id, element_id, parent_element_id, ord, text, fingerprint, work)
select p.new_version, e.element_id, e.parent_element_id, e.ord, e.text, e.fingerprint, e.work
  from kj_0033_plan p join element e on e.version_id = p.binding_version
 where p.new_version is not null;

-- The plan's, after them: ids, parents and Depends on as they move, and every package a work field.
create table kj_0033_added as
select p.new_version, p.binding_version, m.element_id, pm.element_id as parent_element_id,
       (select coalesce(max(b.ord), -1) from element b where b.version_id = p.binding_version) + 1 + e.ord as ord,
       e.text,
       case when e.work is null then '{}'::jsonb
            when e.work ? 'depends_on' then jsonb_set(e.work, '{depends_on}', (
              select jsonb_agg(coalesce(dm.element_id, d #>> '{}') order by i)
                from jsonb_array_elements(e.work->'depends_on') with ordinality as x(d, i)
                left join kj_0033_moved dm on dm.plan = p.id and dm.plan_element = d #>> '{}'))
            else e.work end as work
  from kj_0033_plan p
  join element e on e.version_id = p.plan_version
  join kj_0033_moved m on m.plan = p.id and m.plan_element = e.element_id
  left join kj_0033_moved pm on pm.plan = p.id and pm.plan_element = e.parent_element_id
 where p.new_version is not null;

insert into element(version_id, element_id, parent_element_id, ord, text, fingerprint, work)
select new_version, element_id, parent_element_id, ord, text, kj_0033_fingerprint(text, work), work from kj_0033_added;

-- What the version changes from its parent: an add for each package, after a variant's own
-- exceptions, which it carries.
insert into delta(id, version_id, element_id, kind, text, parent_element_id, ord, base_version_id, base_fingerprint, state, work)
select '0033d' || lpad((row_number() over (order by x.version_id, x.n, x.element_id))::text, 21, '0'),
       x.version_id, x.element_id, x.kind, x.text, x.parent_element_id, x.ord, x.base_version_id, x.base_fingerprint, x.state, x.work
  from (
    select p.new_version as version_id, 0 as n, d.element_id, d.kind, d.text, d.parent_element_id, d.ord, d.base_version_id, d.base_fingerprint, d.state, d.work
      from kj_0033_plan p join version nv on nv.id = p.new_version join delta d on d.version_id = p.binding_version
     where nv.parent_version_id is distinct from p.binding_version
    union all
    select a.new_version, 1, a.element_id, 'add', a.text, a.parent_element_id, a.ord, null, null, 'clean', a.work from kj_0033_added a
  ) x;

-- ---------------------------------------------------------------------------
-- Links and marks follow, as a commit's supersedePrevious carries them
-- ---------------------------------------------------------------------------

-- The binding's own links carry forward to its new version, and their open marks move with them.
create table kj_0033_edge as
select e.id as old_id, '0033e' || lpad((row_number() over (order by e.id))::text, 21, '0') as new_id, p.new_version
  from kj_0033_plan p join edge e on e.source_version_id = p.binding_version
 where p.new_version is not null;
insert into edge(id, kind, source_version_id, source_element_id, target_version_id, target_element_id, target_selector, target_fingerprint, held_by)
select m.new_id, e.kind, m.new_version, e.source_element_id, e.target_version_id, e.target_element_id, e.target_selector, e.target_fingerprint, e.held_by
  from kj_0033_edge m join edge e on e.id = m.old_id;
update invalidation i set edge_id = m.new_id from kj_0033_edge m where i.edge_id = m.old_id and i.state = 'open';
-- Marks on an override follow it, to the delta of the same element; every other open mark moves.
update invalidation i set version_id = p.new_version, delta_id = nd.id
  from kj_0033_plan p, delta od, delta nd
 where i.version_id = p.binding_version and i.state = 'open' and i.delta_id = od.id
   and nd.version_id = p.new_version and nd.element_id = od.element_id;
update invalidation i set version_id = p.new_version
  from kj_0033_plan p
 where i.version_id = p.binding_version and i.state = 'open' and i.delta_id is null and p.new_version is not null;

-- Each package's links into its binding move with it, and their open marks, and every other open mark
-- on the package itself, to its element in the binding's new version: a package at risk stays so.
create table kj_0033_edge_moved as
select e.id, p.new_version, m.element_id
  from edge e, kj_0033_plan p, kj_0033_moved m, version t
 where e.source_version_id = p.plan_version and p.new_version is not null
   and m.plan = p.id and m.plan_element = e.source_element_id
   and t.id = e.target_version_id and t.node_id = p.binding;
update edge e set source_version_id = x.new_version, source_element_id = x.element_id
  from kj_0033_edge_moved x where e.id = x.id;
update invalidation i set version_id = p.new_version, element_id = m.element_id
  from kj_0033_plan p, kj_0033_moved m
 where i.version_id = p.plan_version and p.new_version is not null and i.state = 'open' and i.delta_id is null
   and m.plan = p.id and m.plan_element = i.element_id
   and (i.edge_id is null or i.edge_id in (select id from kj_0033_edge_moved));
-- A mark on a link that stays with the plan (one between two of its packages, or from the whole plan
-- version) is settled: the link is history now, and no cascade follows it again. Its question too.
create table kj_0033_settled as
select i.id from invalidation i join version v on v.id = i.version_id join node n on n.id = v.node_id
 where n.kind = 'plan' and i.state = 'open' and i.edge_id is not null and i.edge_id not in (select id from kj_0033_edge_moved);
update invalidation set state = 'cleared', cleared_by = 'settled by migration 0033: its link stays on the plan, as history, since the plan kind is retired (D104)'
 where id in (select id from kj_0033_settled);
update query set state = 'answered', answered_by = 'kolab',
       answer = 'settled by migration 0033: the mark that asked this was on a link that stays on the plan, as history (D104)'
 where invalidation_id in (select id from kj_0033_settled) and state = 'open';

-- The version's cascade is owed, as any commit's: its variants' rebases, and the catch-up of every
-- link into the binding, run once Kolab starts (onCommit).
insert into outbox(id, kind, version_id)
select '0033o' || lpad((row_number() over (order by new_version))::text, 21, '0'), 'after_commit', new_version
  from kj_0033_plan where new_version is not null;

-- ---------------------------------------------------------------------------
-- Work state, events, evidence and review requests: keyed to the binding
-- ---------------------------------------------------------------------------

alter table work_event   drop constraint work_event_package_kolab_fkey;
alter table evidence     drop constraint evidence_package_kolab_fkey;
alter table review_request drop constraint review_request_work_kolab_fkey;
alter table repository   drop constraint repository_confirmed_work_fkey;
-- Events, evidence and a confirmed repository never change, for any role (0030–0032); this
-- migration re-keys them, and changes nothing else about them.
alter table work_event disable trigger work_event_fixed;
alter table evidence   disable trigger evidence_fixed;
alter table repository disable trigger repository_fixed;

update work_package w set plan_node_id = m.binding, element_id = m.element_id
  from kj_0033_moved m where w.plan_node_id = m.plan and w.element_id = m.plan_element;
update work_event x set plan_node_id = m.binding, element_id = m.element_id
  from kj_0033_moved m where x.plan_node_id = m.plan and x.element_id = m.plan_element;
update evidence x set plan_node_id = m.binding, element_id = m.element_id
  from kj_0033_moved m where x.plan_node_id = m.plan and x.element_id = m.plan_element;
update review_request x set plan_node_id = m.binding, element_id = m.element_id
  from kj_0033_moved m where x.plan_node_id = m.plan and x.element_id = m.plan_element;
update repository x set confirmed_plan_node_id = m.binding, confirmed_element_id = m.element_id
  from kj_0033_moved m where x.confirmed_plan_node_id = m.plan and x.confirmed_element_id = m.plan_element;

alter table work_package   rename column plan_node_id to binding_node_id;
alter table work_package   rename constraint work_package_plan_kolab_fkey to work_package_binding_kolab_fkey;
alter table work_event     rename column plan_node_id to binding_node_id;
-- The version an event stood in: a plan's, for an event recorded before this migration; a binding's after.
alter table work_event     rename column plan_version_id to version_id;
alter table evidence       rename column plan_node_id to binding_node_id;
alter table review_request rename column plan_node_id to binding_node_id;
alter table repository     rename column confirmed_plan_node_id to confirmed_binding_node_id;

alter table work_event add constraint work_event_package_kolab_fkey foreign key (binding_node_id, element_id, kolab_id)
  references work_package(binding_node_id, element_id, kolab_id);
alter table evidence add constraint evidence_package_kolab_fkey foreign key (binding_node_id, element_id, kolab_id)
  references work_package(binding_node_id, element_id, kolab_id);
alter table review_request add constraint review_request_work_kolab_fkey foreign key (binding_node_id, element_id, kolab_id)
  references work_package(binding_node_id, element_id, kolab_id);
alter table repository add constraint repository_confirmed_work_fkey foreign key (confirmed_binding_node_id, confirmed_element_id, kolab_id)
  references work_package(binding_node_id, element_id, kolab_id);

-- The functions that name the renamed columns, as they were with the new names.
create or replace function kj_work_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_table_name = 'work_package' then
    new.kolab_id := (select n.kolab_id from node n where n.id = new.binding_node_id);
  else
    new.kolab_id := (select w.kolab_id from work_package w where w.binding_node_id = new.binding_node_id and w.element_id = new.element_id);
  end if;
  return new;
end
$$;

create or replace function kj_review_request_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.version_id is not null then
    new.kolab_id := (select v.kolab_id from version v where v.id = new.version_id);
  else
    new.kolab_id := (select w.kolab_id from work_package w where w.binding_node_id = new.binding_node_id and w.element_id = new.element_id);
  end if;
  return new;
end
$$;

create or replace function kj_work_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.actor_id = 'redacted' and new.note is null
     and (new.assignee_from is null or new.assignee_from = 'redacted') and (new.assignee_to is null or new.assignee_to = 'redacted')
     and (new.id, new.kolab_id, new.binding_node_id, new.element_id, new.kind, new.from_state, new.to_state, new.version_id, new.concerned, new.at)
         is not distinct from
         (old.id, old.kolab_id, old.binding_node_id, old.element_id, old.kind, old.from_state, old.to_state, old.version_id, old.concerned, old.at) then
    return new;
  end if;
  raise exception 'work_event: events are never edited or removed (PLN5); only Kolab redacts one''s actor and note' using errcode = 'check_violation';
end
$$;

create or replace function kj_evidence_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.title is null and new.files is null
     and (new.id, new.kolab_id, new.binding_node_id, new.element_id, new.event_id, new.kind, new.ref, new.url, new.recorded_by, new.at,
          new.repository_id, new.before_repositories)
         is not distinct from
         (old.id, old.kolab_id, old.binding_node_id, old.element_id, old.event_id, old.kind, old.ref, old.url, old.recorded_by, old.at,
          old.repository_id, old.before_repositories) then
    return new;
  end if;
  raise exception 'evidence: evidence is never edited or removed (PLN5); only Kolab redacts its text' using errcode = 'check_violation';
end
$$;

create or replace function kj_repository_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and (new.id, new.kolab_id, new.url, new.root_sha, new.binding_node_id, new.registered_by, new.registered_at)
         is not distinct from (old.id, old.kolab_id, old.url, old.root_sha, old.binding_node_id, old.registered_by, old.registered_at)
     and (old.confirmed_at is null or (new.confirmed_by, new.confirmed_at, new.confirmed_binding_node_id, new.confirmed_element_id)
          is not distinct from (old.confirmed_by, old.confirmed_at, old.confirmed_binding_node_id, old.confirmed_element_id))
     and (old.archived_at is null or (new.archived_by, new.archived_at) is not distinct from (old.archived_by, old.archived_at)) then
    return new;
  end if;
  raise exception 'repository: a repository''s URL, root commit, binding and registration never change, it is confirmed and archived once, and it is never removed (D98)'
    using errcode = 'check_violation';
end
$$;

alter table work_event enable trigger work_event_fixed;
alter table evidence   enable trigger evidence_fixed;
alter table repository enable trigger repository_fixed;

-- ---------------------------------------------------------------------------
-- Old addresses keep naming the package (Konjir-Work trailers, D98)
-- ---------------------------------------------------------------------------

-- Each package a plan had, and where it went: kj:<kolab>/<plan>#<id> resolves through it. Written
-- once, here; read by the kolab's sessions, as its work is (0030).
create table work_package_moved (
  kolab_id        text not null references kolab(id),
  plan_node_id    text not null,
  plan_element_id text not null,
  binding_node_id text not null,
  element_id      text not null,
  primary key (plan_node_id, plan_element_id),
  constraint work_package_moved_plan_kolab_fkey foreign key (plan_node_id, kolab_id) references node(id, kolab_id),
  constraint work_package_moved_package_kolab_fkey foreign key (binding_node_id, element_id, kolab_id)
    references work_package(binding_node_id, element_id, kolab_id)
);
insert into work_package_moved(kolab_id, plan_node_id, plan_element_id, binding_node_id, element_id)
select kolab_id, plan, plan_element, binding, element_id from kj_0033_moved;

create trigger kolab_fixed before update of kolab_id on work_package_moved for each row execute function kj_kolab_fixed();
create trigger kolab_writable_insert after insert on work_package_moved referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on work_package_moved referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on work_package_moved referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

alter table work_package_moved enable row level security;
create policy kolab_read on work_package_moved for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on work_package_moved for all to kj_system using (true) with check (true);
grant select on work_package_moved to kj_agent, kj_system;

-- ---------------------------------------------------------------------------
-- The plan kind is retired (D104)
-- ---------------------------------------------------------------------------

-- No role creates a plan, or writes a version of one; a later migration may (kj_migrating).
create function kj_plan_retired() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if public.kj_migrating() then return new; end if;
  if tg_table_name = 'node' then
    if new.kind = 'plan' then
      raise exception 'node: the plan kind is retired (D104): work is planned in the binding, where a work package is an element with a work field'
        using errcode = 'check_violation';
    end if;
  elsif exists (select 1 from public.node n where n.id = new.node_id and n.kind = 'plan') then
    raise exception 'version: the plan kind is retired (D104), so a plan takes no new version: its work packages are its binding''s now'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_plan_retired() from public;
create trigger node_kind_retired before insert on node for each row execute function kj_plan_retired();
create trigger version_kind_retired before insert on version for each row execute function kj_plan_retired();

-- A binding holds its own work: no plan, and so no rule of one plan per binding (KON5, D104).
drop index node_one_plan_per_binding;

drop table kj_0033_rejected;
drop table kj_0033_edge_moved;
drop table kj_0033_settled;
drop table kj_0033_added;
drop table kj_0033_edge;
drop table kj_0033_moved;
drop table kj_0033_plan;
drop function kj_0033_fingerprint(text, jsonb);
drop function kj_0033_normalize(text);
