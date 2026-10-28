-- advisory
-- Preflight for migration 0032 (W5.2a, D98): read-only, against a database at 0031, before the
-- release that carries 0032 is deployed. Advisory, not a gate: 0032 itself can't fail (a new table,
-- two evidence columns with defaults, nothing rewritten). Run it with
-- deploy/konjir-ops.sh preflight 0032, or as is: psql "$DATABASE_URL" -f deploy/preflight/0032.sql
--
-- After 0032, a commit or pull request is recorded only in a registered repository: a package's own
-- (its `repo`, or its binding's implementation), or one the evidence names. No repository is
-- registered at 0031, so before approving the deploy, a person with Maintain registers:
--   1. each repository a package's `repo` names, in its plan's latest committed version: PLN2 then
--      refuses the plan's next version, and the package's evidence, until `repo` is the canonical
--      https URL of a live registration (each row says whether the value is even an https URL);
--   2. the implementation of each binding whose plan has work In progress or In review, which can
--      record no commit or pull request until it has one (or names one with repo=).
-- 3 counts the evidence 0032 marks as from before repositories: it reads as unconfirmed, and never
-- confirms a repository. No rows means nothing needs registering first.
-- apps/cli/test/preflight.test.ts runs it on a database at 0031.
with
latest as (
  select distinct on (v.node_id) v.id, v.node_id, v.seq, p.name, p.kolab_id, p.parent_node_id
    from version v join node p on p.id = v.node_id
   where p.kind = 'plan' and v.state = 'committed'
   order by v.node_id, v.seq desc
),
named as (
  select l.kolab_id, l.name, l.seq, e.element_id, e.work->>'repo' as repo
    from latest l join element e on e.version_id = l.id
   where e.work ? 'repo'
),
busy as (
  select w.kolab_id, p.name as plan, b.name as binding, w.element_id, w.state
    from work_package w join node p on p.id = w.plan_node_id left join node b on b.id = p.parent_node_id
   where w.state in ('in_progress', 'in_review') and w.removed_in_version_id is null
)
select 1 as ord, 'a package''s repo names no registered repository' as why,
       string_agg(format('%s/%s@%s#%s: %s%s', kolab_id, name, seq, element_id, repo,
                         case when repo ~ '^https://[^/@?#\s]+(/[^/?#\s]+){2,}/?$' then '' else ' (not an https URL of owner/name)' end),
                  '; ' order by kolab_id, name, element_id) as nodes
  from named
having count(*) > 0
union all
select 2, 'a plan with work under way whose binding has no registered implementation',
       string_agg(format('%s/%s (binding %s): %s', kolab_id, plan, coalesce(binding, 'none'), packages), '; ' order by kolab_id, plan)
  from (select kolab_id, plan, binding, string_agg(format('%s %s', element_id, state), ', ' order by element_id) as packages
          from busy group by kolab_id, plan, binding) g
having count(*) > 0
union all
select 3, 'evidence 0032 marks as from before repositories (unconfirmed, never confirming)',
       format('%s commits and pull requests, %s test runs', count(*) filter (where kind <> 'test_run'), count(*) filter (where kind = 'test_run'))
  from evidence
having count(*) > 0
order by ord;
