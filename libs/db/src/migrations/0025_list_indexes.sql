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
-- The questions an actor raised, by when: konjir_list_queries mine=true and the answers resource,
-- which then keep the session's kolab's and sort them; an actor's own questions are few, held so by
-- the ask rate (counted in rate_event, below).
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

-- Indexes the ones above now lead with, which go: node_kolab_kind_name, version_kolab_created and
-- ruling_kolab_ruled start with the kolab, as query_kolab_state does (dropped above).
drop index node_kolab;
drop index version_kolab;
drop index ruling_kolab;

-- The rates (MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR; MAX_ORG_ASKS_PER_HOUR, MAX_ORG_DRAFTS_PER_HOUR): a
-- person and their agents share one budget, so an agent's ask or draft counts against its owner; an
-- organization's agents share the organization's, which has a limit of its own. The budget counts
-- events: each question or note raised, and each draft made, is a row here from the moment the call
-- takes its place, whatever then happens to what it wrote. A draft counts when it is made, whoever
-- submits it, and whether it is approved, rejected, folded or abandoned. Only the calls that take a
-- place are counted: an admin's applied ruling and Kolab's rebases and folds take none.
-- A call takes its place in a short transaction of its own, before it writes: kj_rate_take locks the
-- owner's budget for that kind, counts the budget's events in the window, held ones included, and,
-- under the limit, holds one more. The lock is held for that count and insert only, never for the
-- write, so a burst of one person's calls waits its turn for milliseconds and never holds the
-- connections everyone else needs; a wait past lock_timeout is refused as busy. The write then marks
-- its event used (kj_rate_use) in the transaction that writes the question or the version, so the
-- event stays counted from its take to the end of the window and the limit holds exactly; a write
-- that fails gives its place back (kj_rate_release), a hold its process never gave back (a
-- crash) stops counting after ten minutes, and a write that commits after its hold was pruned is
-- counted all the same (kj_rate_use). Returns the owner, whether it is an organization, the
-- limit applied, the count before this call, the seconds until the oldest of them leaves the window,
-- and the hold, or null when the count is at the limit already and nothing was held.
create table rate_event (
  id         text primary key,
  owner_id   text not null,
  kind       text not null check (kind in ('ask', 'draft')),
  created_at timestamptz not null default now(),
  -- True from the take until the write commits; a held event that is never used stops counting
  -- after ten minutes.
  held       boolean not null default true
);
create index rate_event_owner on rate_event(owner_id, kind, created_at);
-- Only these functions read or write it: no session's role is granted it.
alter table rate_event enable row level security;

create function kj_rate_take(p_actor text, p_kind text, p_window_ms bigint, p_max int, p_org_max int)
returns table (r_owner text, r_org boolean, r_max int, r_count int, r_wait_s int, r_hold text)
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_owner text;
  v_org boolean;
  v_max int;
  v_since timestamptz := now() - p_window_ms * interval '1 millisecond';
  v_stale timestamptz := now() - interval '10 minutes';
  v_count int;
  v_oldest timestamptz;
  v_hold text;
begin
  select case when a.kind = 'agent' and a.owner_id is not null then a.owner_id else a.id end into v_owner
    from public.actor a where a.id = p_actor;
  v_owner := coalesce(v_owner, p_actor);
  v_org := exists (select 1 from public.account o where o.id = v_owner and o.kind = 'organization');
  v_max := case when v_org then p_org_max else p_max end;
  perform set_config('lock_timeout', '5s', true);
  perform pg_advisory_xact_lock(hashtextextended('kj_rate:' || p_kind || ':' || v_owner, 0));
  -- Holds never used, and events long out of any window, go.
  delete from public.rate_event e where e.owner_id = v_owner and e.kind = p_kind
     and ((e.held and e.created_at <= v_stale) or e.created_at <= least(v_since, now() - interval '1 day'));
  -- One statement, so one snapshot: an event is one row from its take to the end of the window,
  -- held or used, so a write that commits as this counts is counted once.
  select count(*)::int, min(e.created_at) into v_count, v_oldest from public.rate_event e
   where e.owner_id = v_owner and e.kind = p_kind and (e.created_at > v_since or e.held);
  if v_count < v_max then
    v_hold := p_kind || ':' || v_owner || ':' || md5(random()::text || clock_timestamp()::text);
    insert into public.rate_event(id, owner_id, kind) values (v_hold, v_owner, p_kind);
  end if;
  return query select v_owner, v_org, v_max, v_count,
    ceil(extract(epoch from v_oldest + p_window_ms * interval '1 millisecond' - now()))::int, v_hold;
end $$;
revoke execute on function kj_rate_take(text, text, bigint, int, int) from public;
-- Only Kolab takes a place (asSystem): a session's role could otherwise fill another owner's budget.
grant execute on function kj_rate_take(text, text, bigint, int, int) to kj_system;

-- Marks the event kj_rate_take held as used, in the transaction that writes what it was held for:
-- it counts to the end of the window, whatever happens to what was written. A write that waited
-- more than ten minutes for its locks finds its hold pruned (kj_rate_take): the event is put back,
-- as used, from now, so the write still counts and isn't failed for waiting. It is put back outside
-- the budget's lock, so the budget can overshoot by that one event; it never undercounts. The hold's
-- id names its kind and owner (kj_rate_take's `kind:owner:md5`).
create function kj_rate_use(p_hold text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_parts text[] := regexp_match(p_hold, '^(ask|draft):(.+):[0-9a-f]{32}$');
begin
  if v_parts is null then raise exception 'not a rate hold: %', p_hold; end if;
  insert into public.rate_event(id, owner_id, kind, held) values (p_hold, v_parts[2], v_parts[1], false)
    on conflict (id) do update set held = false;
end $$;
revoke execute on function kj_rate_use(text) from public;
-- A draft's write runs as the agent's session (kj_agent), a question's as Kolab (kj_system).
grant execute on function kj_rate_use(text) to kj_agent, kj_system;

-- Gives back the place kj_rate_take held, after the transaction that was to write it failed.
create function kj_rate_release(p_hold text) returns void
language sql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
  delete from public.rate_event where id = p_hold and held;
$$;
revoke execute on function kj_rate_release(text) from public;
grant execute on function kj_rate_release(text) to kj_system;

-- A version's changes, by element: deltas() reads a version's, and a commit's cascade matches an
-- override mark to the new version's change of the same element (P7). Neither had an index, so
-- each read the whole table.
create index delta_version on delta(version_id, element_id);

-- A kolab's invites, newest first: the web interface's People page, a page at a time.
create index kolab_invite_kolab_created on kolab_invite(kolab_id, created_at, id);
