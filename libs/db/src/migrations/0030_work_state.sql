-- Migration 0030: work state, its event log and the lease (W5.1b; PLN3–PLN5, PLN12–PLN15, PLN17–PLN19, D98).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A work package is an element of a plan (KON5). Its state lives outside the plan's versions, so a
-- change of state makes no version and marks nothing (PLN4): one work_package row per element id a
-- plan has ever had, keyed by the plan and the element's stable id. Every change of state is a
-- work_event row, with its actor, its time and the versions it concerned (PLN5); events are never
-- edited or removed. Agents read their own kolab's work and never write it: every write is Kolab's,
-- as kj_system, after the engine's checks (ENF2, D98).
--
-- In progress is held by a lease, on the database's clock (D98): `lease_until`, set only while In
-- progress, `kolab.work_lease_s` after the pull or the assignee's last call. One actor holds at most
-- one package In progress, across every kolab (one_in_progress_per_actor, PLN18 as D98 reads it:
-- the limit is on pulling).
--
-- The plans that exist are brought in as they stand: a To do package for each element of each
-- plan's latest committed version, with an `added` event by that version's author.

-- How long a lease lasts in this kolab, in seconds (PLN15): 30 minutes unless the kolab sets another.
alter table kolab add column work_lease_s int not null default 1800
  constraint kolab_work_lease_check check (work_lease_s between 60 and 86400);

create table work_package (
  kolab_id     text not null references kolab(id),           -- the plan's, set on insert (kj_work_kolab)
  plan_node_id text not null,
  element_id   text not null,
  state        text not null default 'todo'
                 constraint work_package_state_check check (state in ('todo', 'in_progress', 'in_review', 'done')),   -- WORK_STATES in @konjir/types
  assignee_id  text references actor(id),
  lease_until  timestamptz,                                  -- set if and only if In progress (PLN15)
  unreviewed   boolean not null default false,               -- Done on submission with no reviewer (PLN16)
  milestone    boolean not null default false,               -- as the plan's latest committed version says (PLN3)
  removed_in_version_id text,                                -- PLN4: removal is a flag, not a state
  updated_at   timestamptz not null default clock_timestamp(),
  primary key (plan_node_id, element_id),
  constraint work_package_kolab_key unique (plan_node_id, element_id, kolab_id),
  constraint work_package_plan_kolab_fkey foreign key (plan_node_id, kolab_id) references node(id, kolab_id),
  constraint work_package_removed_kolab_fkey foreign key (removed_in_version_id, kolab_id) references version(id, kolab_id),
  constraint work_package_lease check ((state = 'in_progress') = (lease_until is not null)),
  -- A milestone is Kolab's to set, To do or Done, and has no assignee; any other package past To do has one.
  constraint work_package_assignee check (state = 'todo' or milestone or assignee_id is not null),
  constraint work_package_milestone check (not milestone or state in ('todo', 'done'))
);
-- PLN18, across kolabs (D98): an actor can't hold one package in each of several kolabs.
create unique index one_in_progress_per_actor on work_package(assignee_id) where state = 'in_progress';
create index work_package_ready on work_package(kolab_id, plan_node_id) where state = 'todo' and removed_in_version_id is null;
create index work_package_lapse on work_package(lease_until) where state = 'in_progress';
create index work_package_kolab on work_package(kolab_id);

create table work_event (
  id              text primary key,                          -- a ULID: events sort by when they happened
  kolab_id        text not null references kolab(id),        -- its package's, set on insert (kj_work_kolab)
  plan_node_id    text not null,
  element_id      text not null,
  kind            text not null
                    constraint work_event_kind_check check (kind in
                      ('added', 'removed', 'restored', 'pulled', 'released', 'reassigned', 'lapsed',
                       'evidence', 'submitted', 'approved', 'changes_requested', 'done_unreviewed', 'reopened', 'confirmed',
                       'milestone_done', 'milestone_reopened')),   -- WORK_EVENT_KINDS in @konjir/types
  from_state      text,
  to_state        text,
  actor_id        text not null constraint work_event_actor_check check (btrim(actor_id) <> ''),   -- `kolab` for Kolab's own (TEN14: no default)
  assignee_from   text,                                      -- who held the package before the change, if anyone
  assignee_to     text,                                      -- who holds it after, if anyone
  plan_version_id text not null,                             -- the plan version the package stood in
  concerned       jsonb not null,                            -- [{address, version_id, fingerprint}] of each element it delivers (PLN5)
  note            text,                                      -- free text, redactable
  at              timestamptz not null default clock_timestamp(),
  redacted_at     timestamptz,
  redacted_by     text,
  constraint work_event_concerned_check check (jsonb_typeof(concerned) = 'array'),
  constraint work_event_package_kolab_fkey foreign key (plan_node_id, element_id, kolab_id)
    references work_package(plan_node_id, element_id, kolab_id),
  constraint work_event_version_kolab_fkey foreign key (plan_version_id, kolab_id) references version(id, kolab_id)
);
create index work_event_of_package on work_event(plan_node_id, element_id, id);
create index work_event_kolab on work_event(kolab_id, id);
create index work_event_assignee_from on work_event(assignee_from, id) where assignee_from is not null;
create index work_event_assignee_to on work_event(assignee_to, id) where assignee_to is not null;

-- A work package belongs to its plan's kolab, and an event to its package's, whatever the writer gave.
create function kj_work_kolab() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_table_name = 'work_package' then
    new.kolab_id := (select n.kolab_id from node n where n.id = new.plan_node_id);
  else
    new.kolab_id := (select w.kolab_id from work_package w where w.plan_node_id = new.plan_node_id and w.element_id = new.element_id);
  end if;
  return new;
end
$$;
revoke execute on function kj_work_kolab() from public;
create trigger kolab_of_parent before insert on work_package for each row execute function kj_work_kolab();
create trigger kolab_of_parent before insert on work_event   for each row execute function kj_work_kolab();
create trigger kolab_fixed before update of kolab_id on work_package for each row execute function kj_kolab_fixed();
create trigger kolab_fixed before update of kolab_id on work_event   for each row execute function kj_kolab_fixed();

-- A package is never deleted: removing it from the plan is a flag (PLN4), and its events point at it.
create function kj_work_package_kept() returns trigger
language plpgsql as $$
begin
  raise exception 'work_package: a work package is never deleted; removing it from its plan flags it (PLN4)' using errcode = 'check_violation';
end
$$;
revoke execute on function kj_work_package_kept() from public;
create trigger work_package_kept before delete on work_package for each row execute function kj_work_package_kept();
create trigger work_package_kept_truncate before truncate on work_package for each statement execute function kj_work_package_kept();

-- Events are never edited or removed (PLN5), by any role. The one change retention may make is a
-- redaction, by Kolab's trusted role: the actor becomes `redacted`, the note goes, so do the
-- assignees (each to `redacted` or nothing), and who redacted it and when are recorded; the kind,
-- the time, the package and the versions stay.
create function kj_work_event_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_user = 'kj_system' and old.redacted_at is null and new.redacted_at is not null
     and new.redacted_by is not null and btrim(new.redacted_by) <> '' and new.actor_id = 'redacted' and new.note is null
     and (new.assignee_from is null or new.assignee_from = 'redacted') and (new.assignee_to is null or new.assignee_to = 'redacted')
     and (new.id, new.kolab_id, new.plan_node_id, new.element_id, new.kind, new.from_state, new.to_state, new.plan_version_id, new.concerned, new.at)
         is not distinct from
         (old.id, old.kolab_id, old.plan_node_id, old.element_id, old.kind, old.from_state, old.to_state, old.plan_version_id, old.concerned, old.at) then
    return new;
  end if;
  raise exception 'work_event: events are never edited or removed (PLN5); only Kolab redacts one''s actor and note' using errcode = 'check_violation';
end
$$;
revoke execute on function kj_work_event_fixed() from public;
create trigger work_event_fixed before update or delete on work_event for each row execute function kj_work_event_fixed();
create trigger work_event_kept before truncate on work_event for each statement execute function kj_work_event_fixed();

-- An archived kolab's work changes no more than the rest of its data (0014): its leases wait, and
-- lapse once it is unarchived.
create trigger kolab_writable_insert after insert on work_package referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on work_package referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_insert after insert on work_event referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on work_event referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on work_package referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on work_event referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

-- Row-level security. A session reads its own kolab's work, whatever its access there: a session
-- that holds only Read sees state, assignees and events too (D58). No other kolab's, ever: there is
-- no readable-kolabs policy, so a link or a fork from elsewhere shows no work (D49, LNK10). Only
-- Kolab's trusted role writes it (ENF2, D98): kj_agent is granted select alone, and no policy lets
-- it insert or update.
alter table work_package enable row level security;
alter table work_event   enable row level security;
create policy kolab_read on work_package for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy kolab_read on work_event   for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on work_package for all to kj_system using (true) with check (true);
create policy system_all on work_event   for all to kj_system using (true) with check (true);
grant select on work_package, work_event to kj_agent;
grant select, insert, update on work_package, work_event to kj_system;

-- The audit log's new action:
--   work_lease.set   a kolab's lease length changed (konjir_set_work_lease, PLN15): subject is the
--                    kolab; detail holds the seconds before and after
alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set'));   -- AUDIT_ACTIONS in @konjir/types

-- The plans that exist: a To do package for each element of each plan's latest committed version,
-- and its `added` event, by that version's author, naming the binding elements it delivers there
-- (its dependency links into the plan's binding, at element scope) at the binding's latest
-- committed version. Nothing else is written; an archived kolab's plans too (the migration runner
-- may write them).
insert into work_package(kolab_id, plan_node_id, element_id, milestone)
select v.kolab_id, v.node_id, e.element_id, coalesce((e.work->>'milestone')::boolean, false)
  from node n
  join lateral (select * from version lv where lv.node_id = n.id and lv.state = 'committed' order by lv.seq desc limit 1) v on true
  join element e on e.version_id = v.id
 where n.kind = 'plan';

insert into work_event(id, kolab_id, plan_node_id, element_id, kind, from_state, to_state, actor_id, plan_version_id, concerned, note)
select '0030' || lpad((row_number() over (order by v.node_id, e.ord, e.element_id))::text, 22, '0'),
       v.kolab_id, v.node_id, e.element_id, 'added', null, 'todo', v.actor_id, v.id,
       coalesce((select jsonb_agg(jsonb_build_object(
                          'address', 'kj:' || bn.name || '@' || bl.seq || '#' || d.target_element_id,
                          'version_id', bl.id,
                          'fingerprint', (select be.fingerprint from element be where be.version_id = bl.id and be.element_id = d.target_element_id))
                        order by d.target_element_id)
                   from (select distinct ed.target_element_id
                           from edge ed join version t on t.id = ed.target_version_id
                          where ed.source_version_id = v.id and ed.source_element_id = e.element_id and ed.kind = 'dependency'
                            and ed.target_element_id is not null and ed.target_selector is null and t.node_id = n.parent_node_id) d
                   join node bn on bn.id = n.parent_node_id
                   join lateral (select * from version x where x.node_id = bn.id and x.state = 'committed' order by x.seq desc limit 1) bl on true),
                '[]'::jsonb),
       'recorded by migration 0030: the work package was in the plan before Kolab kept work state'
  from node n
  join lateral (select * from version lv where lv.node_id = n.id and lv.state = 'committed' order by lv.seq desc limit 1) v on true
  join element e on e.version_id = v.id
 where n.kind = 'plan';
