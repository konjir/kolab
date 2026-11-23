-- Preflight for migration 0060 (konjir_delete_my_account): read-only, against a database at 0059,
-- before the release that carries 0060 is deployed. Run it with deploy/konjir-ops.sh preflight 0060,
-- or as is: psql "$DATABASE_URL" -f deploy/preflight/0060.sql
--
-- The query is 0060's own check, text for text (libs/engine/test/migrations.test.ts compares them):
-- it returns no rows exactly when 0060 applies, and otherwise one row naming each actor and account
-- whose id already starts with deleted-, which after 0060 names only a deleted account (the re-key
-- of konjir_delete_my_account), so 0060 refuses to run until each is renamed.

-- check:begin
select 1 as ord, 'an actor''s or account''s id starts with deleted-, which after 0060 names a deleted account only' as why,
       string_agg(x.what || ' ' || x.id, ', ' order by x.what, x.id) as nodes
  from (select 'actor' as what, id from actor where lower(id) like 'deleted-%'
        union all
        select 'account', id from account where lower(id) like 'deleted-%') x
having count(*) > 0
-- check:end
