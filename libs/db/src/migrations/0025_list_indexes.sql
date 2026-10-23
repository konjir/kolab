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

-- The per-person rates (MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR): a person and their agents share
-- one budget, so an agent's ask or draft counts against its owner. A call takes its place in the
-- budget in a short transaction of its own, before it writes: kj_rate_take locks the owner's
-- budget for that kind, counts what the budget wrote in the window plus the places held for writes
-- still under way (rate_hold), and, under the limit, holds one more. The lock is held for that
-- count and insert only, never for the write, so a burst of one person's calls waits its turn for
-- milliseconds and never holds the connections everyone else needs; a wait past lock_timeout is
-- refused as busy. The write then releases its hold (kj_rate_release) in the transaction that
-- writes the question or the version, so the hold becomes the row in one commit and the limit holds
-- exactly; a write that fails releases it after, and a hold its process never released (a crash)
-- stops counting after ten minutes. A draft counts only versions the budget's actors made: not
-- Kolab's folds, nor a ruling an admin applied as them (submitted_by, 0024). Returns the owner,
-- the count before this call, the seconds until the oldest of them leaves the window, and the
-- hold, or null when the count is at `p_max` already and nothing was held.
create table rate_hold (
  id         text primary key,
  owner_id   text not null,
  kind       text not null check (kind in ('ask', 'draft')),
  created_at timestamptz not null default now()
);
create index rate_hold_owner on rate_hold(owner_id, kind, created_at);
-- Only these functions read or write it: no session's role is granted it.
alter table rate_hold enable row level security;

create function kj_rate_take(p_actor text, p_kind text, p_window_ms bigint, p_max int)
returns table (r_owner text, r_count int, r_wait_s int, r_hold text)
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner text;
  v_budget text[];
  v_since timestamptz := now() - p_window_ms * interval '1 millisecond';
  v_stale timestamptz := now() - interval '10 minutes';
  v_count int;
  v_oldest timestamptz;
  v_hold text;
begin
  select case when a.kind = 'agent' and a.owner_id is not null then a.owner_id else a.id end into v_owner
    from public.actor a where a.id = p_actor;
  v_owner := coalesce(v_owner, p_actor);
  perform set_config('lock_timeout', '5s', true);
  perform pg_advisory_xact_lock(hashtextextended('kj_rate:' || p_kind || ':' || v_owner, 0));
  delete from public.rate_hold h where h.owner_id = v_owner and h.kind = p_kind and h.created_at <= v_stale;
  v_budget := array(select v_owner union select a.id from public.actor a where a.owner_id = v_owner);
  -- What was written and what is held, in one statement, so one snapshot: a write that commits
  -- (its row in, its hold gone) is counted once, whenever it commits.
  select count(*)::int, min(w.at) into v_count, v_oldest from (
    select q.created_at as at from public.query q
     where p_kind = 'ask' and q.raised_by = any(v_budget) and q.created_at > v_since
    union all
    select v.created_at from public.version v
     where p_kind = 'draft' and v.actor_id = any(v_budget) and v.created_at > v_since
       and (v.submitted_by is null or v.submitted_by = any(v_budget))
    union all
    select h.created_at from public.rate_hold h where h.owner_id = v_owner and h.kind = p_kind
  ) w;
  if v_count < p_max then
    v_hold := p_kind || ':' || v_owner || ':' || md5(random()::text || clock_timestamp()::text);
    insert into public.rate_hold(id, owner_id, kind) values (v_hold, v_owner, p_kind);
  end if;
  return query select v_owner, v_count,
    ceil(extract(epoch from v_oldest + p_window_ms * interval '1 millisecond' - now()))::int, v_hold;
end $$;
revoke execute on function kj_rate_take(text, text, bigint, int) from public;
grant execute on function kj_rate_take(text, text, bigint, int) to kj_agent, kj_system;

-- Releases a hold kj_rate_take gave: in the transaction that writes what it was held for, or
-- after that transaction failed.
create function kj_rate_release(p_hold text) returns void
language sql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
  delete from public.rate_hold where id = p_hold;
$$;
revoke execute on function kj_rate_release(text) from public;
grant execute on function kj_rate_release(text) to kj_agent, kj_system;

-- A version's changes, by element: deltas() reads a version's, and a commit's cascade matches an
-- override mark to the new version's change of the same element (P7). Neither had an index, so
-- each read the whole table.
create index delta_version on delta(version_id, element_id);

-- A kolab's invites, newest first: the web interface's People page, a page at a time.
create index kolab_invite_kolab_created on kolab_invite(kolab_id, created_at, id);
