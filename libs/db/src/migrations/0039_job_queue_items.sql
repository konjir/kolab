-- Migration 0039: questions, marks and unserved spec elements as job items (W5.11; JOB6, D108).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- konjir_take_job takes three more kinds of item, after ready builds (JOB6): an open question or
-- note on a technical node (answer), an open mark on a technical node (mark), and a spec element that
-- no binding element serves (serve, PLN7). A job's item is one of its columns: a work package
-- (binding_node_id, element_id), a version (version_id), and now a question or note (query_id), a
-- mark (mark_id), or a spec element (spec_node_id, spec_element_id: a spec element is its node and
-- its element id, the same in every version). Exactly one, the one its kind takes. Each is leased to
-- one live job at a time, as a package and a version are (JOB1): a unique index each, which is what
-- keeps two takes at once from starting jobs on one item.
--
-- A job of a new kind that does its item ends answered (an answer job's agent answered the question,
-- or replied to the note), cleared (a mark job's agent cleared the mark), or submitted (a mark job's
-- agent submitted a redraft of the marked node, or a serve job's agent a binding version that serves
-- the element). JOB_KINDS and JOB_OUTCOMES in @konjir/types.
--
-- It adds nullable columns, widens three checks and adds indexes: every existing job is a build or a
-- review with its item where it was, so it can neither refuse a database nor change what is in one,
-- and needs no preflight. The unique key on query(id, kolab_id) is its primary key's, with the kolab.

alter table query add constraint query_id_kolab_key unique (id, kolab_id);

alter table job
  add column query_id        text,
  add column mark_id         text,
  add column spec_node_id    text,
  add column spec_element_id text,
  add constraint job_query_kolab_fkey foreign key (query_id, kolab_id) references query(id, kolab_id),
  add constraint job_mark_kolab_fkey foreign key (mark_id, kolab_id) references invalidation(id, kolab_id),
  add constraint job_spec_kolab_fkey foreign key (spec_node_id, kolab_id) references node(id, kolab_id);

alter table job drop constraint job_kind_check;
alter table job add constraint job_kind_check check (kind in ('build', 'review', 'answer', 'mark', 'serve'));   -- JOB_KINDS in @konjir/types
alter table job drop constraint job_outcome_check;
alter table job add constraint job_outcome_check check (outcome in ('submitted', 'reviewed', 'answered', 'cleared', 'released', 'lapsed', 'stopped'));   -- JOB_OUTCOMES

-- Exactly one item, the one its kind takes; only a review carries a review request.
alter table job drop constraint job_item;
alter table job add constraint job_item check (
  num_nonnulls(binding_node_id, version_id, query_id, mark_id, spec_node_id) = 1
  and (binding_node_id is null) = (element_id is null)
  and (spec_node_id is null) = (spec_element_id is null)
  and (kind = 'review' or review_request_id is null)
  and case kind
        when 'build'  then binding_node_id is not null
        when 'review' then binding_node_id is not null or version_id is not null
        when 'answer' then query_id is not null
        when 'mark'   then mark_id is not null
        when 'serve'  then spec_node_id is not null
        else false
      end);

-- JOB1, JOB6: each item has at most one live job.
create unique index one_live_job_per_query on job(query_id) where ended_at is null and query_id is not null;
create unique index one_live_job_per_mark on job(mark_id) where ended_at is null and mark_id is not null;
create unique index one_live_job_per_spec_element on job(spec_node_id, spec_element_id) where ended_at is null and spec_node_id is not null;

-- A job's item is fixed with the rest of what it was (0034's kj_job_fixed), the new columns too.
create or replace function kj_job_fixed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.ended_at is null
     and (new.id, new.kolab_id, new.person_id, new.runner_session_id, new.machine, new.agent_id, new.session_id, new.kind,
          new.binding_node_id, new.element_id, new.version_id, new.review_request_id, new.started_at,
          new.query_id, new.mark_id, new.spec_node_id, new.spec_element_id)
         is not distinct from
         (old.id, old.kolab_id, old.person_id, old.runner_session_id, old.machine, old.agent_id, old.session_id, old.kind,
          old.binding_node_id, old.element_id, old.version_id, old.review_request_id, old.started_at,
          old.query_id, old.mark_id, old.spec_node_id, old.spec_element_id) then
    return new;
  end if;
  raise exception 'job: a job is never deleted, and changes only its lease until it ends, once (JOB1)' using errcode = 'check_violation';
end
$$;
revoke execute on function kj_job_fixed() from public;
