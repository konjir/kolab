// deploy/recovery-verify.cjs (W2.24) on a read-only copy: its smoke check proves a Kolab from this
// release starts, authenticates and reads the copy without a single write, and that the break-glass
// token stays audited there (W2.22): its verb is refused because its audit row can't be written.
// The verifier speaks to Postgres over a URL, as it does to RDS, so this runs on Postgres only.
import { expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '@konjir/db';
import { openKolab, persistentStore } from '@konjir/engine/testing';

const root = resolve(import.meta.dirname, '../../..');
const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;

/** The same server under another name: the verifier refuses a "restored" host that is production's own. */
const otherName = (host: string) => (host === 'localhost' ? '127.0.0.1' : host === '127.0.0.1' ? 'localhost' : `${host}.`);

/** Runs the verifier on the database at `url`, as the drill does on Kolab's instance, and resolves with what it printed. */
function verify(url: string): Promise<{ code: number | null; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'konjir-verify-'));
  writeFileSync(join(dir, 'prod-url'), url);
  const u = new URL(url);
  const { NODE_OPTIONS: _, ...env } = process.env;
  const child = spawn('node', [join(root, 'deploy/recovery-verify.cjs'), dir, otherName(u.hostname), u.port || '5432'], {
    env: { ...env, KONJIR_RELEASE_DIR: root, KONJIR_SMOKE_PORT: String(20000 + Math.floor(Math.random() * 20000)) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return new Promise((done) => child.on('exit', (code) => done({ code, output })));
}

const counts = async (url: string) => {
  const db = openDb({ databaseUrl: url });
  try {
    const n = async (t: string) => Number((await db.query<{ n: string }>(`select count(*) as n from ${t}`)).rows[0].n);
    return { audit: await n('audit_event'), sessions: await n('session'), actors: await n('actor') };
  } finally {
    await db.close();
  }
};

/**
 * A copy with some of everything, after `damage` (SQL run on it as Kolab's login, if any), made
 * read-only as a database, as well as by the verifier's own read-only sessions.
 */
async function readOnlyCopy(damage?: string) {
  const { databaseUrl } = await persistentStore();
  const kolab = await openKolab({ databaseUrl });
  await kolab.addActor('ann');
  await kolab.addActor('ann-cli', { owner: 'ann' });
  await kolab.createKolab('anns', { owner: 'ann' });
  await kolab.grant('anns', 'ann-cli', 'read');
  await kolab.openSession('ann-cli', 'product', { kolab: 'anns' });
  await kolab.close();
  const db = openDb({ databaseUrl });
  const name = new URL(databaseUrl!).pathname.slice(1);
  try {
    if (damage) await db.query(damage);
    await db.query(`alter database ${name} set default_transaction_read_only = on`);
  } finally {
    await db.close();
  }
  return databaseUrl!;
}

const resultOf = (lines: string[]) => JSON.parse(lines.find((l) => l.startsWith('RESULT '))!.slice('RESULT '.length)) as { ok: boolean; smokeActors?: number };

(onPostgres ? test : test.skip)('a copy whose sessions Kolab can\'t look up fails the authentication step: a 500, not a 401', async () => {
  const run = await verify(await readOnlyCopy('alter table session rename column token_key to token_key_gone'));
  const lines = run.output.split('\n');
  expect(lines).toContainEqual(expect.stringMatching(/^FAIL smoke: a token that is no session's got status 500, not 401, so its lookup in the copy's sessions failed/));
  expect(lines).not.toContainEqual(expect.stringMatching(/^ok {3}smoke: it authenticates/));
  expect(resultOf(lines).ok).toBe(false);
  expect(run.code).toBe(1);
}, 180_000);

(onPostgres ? test : test.skip)('a copy whose audit log can\'t take the row for another reason fails the audit step, never crediting read-only', async () => {
  const run = await verify(await readOnlyCopy('alter table audit_event rename column subject to subject_gone'));
  const lines = run.output.split('\n');
  expect(lines).toContainEqual(expect.stringMatching(/^FAIL smoke: admin_list_actors with the break-glass token failed \(exit 1\), but not because its audit row couldn't be written/));
  expect(lines).not.toContainEqual(expect.stringMatching(/^ok {3}smoke: the break-glass token's admin_list_actors is refused here/));
  expect(resultOf(lines).ok).toBe(false);
  expect(run.code).toBe(1);
}, 180_000);

(onPostgres ? test : test.skip)('the smoke check passes on a read-only copy, writing nothing, and the break-glass token is refused there for want of its audit row', async () => {
  const databaseUrl = await readOnlyCopy();
  const before = await counts(databaseUrl);

  const run = await verify(databaseUrl);
  const lines = run.output.split('\n');
  expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  expect(lines).toEqual(expect.arrayContaining([
    expect.stringMatching(/^ok {3}smoke: a read-only Kolab on the copy .* answered \/healthz/),
    expect.stringMatching(/^ok {3}smoke: it authenticates against the copy: a token that is no session's is refused \(401\)/),
    expect.stringMatching(/^ok {3}smoke: the break-glass token's admin_list_actors is refused here, since its audit row \(break_glass\.used\) can't be written/),
    expect.stringMatching(new RegExp(`^ok {3}smoke: the release's engine, opened read-only on the copy, lists all ${before.actors} of its actors`)),
  ]));
  expect(resultOf(lines)).toMatchObject({ ok: true, smokeActors: before.actors });
  expect(run.code).toBe(0);
  // Nothing written: no break_glass.used row, no session.
  expect(await counts(databaseUrl)).toEqual(before);
}, 180_000);
