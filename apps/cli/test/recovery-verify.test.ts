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

(onPostgres ? test : test.skip)('the smoke check passes on a read-only copy, writing nothing, and the break-glass token is refused there for want of its audit row', async () => {
  const { databaseUrl } = await persistentStore();
  const kolab = await openKolab({ databaseUrl });
  await kolab.addActor('ann');
  await kolab.addActor('ann-cli', { owner: 'ann' });
  await kolab.createKolab('anns', { owner: 'ann' });
  await kolab.grant('anns', 'ann-cli', 'read');
  await kolab.openSession('ann-cli', 'product', { kolab: 'anns' });
  await kolab.close();
  // A read-only database, as well as the verifier's read-only sessions: nothing can be written to it.
  const db = openDb({ databaseUrl });
  const name = new URL(databaseUrl!).pathname.slice(1);
  try { await db.query(`alter database ${name} set default_transaction_read_only = on`); } finally { await db.close(); }
  const before = await counts(databaseUrl!);

  const run = await verify(databaseUrl!);
  const lines = run.output.split('\n');
  expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
  expect(lines).toEqual(expect.arrayContaining([
    expect.stringMatching(/^ok {3}smoke: a read-only Kolab on the copy .* answered \/healthz/),
    expect.stringMatching(/^ok {3}smoke: it authenticates against the copy: a token that is no session's is refused \(401\)/),
    expect.stringMatching(/^ok {3}smoke: the break-glass token's admin_list_actors is refused here, since its audit row \(break_glass\.used\) can't be written/),
    expect.stringMatching(new RegExp(`^ok {3}smoke: the release's engine, opened read-only on the copy, lists all ${before.actors} of its actors`)),
  ]));
  const result = JSON.parse(lines.find((l) => l.startsWith('RESULT '))!.slice('RESULT '.length)) as { ok: boolean; smokeActors: number };
  expect(result).toMatchObject({ ok: true, smokeActors: before.actors });
  expect(run.code).toBe(0);
  // Nothing written: no break_glass.used row, no session.
  expect(await counts(databaseUrl!)).toEqual(before);
}, 180_000);
