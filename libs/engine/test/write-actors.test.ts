// Every write records who made it (W2.20, D70). Kolab's public methods that write are read from
// its source and held to WRITE_ACTORS, which says where each records its actor, and the SQL each
// can reach is checked to write that place; the database refuses a row, or a change of access,
// that names no one (migration 0024); and each new place is filled, by the session's actor, the
// person signing in, the admin, or Kolab, as the write was made.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { ADMIN_DOER, AUDIT_ACTIONS } from '@konjir/types';
import { Kolab, NO_ACTOR_REASONS, SYSTEM_ACTOR, SYSTEM_WRITES, WRITE_ACTORS, activity, sessionKey } from '../src/index.js';
import { els, openKolab, people, rejection, TEST_KOLAB, TestKolab } from '../src/testing.js';

/**
 * A write in SQL: an insert, an update (of a table named plainly, schema-qualified, quoted or by a
 * template), a delete, a merge or a truncate. What it can't see: SQL built from pieces it doesn't
 * spell out, and writes made inside a database function that Kolab calls (the database's own
 * triggers back those up for the actor columns and the access tables).
 */
const WRITE = /\b(insert\s+into|delete\s+from|update\s+(?:only\s+)?(?:[\w."]+|\$\{[^}]+\})(?:\s+(?:as\s+)?\w+)?\s+set|merge\s+into\s+(?:[\w."]+|\$\{[^}]+\})(?:\s+(?:as\s+)?\w+)?\s+using|truncate\s+(?:table\s+)?(?:only\s+)?(?:[\w."]+|\$\{[^}]+\}))\b/i;

const KOLAB_TS = new URL('../src/kolab.ts', import.meta.url);

/**
 * kolab.ts (or `src`, a variant of it), read as units: Kolab's methods, by their header two spaces
 * in, in the class Kolab, as `this.<name>`; and the module's functions and arrow functions
 * (`const name = (async)? (...) =>`), at the top level, by their name. Each with its body, and the
 * units it calls or passes by reference (`this.<method>` with or without a call, or a top-level
 * unit's name called or passed as an argument), other than SYSTEM_WRITES. It reads the source's shape, not its meaning: a unit
 * reached only through a variable, a computed name or another module is not followed.
 */
function units(src = readFileSync(KOLAB_TS, 'utf8')) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^export class Kolab\b/.test(l));
  let end = start + 1;
  while (!/^}/.test(lines[end])) end++;
  type Unit = { name: string; method: boolean; private: boolean; body: string[] };
  const all = new Map<string, Unit>();
  const header = /^ {2}(?:(?:private|protected|public|static|readonly|async|override)\s+)*([A-Za-z_]\w*)\s*(?:<[^(]*>)?\(/;
  let cur: Unit | undefined;
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(header);
    if (m) all.set(`this.${m[1]}`, cur = { name: m[1], method: true, private: /^\s+(private|protected)\b/.test(lines[i]), body: [] });
    cur?.body.push(lines[i]);
  }
  cur = undefined;
  for (let i = 0; i < lines.length; i++) {
    if (i >= start && i <= end) { cur = undefined; continue; }
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/)
      ?? lines[i].match(/^(?:export\s+)?const\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_]\w*\s*=>)/);
    if (m) { all.set(m[1], cur = { name: m[1], method: false, private: false, body: [lines[i]] }); continue; }
    if (/^(export |const |let |interface |type |class |\/\*\*)/.test(lines[i])) cur = undefined;
    cur?.body.push(lines[i]);
  }
  const stop = new Set(SYSTEM_WRITES.map((n) => `this.${n}`));
  const calls = new Map([...all].map(([k, u]) => {
    // Comments name units too; only code calls or passes them.
    const b = u.body.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');
    // A method, called or passed (`this.x(...)`, `this.x`); a top-level unit, called (`x(`) or passed as an argument (`(x,` `, x)`).
    const named = [...b.matchAll(/this\.(\w+)\b/g)].map((m) => `this.${m[1]}`)
      .concat([...b.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]))
      .concat([...b.matchAll(/[(,]\s*([A-Za-z_]\w*)\s*(?=[,)])/g)].map((m) => m[1]));
    return [k, [...new Set(named)].filter((c) => all.has(c) && c !== k && !stop.has(c))];
  }));
  /** The SQL, and the rest of the bodies, of `k` and of every unit it reaches. */
  const reach = (k: string, seen = new Set<string>()): string[] => {
    if (seen.has(k)) return [];
    seen.add(k);
    return [all.get(k)!.body.join('\n'), ...calls.get(k)!.flatMap((c) => reach(c, seen))];
  };
  return { all, reach, lines: lines.slice(start, end) };
}

/** Kolab's public methods that write, in `src` (kolab.ts by default): whose reachable bodies (units().reach) write SQL. */
function writingMethods(src?: string): string[] {
  const { all, reach } = units(src);
  if (src === undefined) expect(all.has('this.createNode') && all.has('insertSession') && all.has('audit')).toBe(true);   // the reading works
  return [...all].filter(([k, u]) => u.method && !u.private && u.name !== 'constructor' && reach(k).some((b) => WRITE.test(b))).map(([, u]) => u.name).sort();
}

/** Whether SQL in `bodies` writes `place`: inserts into its table naming the column, sets it in an update, or audits the action. */
function writesPlace(bodies: string[], place: string): boolean {
  const text = bodies.join('\n');
  if (place.startsWith('audit_event:')) {
    const action = place.slice('audit_event:'.length).replace('.', '\\.');
    return new RegExp(`(?<![.\\w])audit\\([^;]*?'${action}'`).test(text);
  }
  const [table, column] = place.split('.');
  const named = `(?:only\\s+)?(?:"?public"?\\.)?"?${table}"?`;
  const inserts = [...text.matchAll(new RegExp(`insert\\s+into\\s+${named}\\s*\\(([^)]*)\\)`, 'gi'))].some((m) => new RegExp(`\\b${column}\\b`).test(m[1]));
  const updates = [...text.matchAll(new RegExp(`update\\s+${named}(?:\\s+(?:as\\s+)?[a-z]+)?\\s+set\\b([\\s\\S]*?)(?:\\bwhere\\b|\\breturning\\b|\\bfrom\\b|\`)`, 'gi'))]
    .some((m) => new RegExp(`(?:^|[\\s,.])${column}\\s*=`).test(m[1]));
  return inserts || updates;
}

/** The methods allowed to record no one, and why: a new one is a change here too (W2.20). */
const NO_ACTOR = {
  system: ['drainOutbox', 'listen', 'open', 'startWorker'],
  unsigned: ['abandonAuthorization', 'beginAuthorization', 'declineAuthorization', 'oauthClient', 'pruneClients', 'registerClient'],
};

test('every public method of Kolab that writes says where it records who made the write, and none is listed that no longer writes', () => {
  expect(writingMethods()).toStrictEqual(Object.keys(WRITE_ACTORS).sort());
  // The helpers whose writes are Kolab's own are still there to be skipped.
  const src = readFileSync(new URL('../src/kolab.ts', import.meta.url), 'utf8');
  for (const name of SYSTEM_WRITES) expect([name, new RegExp(`private async ${name}\\(`).test(src)]).toStrictEqual([name, true]);
});

test('only the methods listed here record no one, each for one of the reasons NO_ACTOR_REASONS names', () => {
  for (const kind of ['system', 'unsigned'] as const) {
    const listed = Object.entries(WRITE_ACTORS).filter(([, how]) => kind in how);
    expect(listed.map(([m]) => m).sort()).toStrictEqual(NO_ACTOR[kind]);
    for (const [method, how] of listed) {
      const reason = (how as Record<string, string>)[kind];
      expect([method, reason, reason in NO_ACTOR_REASONS[kind]]).toStrictEqual([method, reason, true]);
    }
  }
});

test('each place WRITE_ACTORS names is a column of the schema, or an action of the audit log, and the SQL its method reaches writes it', async () => {
  const kolab = await openKolab();
  const columns = new Set((await kolab.db.query<{ c: string }>(
    `select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'`)).rows.map((r) => r.c));
  const { reach } = units();
  for (const [method, how] of Object.entries(WRITE_ACTORS)) {
    if (!('recorded' in how)) continue;
    expect([method, how.recorded.length > 0]).toStrictEqual([method, true]);
    const bodies = reach(`this.${method}`);
    for (const place of how.recorded) {
      const known = place.startsWith('audit_event:') ? (AUDIT_ACTIONS as readonly string[]).includes(place.slice('audit_event:'.length)) : columns.has(place);
      expect([method, place, known, writesPlace(bodies, place)]).toStrictEqual([method, place, true, true]);
    }
  }
  // The check can fail: a method that writes none of a place isn't taken as writing it.
  expect(writesPlace(reach('this.createNode'), 'audit_event:grant.set')).toBe(false);
  expect(writesPlace(reach('this.linkIdentity'), 'session.opened_by')).toBe(false);
});

test('no SQL write is outside kolab.ts, where the scan reads it; no production code uses TestKolab or subclasses Kolab; and Kolab has no method the scan would miss', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  // Each project's own tests, end-to-end tests and dev scripts, at its root, and the migrations.
  const skipped = /^(apps|libs)\/[^/]+\/(test|e2e|scripts)$|^libs\/db\/src\/migrations$/;
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    const rel = p.slice(repo.length);
    if (['node_modules', 'dist'].includes(f) || skipped.test(rel)) return [];
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f) ? [p] : [];
  });
  const files = ['apps', 'libs'].flatMap((d) => sources(join(repo, d))).map((p) => ({ path: p.slice(repo.length), text: readFileSync(p, 'utf8') }));
  // The migration runner writes only its own bookkeeping.
  expect(files.filter((f) => WRITE.test(f.text)).map((f) => f.path).sort()).toStrictEqual(['libs/db/src/migrate.ts', 'libs/engine/src/kolab.ts']);
  // TestKolab acts as the admin token when a write names no one: only tests and scripts may use it,
  // and nothing else may give Kolab defaults of its own by extending it.
  expect(files.filter((f) => /['"]@konjir\/engine\/testing['"]|['"][./]*testing(\.js)?['"]/.test(f.text)).map((f) => f.path)
    .filter((p) => p !== 'libs/engine/src/testing.ts')).toStrictEqual([]);
  expect(files.filter((f) => /\bextends\s+Kolab\b/.test(f.text)).map((f) => f.path)).toStrictEqual(['libs/engine/src/testing.ts']);
  // A method written as a property, `name = async (...) =>`, has no header the scan finds.
  expect(units().lines.filter((l) => /^ {2}(?:(?:private|protected|public|readonly|static)\s+)*\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.test(l))).toStrictEqual([]);
});

test('the scan finds a write through a top-level helper, a schema-qualified or template table, a merge or truncate, or a method passed by reference', () => {
  const src = readFileSync(KOLAB_TS, 'utf8');
  const probes: Record<string, { method: string; helper?: string }> = {
    probeHelper: { method: `  async probeHelper() { await sneaky(this.db); }`, helper: `const sneaky = async (q: Q) => q.query(\`delete from node where id = 'x'\`);` },
    probeQualified: { method: `  async probeQualified() { await this.db.query(\`update public.node set title = 'x' where id = 'x'\`); }` },
    probeTemplate: { method: `  async probeTemplate(t: string) { await this.db.query(\`update \${t} set title = 'x'\`); }` },
    probeMerge: { method: `  async probeMerge() { await this.db.query(\`merge into node n using node m on n.id = m.id when matched then do nothing\`); }` },
    probeTruncate: { method: `  async probeTruncate() { await this.db.query(\`truncate outbox\`); }` },
    probeReference: { method: `  async probeReference() { await this.inTransaction(this.probeWrites); }\n  private async probeWrites(tx: Q) { await tx.query(\`delete from node where id = 'x'\`); }` },
  };
  const base = writingMethods();
  for (const [name, p] of Object.entries(probes)) {
    const at = src.indexOf('\n  // ---- actors and sessions');
    expect(at).toBeGreaterThan(0);
    const probed = (p.helper ? `${p.helper}\n` : '') + src.slice(0, at) + `\n${p.method}\n` + src.slice(at);
    expect([name, writingMethods(probed)]).toStrictEqual([name, [...base, name].sort()]);
  }
});

test('the database refuses a row that names no one, and a session ended, an invite or grant revoked, or a version submitted without saying by whom', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const s = await kolab.openSession('alice', 'product');
  const nobody = /must name who made this write/;
  expect(await rejection(kolab.db.query(`insert into node(id, name, kind, layer, title, kolab_id) values ('n', 'n', 'functional_spec', 'functional', 'N', $1)`, [TEST_KOLAB]))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`insert into account(id, kind, name) values ('zed', 'user', 'Zed')`))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`insert into kolab(id, owner_id, title) values ('k2', 'test-org', 'K')`))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`insert into team(id, org_id, name) values ('test-org/t', 'test-org', 't')`))).toMatch(nobody);
  expect(await rejection(kolab.db.query(`update session set ended_at = now() where id = $1`, [sessionKey(s)]))).toMatch(nobody);
  const node = await kolab.createNode(s, 'functional_spec', 'Orders', 'orders');
  const draft = await kolab.draft(s, node, { elements: els({ R1: 'Orders can be cancelled.' }) });
  expect(await rejection(kolab.db.query(`update version set state = 'committed' where id = $1`, [draft]))).toMatch(nobody);
  const { invite } = await kolab.createInvite(await adminSession(kolab), { level: 'read' });
  expect(await rejection(kolab.db.query(`update kolab_invite set revoked_at = now() where id = $1`, [invite.id]))).toMatch(nobody);
  // Nor one that names someone blank.
  expect(await rejection(kolab.db.query(`insert into team(id, org_id, name, created_by) values ('test-org/t', 'test-org', 't', '  ')`))).toMatch(nobody);
  // No actor or account may be called admin or kolab, in any case: they name the admin token and Kolab.
  expect(await rejection(kolab.addActor('Admin'))).toMatch(/"admin" is reserved/);
  expect(await rejection(kolab.addActor('KOLAB'))).toMatch(/"kolab" is reserved/);
  expect(await rejection(kolab.addOrganization('Admin'))).toMatch(/TenancyError: "admin" is reserved/);
  expect(await rejection(kolab.addOrganization('Kolab'))).toMatch(/TenancyError: "kolab" is reserved/);
  expect(await rejection(kolab.db.query(`insert into actor(id, name, kind, created_by) values ('admin', 'x', 'person', 'admin')`))).toMatch(/actor_not_doer/);
  expect(await rejection(kolab.db.query(`insert into account(id, kind, name, created_by) values ('Kolab', 'organization', 'x', 'admin')`))).toMatch(/account_not_doer/);
});

test('Kolab makes every caller name who made its write: none is taken as the admin or as Kolab, and a blank name is no one', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'bob']);
  const s = await kolab.openSession('alice', 'product');
  const v = await kolab.draft(s, await kolab.createNode(s, 'functional_spec', 'Orders', 'orders'), { elements: els({ R1: 'Orders can be cancelled.' }) });
  const audited = async () => (await kolab.db.query<{ n: number }>(`select count(*)::int as n from audit_event`)).rows[0].n;
  const before = await audited();
  // Kolab itself, as a server or a script calls it, with no `by` (TestKolab fills one in for tests).
  const bare = Kolab.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const nobody = /a write must name who made it/;
  for (const [name, args] of [
    ['addActor', ['cy', {}]], ['addOrganization', ['acme', {}]], ['createKolab', ['k2', { owner: 'test-org' }]], ['openSession', ['bob', 'engineer', {}]],
    ['endSession', [{ actor: 'alice' }, {}]], ['linkIdentity', ['bob', { provider: 'github', subject: '9' }, {}]], ['addMember', ['test-org', 'bob', 'member', {}]],
    ['removeMember', ['test-org', 'bob', {}]], ['addTeam', ['test-org', 'ops', {}]], ['addTeamMember', ['test-org/ops', 'bob', {}]],
    ['removeTeamMember', ['test-org/ops', 'bob', {}]], ['grant', [TEST_KOLAB, 'bob', 'read', {}]], ['revoke', [TEST_KOLAB, 'bob', {}]],
    ['archive', [{ actor: 'bob' }, {}]], ['unarchive', [{ actor: 'bob' }, {}]], ['retryOutboxJob', ['01JOB', {}]],
    ['applyRuling', ['orders', { elements: els({ R1: 'x' }) }, { id: 'D70', actor: 'alice' }]], ['review', [v, {}]],
  ] as const) {
    expect([name, await rejection(bare[name].call(kolab, ...args))]).toStrictEqual([name, expect.stringMatching(nobody)]);
    expect([name, await rejection(bare[name].call(kolab, ...(args as readonly unknown[]).slice(0, -1), name === 'applyRuling' ? { id: 'D70', actor: 'alice', by: ' ' } : { by: ' ' }))])
      .toStrictEqual([name, expect.stringMatching(nobody)]);
  }
  // Nothing was written.
  expect(await audited()).toBe(before);
  expect(await kolab.version(v)).toMatchObject({ state: 'drafted', submitted_by: null });
});

test('the database refuses a change of access whose transaction adds no audit row for it', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'bob']);
  await kolab.addMember('test-org', 'alice');
  await kolab.addTeam('test-org', 'ops');
  const unaudited = /a change of access to \S+ must be recorded in the audit log/;
  for (const sql of [
    `update kolab_grant set level = 'read', functional = false, technical = false where user_id = 'bob'`,
    `delete from kolab_grant where user_id = 'bob'`,
    `insert into kolab_grant(kolab_id, team_id, level, functional, technical) values ('${TEST_KOLAB}', 'test-org/ops', 'read', false, false)`,
    `update org_member set role = 'owner' where user_id = 'alice'`,
    `delete from org_member where user_id = 'alice'`,
    `insert into team_member(team_id, user_id) values ('test-org/ops', 'alice')`,
  ]) expect([sql, await rejection(kolab.db.query(sql))]).toStrictEqual([sql, expect.stringMatching(unaudited)]);
  // An audit row for someone else, or another kolab, or another kind of change, doesn't do.
  for (const [action, kolabId, subject] of [['grant.set', TEST_KOLAB, 'alice'], ['member.set', null, 'bob'], ['grant.set', null, 'bob']] as const) {
    expect(await rejection(kolab.db.transaction(async (tx) => {
      await tx.query(`insert into audit_event(action, kolab_id, subject, done_by) values ($1, $2, $3, 'ada')`, [action, kolabId, subject]);
      await tx.query(`update kolab_grant set level = 'read', functional = false, technical = false where user_id = 'bob'`);
    }))).toMatch(unaudited);
  }
  // The record must be of that operation, in that organization or team, and an update needs one for its old row too.
  const recorded = async (audits: [string, string | null, string, Record<string, unknown> | null][], sql: string) => rejection(kolab.db.transaction(async (tx) => {
    for (const [action, k, subject, detail] of audits) {
      await tx.query(`insert into audit_event(action, kolab_id, subject, detail, done_by) values ($1, $2, $3, $4, 'ada')`, [action, k, subject, detail && JSON.stringify(detail)]);
    }
    await tx.query(sql);
  }));
  await kolab.addOrganization('orgb');
  await kolab.addTeam('orgb', 'ops');
  await kolab.addMember('orgb', 'alice');
  expect(await recorded([['grant.set', TEST_KOLAB, 'bob', null]], `delete from kolab_grant where user_id = 'bob'`)).toMatch(unaudited);
  expect(await recorded([['grant.removed', TEST_KOLAB, 'bob', null]], `update kolab_grant set level = 'read', functional = false, technical = false where user_id = 'bob'`)).toMatch(unaudited);
  expect(await recorded([['member.removed', null, 'bob', { org: 'test-org' }]], `insert into org_member(org_id, user_id) values ('test-org', 'bob')`)).toMatch(unaudited);
  expect(await recorded([['member.set', null, 'bob', { org: 'test-org' }]], `insert into org_member(org_id, user_id) values ('orgb', 'bob')`)).toMatch(unaudited);
  expect(await recorded([['team_member.added', null, 'alice', { team: 'test-org/ops' }]], `insert into team_member(team_id, user_id) values ('orgb/ops', 'alice')`)).toMatch(unaudited);
  await kolab.addActor('cy');
  expect(await recorded([['grant.set', TEST_KOLAB, 'cy', null]], `update kolab_grant set user_id = 'cy' where user_id = 'bob'`)).toMatch(unaudited);
  // The change and its record, in one transaction, in either order, commit.
  await kolab.db.transaction(async (tx) => {
    await tx.query(`update kolab_grant set level = 'read', functional = false, technical = false where user_id = 'bob'`);
    await tx.query(`insert into audit_event(action, kolab_id, subject, done_by) values ('grant.set', $1, 'bob', 'ada')`, [TEST_KOLAB]);
  });
  expect((await kolab.access('bob', TEST_KOLAB)).level).toBe('read');
});

/** A person holding Admin in the test kolab, with a session there. */
async function adminSession(kolab: TestKolab) {
  if (!(await kolab.listActors()).some((a) => a.id === 'ada')) {
    await kolab.addActor('ada');
    await kolab.grant(TEST_KOLAB, 'ada', 'admin');
  }
  return kolab.openSession('ada', 'product');
}

const row = async (kolab: TestKolab, sql: string, params: unknown[] = []) => (await kolab.db.query<Record<string, unknown>>(sql, params)).rows[0];

/** A grant removed by hand, as if by someone with the database's own login: recorded, since the database requires it. */
async function outsideKolabsVerbs(kolab: TestKolab, sql: string, subject: string) {
  await kolab.db.transaction(async (tx) => {
    await tx.query(sql);
    await tx.query(`insert into audit_event(action, kolab_id, subject, done_by) values ('grant.removed', $1, $2, 'test')`, [TEST_KOLAB, subject]);
  });
}

test('accounts, actors, kolabs, teams, identities and sessions record who made them: the admin, the person signing up, or the owner', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'bob']);
  expect(await row(kolab, `select created_by from account where id = 'test-org'`)).toStrictEqual({ created_by: ADMIN_DOER });
  expect(await row(kolab, `select a.created_by as actor, o.created_by as account from actor a join account o on o.id = a.id where a.id = 'alice'`)).toStrictEqual({ actor: ADMIN_DOER, account: ADMIN_DOER });
  expect(await row(kolab, `select created_by from kolab where id = $1`, [TEST_KOLAB])).toStrictEqual({ created_by: ADMIN_DOER });
  // An admin who is a person (W2.22) passes who they are.
  await kolab.addTeam('test-org', 'ops', { by: 'alice' });
  expect(await row(kolab, `select created_by from team where id = 'test-org/ops'`)).toStrictEqual({ created_by: 'alice' });
  await kolab.linkIdentity('alice', { provider: 'github', subject: '7' });
  expect(await row(kolab, `select linked_by from identity where actor_id = 'alice'`)).toStrictEqual({ linked_by: ADMIN_DOER });

  // A person signing up makes themselves, and the agents and kolab they make are theirs.
  const { actor: lee } = await kolab.signInWith({ provider: 'github', subject: '42', login: 'leen' });
  expect(await row(kolab, `select a.created_by as actor, o.created_by as account, i.linked_by from actor a join account o on o.id = a.id join identity i on i.actor_id = a.id where a.id = $1`, [lee]))
    .toStrictEqual({ actor: lee, account: lee, linked_by: lee });
  const agent = await kolab.addOwnAgent(lee, 'cli');
  expect(await row(kolab, `select created_by from actor where id = $1`, [agent])).toStrictEqual({ created_by: lee });
  await kolab.makeOwnKolab(lee, 'leens', 'Lee\'s');
  expect(await row(kolab, `select created_by from kolab where id = 'leens'`)).toStrictEqual({ created_by: lee });

  // Sessions: opened by the admin; ended by their own actor signing out, or by the admin.
  const a = await kolab.openSession('alice', 'product');
  const b = await kolab.openSession('bob', 'engineer');
  expect(await row(kolab, `select opened_by, ended_by from session where id = $1`, [sessionKey(a)])).toStrictEqual({ opened_by: ADMIN_DOER, ended_by: null });
  await kolab.endSession(a);
  await kolab.endSession({ actor: 'bob' }, { by: ADMIN_DOER });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(a)])).toStrictEqual({ ended_by: 'alice' });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(b)])).toStrictEqual({ ended_by: ADMIN_DOER });
  // Switching kolab or role: the person ends the old one and opens the new one.
  const c = await kolab.openSession('alice', 'product');
  const d = await kolab.switchSession(c, { kolab: TEST_KOLAB, role: 'engineer' });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(c)])).toStrictEqual({ ended_by: 'alice' });
  expect(await row(kolab, `select opened_by from session where id = $1`, [sessionKey(d)])).toStrictEqual({ opened_by: 'alice' });
  // A session that loses its access is ended by whoever took it, or by Kolab when it finds out on its own.
  await kolab.revoke(TEST_KOLAB, 'alice', { by: 'ada' });
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(d)])).toStrictEqual({ ended_by: 'ada' });
  await kolab.grant(TEST_KOLAB, 'alice', 'write');
  const e = await kolab.openSession('alice', 'product');
  await outsideKolabsVerbs(kolab, `delete from kolab_grant where user_id = 'alice'`, 'alice');
  await rejection(kolab.sessionInfo(e));
  expect(await row(kolab, `select ended_by from session where id = $1`, [sessionKey(e)])).toStrictEqual({ ended_by: SYSTEM_ACTOR });
});

test('changes of access, memberships and outbox retries leave no row of their own, so the audit log records them, with who made them', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  // An outbox retry, by the admin.
  const s = await kolab.openSession('alice', 'product');
  const node = await kolab.createNode(s, 'functional_spec', 'Orders', 'orders');
  const v = await kolab.commit(s, node, { elements: els({ R1: 'Orders can be cancelled.' }) });
  await kolab.db.query(`insert into outbox(id, kind, version_id, state, attempts) values ('01JOB', 'after_commit', $1, 'dead', 10) on conflict do nothing`, [v]);
  const job = (await kolab.outboxJobs({ state: 'dead' }))[0].id;
  expect(await kolab.retryOutboxJob(job)).toBe(true);
  expect(await kolab.auditLog({ kolab: TEST_KOLAB, subject: job })).toMatchObject([{ action: 'outbox.retried', subject: job, by: ADMIN_DOER }]);

  await kolab.addActor('cy');
  await kolab.addMember('test-org', 'cy', 'member');
  await kolab.addTeam('test-org', 'ops');
  await kolab.addTeamMember('test-org/ops', 'cy');
  await kolab.grant(TEST_KOLAB, 'test-org/ops', 'read');
  await kolab.removeTeamMember('test-org/ops', 'cy');
  await kolab.removeMember('test-org', 'cy');
  await kolab.revoke(TEST_KOLAB, 'test-org/ops');
  // A kolab's own Admin changes a grant there (W3.6), and an invite grants what it names (W3.4).
  const ada = await adminSession(kolab);
  await kolab.changeGrant(ada, 'bob', 'read');
  await kolab.removeGrant(ada, 'bob');
  const { token } = await kolab.createInvite(ada, { level: 'triage' });
  await kolab.acceptInvite(token, 'cy');
  const log = (await kolab.auditLog()).reverse().map(({ action, kolab: k, subject, detail, by }) => ({ action, kolab: k, subject, detail, by }));
  expect(log.filter((e) => e.action !== 'outbox.retried' && (!['alice', 'bob', 'ada'].includes(e.subject) || e.by !== ADMIN_DOER))).toStrictEqual([
    { action: 'member.set', kolab: null, subject: 'cy', detail: { org: 'test-org', role: 'member' }, by: ADMIN_DOER },
    { action: 'team_member.added', kolab: null, subject: 'cy', detail: { team: 'test-org/ops' }, by: ADMIN_DOER },
    { action: 'grant.set', kolab: TEST_KOLAB, subject: 'test-org/ops', detail: { level: 'read', layers: [] }, by: ADMIN_DOER },
    { action: 'team_member.removed', kolab: null, subject: 'cy', detail: { team: 'test-org/ops' }, by: ADMIN_DOER },
    { action: 'member.removed', kolab: null, subject: 'cy', detail: { org: 'test-org' }, by: ADMIN_DOER },
    { action: 'grant.removed', kolab: TEST_KOLAB, subject: 'test-org/ops', detail: null, by: ADMIN_DOER },
    { action: 'grant.set', kolab: TEST_KOLAB, subject: 'bob', detail: { level: 'read', layers: [] }, by: 'ada' },
    { action: 'grant.removed', kolab: TEST_KOLAB, subject: 'bob', detail: null, by: 'ada' },
    { action: 'grant.set', kolab: TEST_KOLAB, subject: 'cy', detail: expect.objectContaining({ level: 'triage', layers: [] }), by: 'cy' },
  ]);
  expect((await kolab.auditLog({ subject: 'cy' })).map((e) => e.action)).toStrictEqual(['grant.set', 'member.removed', 'team_member.removed', 'team_member.added', 'member.set']);

  // The log is only ever added to, and no session reads it.
  expect(await rejection(kolab.db.query(`delete from audit_event`))).toMatch(/only ever added to/);
  expect(await rejection(kolab.db.query(`update audit_event set done_by = 'x'`))).toMatch(/only ever added to/);
  expect(await rejection(kolab.readAs(s, (q) => q.query(`select * from audit_event`)))).toMatch(/permission denied/);
});

test('nodes, invites, versions and grants record who made, revoked or submitted them; read_node and the activity feed name them', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await people(kolab, 'bob', { layers: ['technical'] });
  const s = await kolab.openSession('alice', 'product');
  const node = await kolab.createNode(s, 'functional_spec', 'Orders', 'orders');
  expect(await row(kolab, `select created_by, created_at is not null as dated from node where id = $1`, [node])).toStrictEqual({ created_by: 'alice', dated: true });
  expect((await kolab.readNode(s, 'orders').catch(() => undefined))).toBeUndefined();   // no committed version yet
  const v = await kolab.commit(s, node, { elements: els({ R1: 'Orders can be cancelled.' }) });
  expect(await row(kolab, `select actor_id, submitted_by from version where id = $1`, [v])).toStrictEqual({ actor_id: 'alice', submitted_by: 'alice' });
  expect((await kolab.readNode(s, 'orders')).createdBy).toBe('alice');
  const feed = (await activity(kolab, s)).items;
  expect(feed.find((r) => r.kind === 'node')).toMatchObject({ kind: 'node', node: 'orders', actor: 'alice', title: 'Orders' });
  // A node with only a draft not yet submitted isn't in the feed, as its draft isn't.
  const quiet = await kolab.createNode(s, 'prototype', 'Quiet', 'quiet');
  await kolab.draft(s, quiet, { elements: els({ Q1: 'Not yet.' }) });
  expect((await activity(kolab, s)).items.filter((r) => r.kind === 'node').map((r) => r.node)).toStrictEqual(['orders']);
  // Nor one whose only draft was abandoned before it was ever submitted.
  const dropped = await kolab.createNode(s, 'prototype', 'Dropped', 'dropped');
  await kolab.abandon(s, await kolab.draft(s, dropped, { elements: els({ D1: 'Never mind.' }) }));
  expect((await activity(kolab, s)).items.filter((r) => r.kind === 'node').map((r) => r.node)).toStrictEqual(['orders']);

  // A ruling the admin applies is written as the actor given, and submitted by the admin.
  const r = await kolab.applyRuling(node, { deltas: [{ kind: 'override', element: 'R1', text: 'Orders can be cancelled before they ship.' }] }, { id: 'D70', actor: 'alice' });
  expect(await row(kolab, `select actor_id, submitted_by from version where id = $1`, [r.version])).toStrictEqual({ actor_id: 'alice', submitted_by: ADMIN_DOER });

  // An invite's revoker.
  const ada = await adminSession(kolab);
  const { invite } = await kolab.createInvite(ada, { level: 'read' });
  await kolab.revokeInvite(ada, invite.id);
  expect(await row(kolab, `select created_by, revoked_by from kolab_invite where id = $1`, [invite.id])).toStrictEqual({ created_by: 'ada', revoked_by: 'ada' });
});

test('an OAuth grant records who opened and ended its sessions, and who revoked it: its person, or Kolab on a replay', async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice');
  const s256 = (x: string) => createHash('sha256').update(x).digest('base64url');
  const signIn = async () => {
    const client = (await kolab.registerClient({ redirectUris: ['http://127.0.0.1:9/cb'] })).id;
    const verifier = randomBytes(32).toString('base64url');
    const { binding, state } = await kolab.beginAuthorization({ provider: 'github', clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: s256(verifier) });
    const { csrf } = await kolab.identifyAuthorization(binding, state, 'alice');
    const { code } = await kolab.consent(binding, csrf, { kolab: TEST_KOLAB, role: 'product', as: { kind: 'self' } });
    const exchange = () => kolab.exchangeCode({ code, clientId: client, redirectUri: 'http://127.0.0.1:9/cb', codeVerifier: verifier });
    return { tokens: await exchange(), exchange };
  };
  const first = await signIn();
  expect(await row(kolab, `select opened_by from session where id = $1`, [first.tokens.session])).toStrictEqual({ opened_by: 'alice' });
  const second = await signIn();
  // The newest sign-in wins: alice ended the first session by signing in again.
  expect(await row(kolab, `select ended_by from session where id = $1`, [first.tokens.session])).toStrictEqual({ ended_by: 'alice' });
  expect(await kolab.revokeToken(second.tokens.refreshToken)).toBe(true);
  expect(await row(kolab, `select g.revoked_by, s.ended_by from session s join oauth_grant g on g.id = s.grant_id where s.id = $1`, [second.tokens.session]))
    .toStrictEqual({ revoked_by: 'alice', ended_by: 'alice' });
  // A code used twice revokes the grant it opened: Kolab does that, not the person.
  const third = await signIn();
  await rejection(third.exchange());
  expect(await row(kolab, `select g.revoked_by, s.ended_by from session s join oauth_grant g on g.id = s.grant_id where s.id = $1`, [third.tokens.session]))
    .toStrictEqual({ revoked_by: SYSTEM_ACTOR, ended_by: SYSTEM_ACTOR });
});

test('a version returned to its author and submitted again names whoever submitted it last', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'dave', 'eve'], { layers: ['functional'] });
  const alice = await kolab.openSession('alice', 'product');
  const dave = await kolab.openSession('dave', 'product');
  const eve = await kolab.openSession('eve', 'product');
  const node = await kolab.createNode(alice, 'functional_spec', 'Orders', 'orders');
  const v = await kolab.draft(alice, node, { elements: els({ R1: 'Orders can be cancelled.' }) });
  expect(await kolab.submit(alice, v)).toMatchObject({ in_review: true });
  expect(await row(kolab, `select state, submitted_by from version where id = $1`, [v])).toStrictEqual({ state: 'in_review', submitted_by: 'alice' });
  await kolab.recordReview(dave, v, { verdict: 'request_changes', note: 'Say when.' });
  expect(await row(kolab, `select state from version where id = $1`, [v])).toStrictEqual({ state: 'drafted' });
  // Another writer of the layer puts it back to review: they are its submitter now.
  expect(await kolab.submit(eve, v)).toMatchObject({ in_review: true });
  expect(await row(kolab, `select state, submitted_by from version where id = $1`, [v])).toStrictEqual({ state: 'in_review', submitted_by: 'eve' });
});

test("who made a node is told only to readers in its own kolab: not through read_node, and not to kj_agent's reads of node", async () => {
  const kolab = await openKolab();
  await people(kolab, 'alice', { layers: ['functional'] });
  await kolab.createKolab('other', { owner: 'test-org' });
  await kolab.addActor('olga');
  await kolab.grant('other', 'olga', 'write');
  const olga = await kolab.openSession('olga', 'product', { kolab: 'other' });
  const node = await kolab.createNode(olga, 'functional_spec', 'Theirs', 'theirs');
  await kolab.commit(olga, node, { elements: els({ T1: 'Theirs.' }) });
  expect((await kolab.readNode(olga, 'theirs')).createdBy).toBe('olga');
  // alice reads other, but works in the test kolab: she sees the version and its author, not who made the node.
  await kolab.grant('other', 'alice', 'read');
  const alice = await kolab.openSession('alice', 'product', { kolab: TEST_KOLAB });
  const read = await kolab.readNode(alice, 'other/theirs');
  expect(read.version.actor_id).toBe('olga');
  expect('createdBy' in read).toBe(false);
  expect(await rejection(kolab.readAs(alice, (q) => q.query(`select created_by from node`)))).toMatch(/permission denied/);
  expect((await kolab.readAs(alice, (q) => q.query(`select kj_node_creator($1) as c`, [node]))).rows).toStrictEqual([{ c: null }]);
  expect((await kolab.readAs(olga, (q) => q.query(`select kj_node_creator($1) as c`, [node]))).rows).toStrictEqual([{ c: 'olga' }]);
});

test('the audit log pages back with before', async () => {
  const kolab = await openKolab();
  await people(kolab, ['alice', 'bob', 'cy']);
  const all = await kolab.auditLog({ kolab: TEST_KOLAB });
  expect(all.length).toBe(3);
  const first = await kolab.auditLog({ kolab: TEST_KOLAB, limit: 2 });
  const rest = await kolab.auditLog({ kolab: TEST_KOLAB, limit: 2, before: first[1].id });
  expect([...first, ...rest]).toStrictEqual(all);
  expect(await rejection(kolab.auditLog({ before: -1 }))).toMatch(/before is the id of an audit event/);
});
