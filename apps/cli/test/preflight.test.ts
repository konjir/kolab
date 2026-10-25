// deploy/preflight/run.cjs, which `deploy/konjir-ops.sh preflight 0027` runs on Kolab's instance:
// 0027's preflight on a database at 0026, over a URL as on RDS, read-only and printing no URL. It
// speaks to Postgres over a URL, so this runs on Postgres only.
import { expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MIGRATIONS, migrate, openDb } from '@konjir/db';
import { persistentStore } from '@konjir/engine/testing';

const root = resolve(import.meta.dirname, '../../..');
const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;

/** Runs the preflight on the database at `url`, as konjir-ops.sh does on Kolab's instance. */
function preflight(url: string, migration = '0027'): Promise<{ code: number | null; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-preflight-'));
  writeFileSync(join(dir, 'url'), url);
  copyFileSync(join(root, `deploy/preflight/${migration}.sql`), join(dir, 'preflight.sql'));
  const { NODE_OPTIONS: _, ...env } = process.env;
  const child = spawn('node', [join(root, 'deploy/preflight/run.cjs'), dir, migration], { env: { ...env, KONJIR_RELEASE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return new Promise((done) => child.on('exit', (code) => done({ code, output })));
}

/** A database at 0026, as production is today, with `seed` in it. */
async function at0026(seed: string) {
  const { databaseUrl } = await persistentStore();
  const db = openDb({ databaseUrl });
  try {
    await migrate(db, { migrations: MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => m.name === 'konstruct_kinds')) });
    await db.exec(`insert into account(id, kind, name, created_by) values ('lee', 'user', 'Lee', 'admin');
      insert into kolab(id, owner_id, title, created_by) values ('shop', 'lee', 'Shop', 'admin');
      ${seed}`);
  } finally { await db.close(); }
  return databaseUrl!;
}
const nodes = async (url: string) => {
  const db = openDb({ databaseUrl: url });
  try { return (await db.query(`select id, kind from node order by id`)).rows; } finally { await db.close(); }
};
const N = 'insert into node(id, name, kind, layer, title, kolab_id, created_by) values';

(onPostgres ? test : test.skip)('preflight 0027 on a database at 0026: it applies cleanly, and each parent it will set is named; nothing changes and no URL is printed', async () => {
  const url = await at0026(`${N} ('s', 's', 'functional_spec', 'functional', 'S', 'shop', 'lee'), ('b', 'b', 'technical_binding', 'technical', 'B', 'shop', 'lee'),
    ('w', 'w', 'wbs', 'technical', 'W', 'shop', 'lee');`);
  const before = await nodes(url);
  const { code, output } = await preflight(url);
  expect(code).toBe(0);
  expect(output).toContain('preflight 0027, read-only, on a database at 0026');
  expect(output).toContain('ok     0027 applies cleanly: nothing to refuse');
  expect(output).toContain("parent shop/b (binding) -> s: its kolab's one spec");
  expect(output).toContain("parent shop/w (plan) -> b: its kolab's only binding");
  expect(output).toMatch(/RESULT \{"migration":"0027","at":26,"refusals":0,"parents":2,"applies":true\}/);
  const u = new URL(url);
  expect(output).not.toContain(`${u.username}:${u.password}@`);
  expect(output).not.toContain(url);
  expect(output).not.toMatch(/postgres(ql)?:\/\//);
  expect(await nodes(url)).toStrictEqual(before);
});

(onPostgres ? test : test.skip)('preflight 0027 names each refusal 0027 would make, and changes nothing', async () => {
  const url = await at0026(`${N} ('a', 'a', 'functional_spec', 'functional', 'A', 'shop', 'lee'), ('a2', 'a2', 'functional_spec', 'functional', 'A2', 'shop', 'lee'),
    ('x', 'x', 'work_package', 'technical', 'X', 'shop', 'lee');`);
  const before = await nodes(url);
  const { code, output } = await preflight(url);
  expect(code).toBe(0);
  expect(output).toContain('refuse 1 not a kind: shop/x (work_package)');
  expect(output).toContain('refuse 3 more than one spec: kolab shop: a, a2');
  expect(output).not.toContain('applies cleanly');
  expect(output).toMatch(/"refusals":2/);
  expect(await nodes(url)).toStrictEqual(before);
});

(onPostgres ? test : test.skip)('preflight 0027 on a database already at 0027 says there is nothing to check; one it can\'t reach fails without the URL', async () => {
  const { databaseUrl } = await persistentStore();
  const db = openDb({ databaseUrl });
  try { await migrate(db); } finally { await db.close(); }
  const done = await preflight(databaseUrl!);
  expect(done.code).toBe(0);
  expect(done.output).toContain('0027 is applied already, so there is nothing to check');
  const bad = new URL(databaseUrl!);
  bad.password = 'not-the-password';
  const refused = await preflight(bad.toString());
  expect(refused.code).toBe(1);
  expect(refused.output).toMatch(/^FAIL /m);
  expect(refused.output).not.toContain('not-the-password');
});
