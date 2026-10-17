-- Migration 0004: a failed rebase gets a mark reason of its own, rebase_failed (W2.8; D44, CAS7).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A rebase that fails for the variant's own reasons (its review rejects it or can't run, or the
-- reviewer throws) marks the variant rebase_failed, with a question, not review_failed, so that
-- inboxes and reports can tell a failed rebase from a rejected review. A variant holds at most
-- one open rebase_failed mark, and the next successful rebase settles it.

alter table invalidation drop constraint invalidation_reason_check;
alter table invalidation add constraint invalidation_reason_check check (reason in
  ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
   'upstream_dirty','review_failed','rebase_failed','role_boundary','query_answered'));
                                                            -- MARK_REASONS in @konjir/types

-- Which review_failed marks came from failed rebases: all of them. From release 0.5 through
-- 0003, the only code that raised review_failed was the rebase (Kolab.rebase, and from W1.17
-- rebaseOrMark): a version's own failed review rejects the version and raises no mark, and a
-- layer leak raises role_boundary. So the reason alone identifies them. Their question text
-- ("Rebasing onto the new parent failed…") would not: a release from W1.17's first commit
-- swallowed a failure to ask, leaving such a mark with no question at all.
--
-- Open marks become rebase_failed, so the next successful rebase settles them. Cleared marks
-- keep review_failed: they are history, and nothing acts on them again.
update invalidation set reason = 'rebase_failed' where reason = 'review_failed' and state = 'open';

-- Releases before W1.17 added a mark for every failed rebase, so a variant may hold several.
-- Marks move with their version on supersede, so they all sit on the variant's live version.
-- Keep the newest, which names the newest parent, and clear the rest, answering their questions
-- as the engine does when a mark settles. Rebase marks never cause other marks, so nothing
-- cascades.
with ranked as (
  select id, first_value(id) over w as kept,
         row_number() over w as n
    from invalidation
   where reason = 'rebase_failed' and state = 'open'
  window w as (partition by version_id order by created_at desc, id desc)
), merged as (
  update invalidation i set state = 'cleared', cleared_by = 'merged into ' || r.kept || ' by migration 0004'
    from ranked r
   where i.id = r.id and r.n > 1
  returning i.id, r.kept
)
update query q set state = 'answered', answer = 'superseded by the newer failed rebase in mark ' || m.kept
  from merged m
 where q.invalidation_id = m.id and q.state = 'open';
