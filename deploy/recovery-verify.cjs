'use strict';
// Verifies a restored copy of Kolab's database (P12, D75; W2.24). deploy/recovery-drill.sh sends it
// to the Kolab instance through SSM and runs it there as the konjir user, since only the instance
// can reach RDS:
//
//   node recovery-verify.cjs <dir> <restored host> <restored port>
//
// <dir> holds prod-url, production's database URL (from its SSM parameter, never printed). The
// restored database has production's password, so its URL is production's with the host changed.
//
// 1. Migrations: the restored kj_migration matches production's, and every checksum matches the
//    live release's libs/db/src/migrations/checksums.json.
// 2. Row counts: every table in production's public schema is in the restored copy, with its rows
//    counted on both. Production moves on after the recovery point, so counts may differ a little.
// 3. Smoke: a second Kolab, from the live release, on 127.0.0.1:7499 against the restored copy,
//    answers /healthz and admin_list_actors, then stops. It never touches production's database.
//
// Both connections are read-only sessions. It prints one line per check, never a URL, password or
// token, and last `RESULT {json}`; it exits 1 if a check failed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// The live release; KONJIR_RELEASE_DIR points it at a checkout, to try it locally.
const REL = process.env.KONJIR_RELEASE_DIR || '/opt/konjir/current';
const pg = require(require.resolve('pg', { paths: [REL] }));
const [dir, host, port] = process.argv.slice(2);
const SMOKE_PORT = 7499;
const result = { ok: true };
const fail = (what) => { result.ok = false; console.log(`FAIL ${what}`); };
const pass = (what) => console.log(`ok   ${what}`);
const ident = (t) => `"${t.replace(/"/g, '""')}"`;
const fileOf = (m) => `${String(m.version).padStart(4, '0')}_${m.name}.sql`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url, clients) {
  const c = new pg.Client({ connectionString: url, application_name: 'konjir-recovery-verify', connectionTimeoutMillis: 20000 });
  clients.push(c);
  await c.connect();
  await c.query('set session characteristics as transaction read only');
  return c;
}

async function snapshot(c) {
  const migrations = (await c.query('select version, name, checksum from kj_migration order by version')).rows;
  const tables = (await c.query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename);
  const counts = {};
  for (const t of tables) counts[t] = Number((await c.query(`select count(*) as n from public.${ident(t)}`)).rows[0].n);
  return { migrations, counts };
}

async function smoke(url) {
  const token = crypto.randomBytes(24).toString('base64url');
  const base = `http://127.0.0.1:${SMOKE_PORT}`;
  const answers = () => fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0);
  if (await answers()) return fail(`smoke: something already listens on ${base}; nothing started`);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, KONJIR_DATABASE_URL: url, KONJIR_ADMIN_TOKEN: token };
  const lines = [];
  const kolab = spawn(process.execPath, ['apps/cli/dist/main.js', 'serve', '--port', String(SMOKE_PORT), '--data', path.join(dir, 'data'), '--quiet'],
    { cwd: REL, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [kolab.stdout, kolab.stderr]) s.on('data', (b) => lines.push(...String(b).split('\n').filter(Boolean)));
  let exited = false;
  kolab.on('exit', () => { exited = true; });
  try {
    const t0 = Date.now();
    let status = 0;
    while (!exited && Date.now() - t0 < 180000 && (status = await answers()) !== 200) await sleep(1000);
    result.smokeStartSeconds = Math.round((Date.now() - t0) / 1000);
    if (status !== 200) {
      fail(`smoke: Kolab on the restored copy gave no healthy /healthz in ${result.smokeStartSeconds} s (status ${status}); its last lines:`);
      for (const l of lines.slice(-20)) console.log(`     ${l}`);
      return;
    }
    pass(`smoke: Kolab on the restored copy answered /healthz in ${result.smokeStartSeconds} s`);
    const out = await new Promise((resolve) => {
      const cli = spawn(process.execPath, ['apps/cli/dist/main.js', 'admin_list_actors'],
        { cwd: REL, env: { PATH: process.env.PATH, HOME: dir, KONJIR_URL: `${base}/mcp`, KONJIR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      cli.stdout.on('data', (b) => { text += b; });
      cli.on('exit', (code) => resolve({ code, text }));
    });
    let actors;
    try { actors = JSON.parse(out.text).actors; } catch { actors = undefined; }
    if (out.code === 0 && Array.isArray(actors)) {
      result.smokeActors = actors.length;
      pass(`smoke: admin_list_actors through it lists ${actors.length} actors`);
    } else fail(`smoke: admin_list_actors through it failed (exit ${out.code})`);
  } finally {
    kolab.kill('SIGTERM');
    for (let i = 0; i < 30 && !exited; i++) await sleep(500);
    if (!exited) kolab.kill('SIGKILL');
  }
}

async function main() {
  const prodUrl = fs.readFileSync(path.join(dir, 'prod-url'), 'utf8').trim();
  const u = new URL(prodUrl);
  if (u.hostname === host) throw new Error('the restored host is production\'s; refusing');
  u.hostname = host;
  u.port = port;
  const restoredUrl = u.toString();

  const clients = [];
  let a; let b;
  try {
    const restored = await open(restoredUrl, clients);
    const prod = await open(prodUrl, clients);
    b = await snapshot(restored);
    a = await snapshot(prod);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }

  // 1. Migrations
  const pins = JSON.parse(fs.readFileSync(path.join(REL, 'libs/db/src/migrations/checksums.json'), 'utf8'));
  const key = (m) => `${fileOf(m)} ${m.checksum}`;
  result.migrations = b.migrations.length;
  result.lastMigration = b.migrations.length ? fileOf(b.migrations[b.migrations.length - 1]) : null;
  const unpinned = b.migrations.filter((m) => pins[fileOf(m)] !== m.checksum).map(fileOf);
  if (unpinned.length) fail(`migrations: checksums differ from the live release's pins: ${unpinned.join(', ')}`);
  else pass(`migrations: ${b.migrations.length} recorded, through ${result.lastMigration}, each checksum as the live release pins it`);
  const same = a.migrations.length === b.migrations.length && a.migrations.every((m, i) => key(m) === key(b.migrations[i]));
  const prefix = a.migrations.length > b.migrations.length && b.migrations.every((m, i) => key(m) === key(a.migrations[i]));
  result.migrationsMatchProduction = same;
  if (same) pass('migrations: the same as production\'s');
  else if (prefix) console.log(`note migrations: production has ${a.migrations.length - b.migrations.length} more, applied after the recovery point`);
  else fail('migrations: differ from production\'s');

  // 2. Row counts
  const missing = Object.keys(a.counts).filter((t) => !(t in b.counts));
  if (missing.length) fail(`tables: missing from the restored copy: ${missing.join(', ')}`);
  const tables = Object.keys(b.counts);
  result.tables = tables.length;
  result.rowsRestored = tables.reduce((n, t) => n + b.counts[t], 0);
  result.rowsProduction = Object.values(a.counts).reduce((n, c) => n + c, 0);
  const width = Math.max(...tables.map((t) => t.length), 5);
  console.log(`     ${'table'.padEnd(width)}  restored  production`);
  for (const t of tables) {
    console.log(`     ${t.padEnd(width)}  ${String(b.counts[t]).padStart(8)}  ${String(a.counts[t] ?? '-').padStart(10)}`);
  }
  if (result.rowsRestored === 0) fail('rows: the restored copy is empty');
  else pass(`rows: ${result.rowsRestored} in ${tables.length} tables restored; production has ${result.rowsProduction} now`);

  // 3. Smoke
  await smoke(restoredUrl);
}

// An error's text, with any URL masked; a failed connection to both addresses of a host is an AggregateError.
const why = (e) => (e && Array.isArray(e.errors) && e.errors.length ? e.errors.map(why).join('; ') : String(e && e.message ? e.message : e))
  .replace(/postgres(ql)?:\/\/[^\s]*/g, 'postgres://***');

main().catch((e) => fail(`verify: ${why(e)}`))
  .finally(() => {
    console.log(`RESULT ${JSON.stringify(result)}`);
    process.exitCode = result.ok ? 0 : 1;
  });
