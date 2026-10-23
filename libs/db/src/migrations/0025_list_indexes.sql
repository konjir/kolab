-- Indexes for paged lists and the common reads (W2.21, P13 and the rest of P7: D71, D76).
-- Every list is read a page at a time, ordered by a key that ends in the row's id, starting after
-- the last row of the page before (a keyset). Each index below serves one such read, or a read
-- the web interface and the verbs make on every call, so a kolab with many nodes, questions and
-- marks lists in time that grows with the page, not with the kolab.

-- Questions by kolab, state and id: konjir_list_queries (open ones by default, oldest first, by
-- id) and the inbox; and the web page's Open and Answered lists, newest first. Either covers
-- what query_kolab (0006) served, which goes.
create index query_kolab_state on query(kolab_id, state, id);
create index query_kolab_created on query(kolab_id, created_at, id);
drop index query_kolab;
-- Questions on a version: konjir_read_node's threads, a node's questions (node filters join
-- through its versions), settling a version's questions as it commits or is withdrawn.
create index query_version on query(version_id, state);
-- The questions an actor raised, by when: the ask rate (an actor's, and its owner's agents', in
-- the last hour), and konjir_list_queries mine=true and the answers resource, which then keep
-- the session's kolab's and sort them; an actor's own questions are few, held so by the rate.
create index query_raised_at on query(raised_by, created_at) where raised_by is not null;
-- The question a mark raised: every mark the web interface shows looks it up.
create index query_invalidation on query(invalidation_id) where invalidation_id is not null;

-- Versions by node and state: a node's latest committed version (read on nearly every verb),
-- its drafts and versions in review (konjir_list_nodes' counts), and later committed versions
-- (whether a version is live).
create index version_node_state on version(node_id, state, seq);
-- An author's submissions, newest first: konjir_list_reviews' yours and the answers resource.
create index version_actor_created on version(actor_id, kolab_id, created_at, id);
-- A kolab's versions as they were written: the web interface's activity, newest first.
create index version_kolab_created on version(kolab_id, created_at);

-- Open review requests by reviewer, oldest first: konjir_list_reviews' for_you and the inbox.
-- It covers what review_request_reviewer (0007) served, which it replaces.
create index review_request_reviewer_created on review_request(reviewer_id, created_at, id) where state = 'open';
drop index review_request_reviewer;
-- Review requests of a version: whether a version was submitted (an author's submissions), and
-- its verdicts.
create index review_request_version on review_request(version_id);
-- Verdicts as they were given, in a kolab: the activity.
create index review_request_kolab_decided on review_request(kolab_id, decided_at) where decided_at is not null;

-- Open marks in a kolab, oldest first: konjir_list_stale, the inbox and the web interface's marks.
create index invalidation_open_kolab on invalidation(kolab_id, created_at, id) where state = 'open';

-- Case files of a version (a node's case files, through its versions), and rulings in a kolab,
-- newest first: konjir_list_cases' node filter, konjir_list_rulings and the activity.
create index case_file_version on case_file(version_id);
create index ruling_kolab_ruled on ruling(kolab_id, ruled_at, id);

-- A kolab's nodes by kind, then name: konjir_list_nodes and the web interface's documents.
create index node_kolab_kind_name on node(kolab_id, kind, name);

-- The draft rate (MAX_DRAFTS_PER_HOUR): the versions an actor and its owner's agents wrote in the
-- last hour, across every kolab.
create index version_actor_at on version(actor_id, created_at);

-- Indexes the ones above now lead with, which go: node_kolab_kind_name, version_kolab_created and
-- ruling_kolab_ruled start with the kolab, as query_kolab_state does (dropped above).
drop index node_kolab;
drop index version_kolab;
drop index ruling_kolab;

-- The per-person rates (MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR), taken in the transaction that
-- writes the question or the version: a person and their agents share one budget, so an agent's
-- ask or draft counts against its owner. A lock per owner and kind, held until the transaction
-- ends, makes calls at once wait their turn, so the count each reads includes those committed
-- before it, and the limit holds. A draft counts only versions the budget's actors made: not
-- Kolab's folds, nor a ruling an admin applied as them (submitted_by, 0024). Returns the owner,
-- the count before this write, and the seconds until the oldest of them leaves the window.
create function kj_rate_take(p_actor text, p_kind text, p_window_ms bigint)
returns table (r_owner text, r_count int, r_wait_s int)
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner text;
  v_budget text[];
  v_since timestamptz := now() - p_window_ms * interval '1 millisecond';
begin
  select case when a.kind = 'agent' and a.owner_id is not null then a.owner_id else a.id end into v_owner
    from public.actor a where a.id = p_actor;
  v_owner := coalesce(v_owner, p_actor);
  perform pg_advisory_xact_lock(hashtextextended('kj_rate:' || p_kind || ':' || v_owner, 0));
  v_budget := array(select v_owner union select a.id from public.actor a where a.owner_id = v_owner);
  if p_kind = 'ask' then
    return query select v_owner, count(*)::int,
        ceil(extract(epoch from min(q.created_at) + p_window_ms * interval '1 millisecond' - now()))::int
      from public.query q where q.raised_by = any(v_budget) and q.created_at > v_since;
  else
    return query select v_owner, count(*)::int,
        ceil(extract(epoch from min(v.created_at) + p_window_ms * interval '1 millisecond' - now()))::int
      from public.version v
     where v.actor_id = any(v_budget) and v.created_at > v_since
       and (v.submitted_by is null or v.submitted_by = any(v_budget));
  end if;
end $$;
revoke execute on function kj_rate_take(text, text, bigint) from public;
grant execute on function kj_rate_take(text, text, bigint) to kj_agent, kj_system;

-- A kolab's invites, newest first: the web interface's People page, a page at a time.
create index kolab_invite_kolab_created on kolab_invite(kolab_id, created_at, id);
