'use strict';
// Verifies a restored copy of Kolab's database (P12, D75; W2.24), changing nothing anywhere.
// deploy/recovery-drill.sh sends it to the Kolab instance through SSM and runs it there as the
// konjir user, since only the instance can reach RDS:
//
//   node recovery-verify.cjs <dir> <restored host> <restored port> [compare]
//
// <dir> holds prod-url, the stack's database URL from its SSM parameter (never printed). A
// restored database keeps the master password, so its URL is that one with the host changed.
//
// The restored copy's own checks need nothing from production, so they pass when production is
// gone:
// 1. Migrations: kj_migration is exactly the live release's: every file it pins, each with its
//    checksum, and none it doesn't know. A copy behind the release is the "a release caused it"
//    case: roll the release back first (deploy/RECOVERY.md).
// 2. Tables: every table the copy's recorded migrations create is there, and it isn't empty.
// 3. Smoke, with no write: a second Kolab from the live release, `serve --no-migrate --no-worker`,
//    on 127.0.0.1:7499, over a read-only session (default_transaction_read_only), answers /healthz,
//    refuses a token that is no session's with 401 once it has looked it up in the copy, and
//    refuses admin_list_actors with the break-glass token, since that verb's audit row can't be
//    written (W2.22); then it stops. It applies no migration, runs no outbox job and can't write.
//    Then the release's engine, opened read-only on the copy without migrating, lists its actors.
// With `compare`, a separate, optional step then compares the copy with production: migrations
// and row counts. Production unreachable is a note, not a failure.
//
// Every session is read-only, with a statement timeout. It prints one line per check, never a URL,
// password or token, and last `RESULT {json}`; it exits 1 if a check of the copy failed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// The live release; KONJIR_RELEASE_DIR points it at a checkout, to try it locally.
const REL = process.env.KONJIR_RELEASE_DIR || '/opt/konjir/current';
const pg = require(require.resolve('pg', { paths: [REL] }));
const [dir, host, port, mode] = process.argv.slice(2);
// The smoke check's port; KONJIR_SMOKE_PORT moves it, for a test.
const SMOKE_PORT = Number(process.env.KONJIR_SMOKE_PORT || 7499);
const MIGRATIONS = path.join(REL, 'libs/db/src/migrations');
const result = { ok: true };
const fail = (what) => { result.ok = false; console.log(`FAIL ${what}`); };
const pass = (what) => console.log(`ok   ${what}`);
const note = (what) => console.log(`note ${what}`);
const ident = (t) => `"${t.replace(/"/g, '""')}"`;
const fileOf = (m) => `${String(m.version).padStart(4, '0')}_${m.name}.sql`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// An error's text, with any URL masked; a failed connection to both addresses of a host is an
// AggregateError, and Postgres's 57014 is the 60 s statement timeout.
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

async function open(url, clients) {
  const c = new pg.Client({ connectionString: readOnly(url), application_name: 'konjir-recovery-verify', connectionTimeoutMillis: 20000 });
  clients.push(c);
  await c.connect();
  const ro = (await c.query('show default_transaction_read_only')).rows[0].default_transaction_read_only;
  if (ro !== 'on') throw new Error('the session is not read-only; stopping');
  return c;
}

async function snapshot(c) {
  const migrations = (await c.query('select version, name, checksum from kj_migration order by version')).rows;
  const tables = (await c.query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename);
  const counts = {};
  for (const t of tables) counts[t] = Number((await c.query(`select count(*) as n from public.${ident(t)}`)).rows[0].n);
  return { migrations, counts };
}

/** The tables the given migration files leave: each one created, less each one dropped. */
function expectedTables(files) {
  const names = new Set();
  for (const f of [...files].sort()) {
    if (!fs.existsSync(path.join(MIGRATIONS, f))) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/\b(create|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      if (m[1].toLowerCase() === 'create') names.add(m[2].toLowerCase()); else names.delete(m[2].toLowerCase());
    }
  }
  names.add('kj_migration');
  return [...names].sort();
}

function checkCopy(copy) {
  // 1. Migrations, against the live release's pins
  const pins = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'checksums.json'), 'utf8'));
  const release = Object.keys(pins).filter((f) => /^\d{4}_/.test(f)).sort();
  const recorded = copy.migrations.map(fileOf);
  result.migrations = recorded.length;
  result.lastMigration = recorded[recorded.length - 1] ?? null;
  const changed = copy.migrations.filter((m) => pins[fileOf(m)] && pins[fileOf(m)] !== m.checksum).map(fileOf);
  const unknown = recorded.filter((f) => !pins[f]);
  const missing = release.filter((f) => !recorded.includes(f));
  result.behindRelease = missing.length > 0;
  if (changed.length) fail(`migrations: checksums differ from the live release's pins: ${changed.join(', ')}`);
  if (unknown.length) fail(`migrations: the copy has ${unknown.join(', ')}, which the live release doesn't know`);
  if (missing.length) {
    fail(`migrations: the copy lacks ${missing.join(', ')}, which the live release would apply on start. If that release caused this, roll it back first (deploy/RECOVERY.md, "If a release caused it"); otherwise, restore to a later point`);
  }
  if (!changed.length && !unknown.length && !missing.length) {
    pass(`migrations: ${recorded.length} recorded, through ${result.lastMigration}, exactly the live release's, each checksum as it pins it`);
  }

  // 2. Tables: those the copy's own migrations make, so a copy from before a release still passes
  const want = expectedTables(recorded);
  const absent = want.filter((t) => !(t in copy.counts));
  result.tables = Object.keys(copy.counts).length;
  result.rowsRestored = Object.values(copy.counts).reduce((n, c) => n + c, 0);
  if (absent.length) fail(`tables: ${absent.join(', ')} missing from the copy, though its migrations make them`);
  else pass(`tables: all ${want.length} its migrations make are there`);
  if (result.rowsRestored === 0) fail('rows: the copy is empty');
  else pass(`rows: ${result.rowsRestored} in ${result.tables} tables`);
}

/**
 * The smoke check, which writes nothing. Since W2.22 nothing can both authenticate and read
 * through a Kolab without a write: every session is a row whose token is kept only as a hash, so
 * the copy's own sessions can't be presented and a new one can't be opened; and each admin verb the
 * break-glass token runs writes its audit row (break_glass.used) first, and is refused if it can't.
 * So it proves the parts apart, each without a write:
 * - /healthz: the Kolab on the copy starts, and its database answers.
 * - Authentication reads the copy: a token that is no session's gets 401, which Kolab answers only
 *   once its lookup in the copy's sessions has run; a lookup that failed would be a 5xx.
 * - Break-glass stays audited: admin_list_actors with the break-glass token is refused because its
 *   audit row can't be written. Were it to run, the session wasn't read-only or the token's use went
 *   unrecorded, and either fails the check.
 * - Real data, read by the release: its engine, opened read-only on the copy without migrating,
 *   lists every actor, as many as the copy holds.
 */
async function smoke(url, copy) {
  if (result.behindRelease) return note('smoke: skipped, since the live release would refuse a copy it would migrate (--no-migrate)');
  // A release from before --no-migrate would ignore it. The read-only session would still stop any
  // write, but such a Kolab couldn't start, so say why instead.
  if (!fs.readFileSync(path.join(REL, 'apps/cli/src/cli.ts'), 'utf8').includes('--no-migrate')) {
    return fail('smoke: the live release predates serve --no-migrate (W2.24); deploy it, then verify again');
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const base = `http://127.0.0.1:${SMOKE_PORT}`;
  const answers = () => fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0);
  if (await answers()) return fail(`smoke: something already listens on ${base}; nothing started`);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, KONJIR_DATABASE_URL: readOnly(url), KONJIR_ADMIN_TOKEN: token };
  const lines = [];
  const kolab = spawn(process.execPath,
    ['apps/cli/dist/main.js', 'serve', '--port', String(SMOKE_PORT), '--data', path.join(dir, 'data'), '--no-migrate', '--no-worker', '--quiet'],
    { cwd: REL, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [kolab.stdout, kolab.stderr]) s.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)));
  let exited = false;
  kolab.on('exit', () => { exited = true; });
  const show = (from) => { for (const l of lines.slice(from).slice(-20)) console.log(`     ${l}`); };
  try {
    const t0 = Date.now();
    let status = 0;
    while (!exited && Date.now() - t0 < 180000 && (status = await answers()) !== 200) await sleep(1000);
    result.smokeStartSeconds = Math.round((Date.now() - t0) / 1000);
    if (status !== 200) {
      fail(`smoke: a read-only Kolab on the copy gave no healthy /healthz in ${result.smokeStartSeconds} s (status ${status}); its last lines:`);
      return show(0);
    }
    pass(`smoke: a read-only Kolab on the copy (no migration, no outbox worker) answered /healthz in ${result.smokeStartSeconds} s`);

    // Authentication reads the copy: a token that is no session's, nor the break-glass token
    const stranger = crypto.randomBytes(24).toString('base64url');
    const auth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stranger}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(20000),
    }).then((r) => r.status, () => 0);
    if (auth === 401) pass('smoke: it authenticates against the copy: a token that is no session\'s is refused (401) once it has been looked up in the copy\'s sessions');
    else fail(`smoke: a token that is no session's got ${auth ? `status ${auth}` : 'no answer'}, not 401, so its lookup in the copy's sessions failed`);

    // Break-glass stays audited (W2.22): its verb is refused, since its audit row can't be written
    const from = lines.length;
    const code = await new Promise((resolve) => {
      const cli = spawn(process.execPath, ['apps/cli/dist/main.js', 'admin_list_actors'],
        { cwd: REL, env: { PATH: process.env.PATH, HOME: dir, KONJIR_URL: `${base}/mcp`, KONJIR_TOKEN: token }, stdio: 'ignore' });
      cli.on('exit', resolve);
    });
    const unwritable = () => lines.slice(from).some((l) => /read-only transaction/.test(l));
    for (let i = 0; i < 10 && code !== 0 && !unwritable(); i++) await sleep(200);   // its log line may trail the CLI's exit
    if (code === 0) {
      fail('smoke: the break-glass token ran admin_list_actors on the copy, so the session isn\'t read-only or the token\'s use went unrecorded (W2.22)');
    } else if (unwritable()) {
      pass('smoke: the break-glass token\'s admin_list_actors is refused here, since its audit row (break_glass.used) can\'t be written to the read-only copy (W2.22)');
    } else {
      fail(`smoke: admin_list_actors with the break-glass token failed (exit ${code}), but not because its audit row couldn't be written; its lines:`);
      show(from);
    }
  } finally {
    kolab.kill('SIGTERM');
    for (let i = 0; i < 30 && !exited; i++) await sleep(500);
    if (!exited) kolab.kill('SIGKILL');
  }

  // Real data, read by the release's own engine: on a read-only session, without migrating
  try {
    const engine = await import(pathToFileURL(require.resolve('@konjir/engine', { paths: [REL] })).href);
    const k = await engine.Kolab.open({ databaseUrl: readOnly(url), migrate: false });
    try {
      const actors = await k.listActors({ archived: true });
      result.smokeActors = actors.length;
      if (actors.length === copy.counts.actor) pass(`smoke: the release's engine, opened read-only on the copy, lists all ${actors.length} of its actors`);
      else fail(`smoke: the release's engine lists ${actors.length} actors, but the copy holds ${copy.counts.actor}`);
    } finally {
      await k.close();
    }
  } catch (e) {
    fail(`smoke: the release's engine couldn't read the copy: ${why(e)}`);
  }
}

/** Optional: the copy against production now. Production unreachable is a note. */
async function compare(prodUrl, copy) {
  const clients = [];
  let prod;
  try {
    prod = await snapshot(await open(prodUrl, clients));
  } catch (e) {
    result.production = e && e.code === '57014' ? 'timed out' : 'unreachable';
    return note(`production: ${result.production} (${why(e)}); comparison skipped. The copy's own checks above stand`);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }
  result.production = 'compared';
  const key = (m) => `${fileOf(m)} ${m.checksum}`;
  const a = prod.migrations.map(key);
  const b = copy.migrations.map(key);
  if (a.join() === b.join()) pass('production: the same migrations as the copy');
  else if (a.length > b.length && b.every((k, i) => k === a[i])) note(`production: ${a.length - b.length} more migrations, applied after the recovery point`);
  else note('production: its migrations differ from the copy\'s');
  const tables = [...new Set([...Object.keys(copy.counts), ...Object.keys(prod.counts)])].sort();
  const width = Math.max(...tables.map((t) => t.length), 5);
  console.log(`     ${'table'.padEnd(width)}      copy  production`);
  for (const t of tables) {
    console.log(`     ${t.padEnd(width)}  ${String(copy.counts[t] ?? '-').padStart(8)}  ${String(prod.counts[t] ?? '-').padStart(10)}`);
  }
  result.rowsProduction = Object.values(prod.counts).reduce((n, c) => n + c, 0);
  if (result.rowsProduction === result.rowsRestored) note(`production: ${result.rowsProduction} rows now, the same as the copy`);
  else note(`production: ${result.rowsProduction} rows now, the copy ${result.rowsRestored}; production has moved on since the recovery point`);
}

async function main() {
  const prodUrl = fs.readFileSync(path.join(dir, 'prod-url'), 'utf8').trim();
  const u = new URL(prodUrl);
  if (u.hostname.toLowerCase() === String(host).toLowerCase()) throw new Error('the restored host is the stack\'s own database; refusing');
  u.hostname = host;
  u.port = port;
  const copyUrl = u.toString();

  const clients = [];
  let copy;
  try {
    copy = await snapshot(await open(copyUrl, clients));
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }
  checkCopy(copy);
  await smoke(copyUrl, copy);
  if (mode === 'compare') await compare(prodUrl, copy);
  else note('production: not compared (verify <id> --compare-production compares)');
}

main().catch((e) => fail(`verify: ${why(e)}`))
  .finally(() => {
    console.log(`RESULT ${JSON.stringify(result)}`);
    process.exitCode = result.ok ? 0 : 1;
  });
