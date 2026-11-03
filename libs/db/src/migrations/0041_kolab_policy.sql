-- Migration 0041: a kolab's autonomy policy (W6.2; AUT1–AUT5, AUT7, VER13; POL1–POL4, D103, D109).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- How far agents act without a person is a kolab's policy, set by its Admins (AUT1). It is one row
-- of settings, keyed by the kolab (POL1). A kolab without a row has D103's defaults, so no kolab
-- needs one, and this migration writes none: every kolab keeps the defaults until an Admin changes
-- a setting (konjir_set_policy). The defaults are DEFAULT_POLICY in @konjir/types; the columns'
-- defaults below say the same, for a row written with only some settings.
--
--   approve_functional          who approves functional versions (AUT2): person, other_person or agent
--   approve_technical           who approves technical versions (AUT2): agent, person or other_person
--   approve_work                who approves work packages (AUT3): agent or person
--   product_review_of_bindings  whether a binding version also needs a product approval (VER13)
--   answer_functional           who answers a question on the functional layer (AUT4): agent_cited or person
--   jobs_per_person, jobs_per_kolab   the job caps (AUT7); the engine never lets them exceed the server's own
--
-- `other_person` is a person other than the one whose intent the version carries: its author, or
-- the owner of the agent that wrote it. Each change is audited (policy.set) with its actor.

create table kolab_policy (
  kolab_id                   text primary key references kolab(id),
  approve_functional         text not null default 'person'
                               constraint kolab_policy_approve_functional check (approve_functional in ('agent', 'person', 'other_person')),
  approve_technical          text not null default 'agent'
                               constraint kolab_policy_approve_technical check (approve_technical in ('agent', 'person', 'other_person')),
  approve_work               text not null default 'agent'
                               constraint kolab_policy_approve_work check (approve_work in ('agent', 'person')),
  product_review_of_bindings boolean not null default false,
  answer_functional          text not null default 'agent_cited'
                               constraint kolab_policy_answer_functional check (answer_functional in ('agent_cited', 'person')),
  jobs_per_person            int not null default 4 constraint kolab_policy_jobs_per_person check (jobs_per_person between 1 and 1000),
  jobs_per_kolab             int not null default 8 constraint kolab_policy_jobs_per_kolab check (jobs_per_kolab between 1 and 1000),
  updated_by                 text not null constraint kolab_policy_updated_by check (btrim(updated_by) <> ''),
  updated_at                 timestamptz not null default clock_timestamp()
);
create trigger kolab_fixed before update of kolab_id on kolab_policy for each row execute function kj_kolab_fixed();
-- An archived kolab's policy is kept as it was, like the rest of its data (0014).
create trigger kolab_writable_insert after insert on kolab_policy referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_update after update on kolab_policy referencing new table as kj_rows
  for each statement execute function kj_kolab_writable();
create trigger kolab_writable_delete after delete on kolab_policy referencing old table as kj_rows
  for each statement execute function kj_kolab_writable();

-- Kolab reads and writes it on its own login; an agent reads its own kolab's, as it reads the rest
-- of the kolab's data, and never writes it (only a person who is an Admin there changes it, POL2).
alter table kolab_policy enable row level security;
create policy kolab_read on kolab_policy for select to kj_agent using (kolab_id = (select kj_session_kolab()));
create policy system_all on kolab_policy for all to kj_system using (true) with check (true);
grant select on kolab_policy to kj_agent;
grant select, insert, update on kolab_policy to kj_system;

-- ---- an answer's cites (AUT4, POL3) ----
-- What an answer rests on: committed element addresses, each pinned to its version, and ruling ids,
-- each checked by Kolab to exist and to be readable by whoever answered. An agent's answer to a
-- question on the functional layer always has some; any other answer may. Null for one with none.
alter table query add column answer_cites jsonb
  constraint query_answer_cites check (answer_cites is null or (jsonb_typeof(answer_cites) = 'array' and jsonb_array_length(answer_cites) between 1 and 20));

-- ---- a binding version's product review (VER13) ----
-- With product_review_of_bindings, a binding version needs, beside its technical approval, one from a
-- reviewer in a product session: `product` marks that request, and its verdict. A reviewer who may
-- give both holds one open request of each.
alter table review_request add column product boolean not null default false;
alter table review_request add constraint review_request_product check (not product or version_id is not null);
drop index one_open_request_per_reviewer;
create unique index one_open_request_per_reviewer on review_request(version_id, reviewer_id, product) where state = 'open';

-- ---- the audit log's new action ----
--   policy.set   an Admin changed the kolab's policy (konjir_set_policy, POL2): subject is the kolab;
--                detail holds each setting changed, its value before and after
alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set'));   -- AUDIT_ACTIONS in @konjir/types
