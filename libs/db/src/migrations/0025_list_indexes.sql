-- Indexes for paged lists and the common reads (W2.21, P13 and the rest of P7: D71, D76).
-- Every list is read a page at a time, ordered by a key that ends in the row's id, starting after
-- the last row of the page before (a keyset). Each index below serves one such read, or a read
-- the web interface and the verbs make on every call, so a kolab with many nodes, questions and
-- marks lists in time that grows with the page, not with the kolab.

-- Questions by kolab, state and id: konjir_list_queries (open ones by default, oldest first, by
-- id) and the inbox; and the web page's Open and Answered lists, newest first.
create index query_kolab_state on query(kolab_id, state, id);
create index query_kolab_created on query(kolab_id, created_at, id);
-- Questions on a version: konjir_read_node's threads, a node's questions (node filters join
-- through its versions), settling a version's questions as it commits or is withdrawn.
create index query_version on query(version_id, state);
-- The questions an actor raised: konjir_list_queries mine=true and the answers resource.
create index query_raised_by on query(raised_by, kolab_id, id) where raised_by is not null;
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

-- The per-actor rates (MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR): the questions and notes an actor
-- raised, and the versions it wrote, in the last hour, across every kolab, counted before each
-- ask and draft.
create index query_raised_at on query(raised_by, created_at) where raised_by is not null;
create index version_actor_at on version(actor_id, created_at);

-- A kolab's invites, newest first: the web interface's People page, a page at a time.
create index kolab_invite_kolab_created on kolab_invite(kolab_id, created_at, id);
