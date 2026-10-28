'use strict';
// Runs a migration's preflight (deploy/preflight/NNNN.sql) on Kolab's database, changing nothing.
// deploy/konjir-ops.sh preflight NNNN sends this and the SQL to the Kolab instance through SSM and
// runs it there as the konjir user, since only the instance can reach RDS:
//
//   node run.cjs <dir> <NNNN>
//
// <dir> holds url, the stack's database URL from its SSM parameter (never printed), and
// preflight.sql. It connects with the live release's own pg module (the instance has no psql), in a
// session read-only by its startup options and with a statement timeout, and runs the queries in
// one `begin read only` transaction that it rolls back. The database must be at the migration
// before NNNN: one already past it has nothing left to check.
//
// The file's first query lists the migration's refusals: none means it applies cleanly. Any
// further queries are what it will do, which this prints too. It prints one line per row, never a
// URL or password, and last `RESULT {json}`; it exits 1 only if it couldn't run the check.
//
// A file whose first line is `-- advisory` (0029's) gates nothing: the migration can't fail, and its
// query lists what to look at before deploying. Its rows print as `advise`, and it says advisory.
const fs = require('fs');
const path = require('path');

// The live release; KONJIR_RELEASE_DIR points it at a checkout, to try it locally.
const REL = process.env.KONJIR_RELEASE_DIR || '/opt/konjir/current';
const pg = require(require.resolve('pg', { paths: [REL] }));
const [dir, migration] = process.argv.slice(2);
const why = (e) => (e && e.code === '57014' ? 'a query ran past the 60 s statement timeout'
  : e && Array.isArray(e.errors) && e.errors.length ? e.errors.map(why).join('; ') : String(e && e.message ? e.message : e))
  .replace(/postgres(ql)?:\/\/[^\s]*/g, 'postgres://***');

/** The URL with every session read-only, as Postgres's startup options. */
function readOnly(url) {
  const u = new URL(url);
  const options = [u.searchParams.get('options'), '-c default_transaction_read_only=on', '-c statement_timeout=60000'].filter(Boolean).join(' ');
  u.searchParams.set('options', options);
  return u.toString();
}

/** The file's statements, each a query; comments alone aren't one. */
const statements = (sql) => sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.replace(/^--.*$/gm, '').trim());

async function main() {
  if (!dir || !/^\d{4}$/.test(migration || '')) throw new Error('usage: node run.cjs <dir> <NNNN>');
  const url = fs.readFileSync(path.join(dir, 'url'), 'utf8').trim();
  const sql = fs.readFileSync(path.join(dir, 'preflight.sql'), 'utf8');
  const advisory = /^-- advisory\s*$/m.test(sql.split('\n')[0]);
  const [refusals, ...plans] = statements(sql);
  const c = new pg.Client({ connectionString: readOnly(url), application_name: `konjir-preflight-${migration}`, connectionTimeoutMillis: 20000 });
  await c.connect();
  try {
    if ((await c.query('show default_transaction_read_only')).rows[0].default_transaction_read_only !== 'on') throw new Error('the session is not read-only; stopping');
    await c.query('begin read only');
    try {
      const at = Number((await c.query('select coalesce(max(version), 0) as v from kj_migration')).rows[0].v);
      const want = Number(migration) - 1;
      if (at >= Number(migration)) {
        console.log(`note the database is at ${String(at).padStart(4, '0')}: ${migration} is applied already, so there is nothing to check`);
        console.log(`RESULT ${JSON.stringify({ migration, at, applied: true })}`);
        return;
      }
      if (at !== want) throw new Error(`the database is at ${String(at).padStart(4, '0')}, not ${String(want).padStart(4, '0')}: this preflight checks a database at the migration before ${migration}`);
      console.log(`preflight ${migration}, read-only, on a database at ${String(at).padStart(4, '0')}${advisory ? ': advisory, it gates nothing' : ''}`);
      const found = (await c.query(refusals)).rows;
      if (advisory) {
        for (const r of found) console.log(`advise ${r.ord} ${r.why}: ${r.nodes}`);
        if (!found.length) console.log(`ok     ${migration}: advisory, nothing to look at`);
        console.log(`RESULT ${JSON.stringify({ migration, at, advisory: true, findings: found.length })}`);
        return;
      }
      for (const r of found) console.log(`refuse ${r.ord} ${r.why}: ${r.nodes}`);
      if (!found.length) console.log(`ok     ${migration} applies cleanly: nothing to refuse`);
      let planned = 0;
      for (const q of plans) {
        for (const r of (await c.query(q)).rows) {
          planned++;
          console.log('parent' in r ? `parent ${r.kolab_id}/${r.node} (${r.kind}) -> ${r.parent}: ${r.how}` : `plan   ${JSON.stringify(r)}`);
        }
      }
      console.log(`RESULT ${JSON.stringify({ migration, at, refusals: found.length, parents: planned, applies: !found.length })}`);
    } finally {
      await c.query('rollback');
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.log(`FAIL ${why(e)}`);
  process.exitCode = 1;
});
