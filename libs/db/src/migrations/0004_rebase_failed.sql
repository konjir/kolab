-- Migration 0004: a failed rebase gets a mark reason of its own, rebase_failed (W2.8; D44, CAS7).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A rebase that fails for the variant's own reasons (its review rejects it or can't run, or the
-- reviewer throws) marks the variant rebase_failed, with a question, not review_failed, so that
-- inboxes and reports can tell a failed rebase from a rejected review. A variant holds at most
-- one open rebase_failed mark. It settles when the variant's live version sits on its parent's
-- latest version: a rebase that passes, or a commit of the variant's own onto that version.

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
-- Cleared marks are renamed too, so that a report over past marks counts them as failed
-- rebases, not rejected reviews.
update invalidation set reason = 'rebase_failed' where reason = 'review_failed';

-- One open mark per variant. Releases before W1.17 added a mark for every failed rebase, and
-- W1.17 re-pointed the oldest of them at each later failure, so a variant may hold several, and
-- the newest-created need not be the newest failure. Without a lock on the node, a mark could
-- also land on a version the variant had just superseded. So group by the variant (the node),
-- and keep the mark whose parent version is newest: the same rule the engine's rebaseFailed
-- uses. The rest are cleared, with their questions answered. Rebase marks never cause other
-- marks, so nothing cascades.
with ranked as (
  select i.id,
         first_value(i.id) over w as kept,
         row_number() over w as n
    from invalidation i
    join version v on v.id = i.version_id
    join version t on t.id = i.triggered_by
   where i.reason = 'rebase_failed' and i.state = 'open'
  window w as (partition by v.node_id order by t.seq desc, i.created_at desc, i.id desc)
), merged as (
  update invalidation i set state = 'cleared', cleared_by = 'merged into ' || r.kept || ' by migration 0004'
    from ranked r
   where i.id = r.id and r.n > 1
  returning i.id, r.kept
)
update query q set state = 'answered',
       answer = 'merged into mark ' || m.kept || ', the one failed rebase this variant keeps open'
  from merged m
 where q.invalidation_id = m.id and q.state = 'open';

-- The kept mark sits on the variant's live version, where the engine looks for it.
update invalidation i set version_id = (
  select l.id from version l
   where l.node_id = (select v.node_id from version v where v.id = i.version_id) and l.state = 'committed'
   order by l.seq desc limit 1)
 where i.reason = 'rebase_failed' and i.state = 'open';

-- A variant whose live version already sits on its parent's latest version is settled.
with settled as (
  update invalidation i set state = 'cleared',
         cleared_by = 'settled by migration 0004: ' || v.id || ' sits on the parent''s latest version'
    from version v, version p
   where i.reason = 'rebase_failed' and i.state = 'open'
     and v.id = i.version_id and p.id = v.parent_version_id and p.node_id <> v.node_id
     and p.id = (select l.id from version l where l.node_id = p.node_id and l.state = 'committed'
                  order by l.seq desc limit 1)
  returning i.id
)
update query q set state = 'answered', answer = 'resolved: the variant sits on its parent''s latest version'
  from settled s
 where q.invalidation_id = s.id and q.state = 'open';

-- Every open mark has its question. Where none was written, ask one, worded as the engine does;
-- the reason the rebase failed was not recorded.
insert into query(id, version_id, invalidation_id, question)
select 'q0004_' || i.id, i.version_id, i.id,
       'Rebasing onto the new parent failed; the reason was not recorded. Commit a new version to rebase it, or wait for the parent''s next commit.'
  from invalidation i
 where i.reason = 'rebase_failed' and i.state = 'open'
   and not exists (select 1 from query q where q.invalidation_id = i.id and q.state = 'open');
