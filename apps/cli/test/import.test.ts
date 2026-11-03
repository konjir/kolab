// konjir import (W6.3; D15, D104, D109): a person signed in imports a kolab's spec, binding, rulings
// and repository from one file, over Kolab's konjir_import; never inside a job or as an agent; run
// again it changes nothing; --dry-run writes nothing. The fixture is invented.
import { afterEach, expect, jest, test } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@konjir/server';
import { call, connect, main } from '../src/cli.js';
import { importKolab } from '../src/import.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';
const env = { ...process.env };
const exitCode = process.exitCode;
afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; process.exitCode = exitCode; });

const FILE = {
  format: 'konjir-import/1',
  kolab: 'test',
  spec: { name: 'shop', title: 'Shop', elements: [{ id: 'CHK1', text: 'A shopper pays by card.' }, { id: 'CHK2', text: 'A receipt is emailed.' }] },
  binding: {
    name: 'shop-binding', title: 'Shop on Postgres',
    elements: [
      { id: 'DEC1', text: 'Payments go through the card gateway.', serves: ['CHK1'] },
      { id: 'W1', title: 'Card payments', text: 'Take card payments.', work: { done_when: 'A test card payment succeeds.' }, serves: ['CHK1'], relies_on: ['DEC1'] },
      { id: 'W2', title: 'Receipts', text: 'Email receipts.', work: { done_when: 'A receipt arrives.', depends_on: ['W1'] }, serves: ['CHK2'] },
    ],
  },
  rulings: [{ id: 'D3', date: '2026-01-02', text: 'Cards only at launch.', on: 'shop#CHK1' }],
  repository: { url: 'https://github.com/acme/shop', root_sha: 'a'.repeat(40) },
};

const fileOf = (content: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), 'konjir-import-')), 'kolab.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
};

/** A Kolab with the test kolab, where lee, a person, holds Admin, and lee-bot, his agent, holds Read. */
async function leesKolab() {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  /** A session of `id`'s in `role`, ending the one it had: as signing in again does. */
  const signIn = async (id: string, role: 'product' | 'engineer') => {
    await call(admin, 'admin_end_session', { actor: id }).catch(() => undefined);
    const { token } = (await call(admin, 'admin_open_session', { actor: id, role })) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token };
  };
  const actor = async (id: string, grant: Record<string, unknown>, owner?: string) => {
    await call(admin, 'admin_add_actor', { id, ...(owner ? { owner } : {}) });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, ...grant });
  };
  await actor('lee', { level: 'admin' });
  await actor('lee-bot', { level: 'read' }, 'lee');
  return { kolab, server, signIn, admin };
}

/** Runs konjir with `argv` as `token`, returning what it printed to stdout and to stderr. */
async function konjir(server: { url: string }, token: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = token;
  await main(argv);
  return { out: out.join('\n'), err: err.join('\n') };
}

test('in a shell: konjir import in two sign-ins writes the file as the person; read_node shows the spec and binding by their IDs; run again it changes nothing (W6.3)', async () => {
  const { server, signIn } = await leesKolab();
  const path = fileOf(FILE);
  const product = await signIn('lee', 'product');
  const first = await konjir(server, product.token, ['import', path]);
  expect(JSON.parse(first.out)).toMatchObject({
    kolab: 'test', by: 'lee', role: 'product', complete: false, differs: [], failed: [], waiting: [],
    created: ['node kj:test/shop', 'version kj:test/shop', 'ruling D3'],
    other_pass: ['node kj:test/shop-binding', 'repository https://github.com/acme/shop', 'version kj:test/shop-binding', 'links kj:test/shop-binding (relies_on)'],
    next: 'konjir login --kolab test --role engineer, then konjir import again',
  });
  expect(first.err).toMatch(/^Import into kolab test, as lee, the product pass:$/m);
  expect(first.err).toMatch(/other_pass +repository https:\/\/github\.com\/acme\/shop: for the engineer pass: konjir login --kolab test --role engineer/);
  expect(first.err).toMatch(/Not complete: 4 left for the other pass \(konjir login --kolab test --role engineer, then konjir import again\)\./);
  expect(process.exitCode ?? 0).toBe(0);

  const lee = await signIn('lee', 'engineer');
  const { out, err } = await konjir(server, lee.token, ['import', path]);
  const report = JSON.parse(out);
  // list_rulings finds it by its ID.
  expect(await call(lee.c, 'list_rulings', { ref: 'D3' })).toMatchObject({ rulings: [{ ref: 'D3' }] });
  expect(report).toMatchObject({ role: 'engineer', complete: true, differs: [], failed: [], waiting: [], other_pass: [] });
  expect(report.created).toStrictEqual([
    'node kj:test/shop-binding', 'repository https://github.com/acme/shop', 'version kj:test/shop-binding', 'links kj:test/shop-binding (relies_on)',
  ]);
  expect(err).toMatch(/Complete: the kolab holds everything the file gives\./);
  expect(process.exitCode ?? 0).toBe(0);

  // read_node, over MCP: each element by its own ID, the work packages' fields, and the ruling beside its element.
  const spec = await call(lee.c, 'read_node', { node: 'shop' }) as { elements: { id: string; rulings?: { ref: string }[] }[] };
  expect(spec.elements.map((e) => e.id)).toStrictEqual(['CHK1', 'CHK2']);
  expect(JSON.stringify(spec)).toMatch(/"ref":"D3"/);
  const binding = await call(lee.c, 'read_node', { node: 'shop-binding' }) as { elements: { id: string; work?: unknown }[] };
  expect(binding.elements.map((e) => [e.id, e.work ?? null])).toStrictEqual([
    ['DEC1', null], ['W1', { done_when: 'A test card payment succeeds.' }], ['W2', { done_when: 'A receipt arrives.', depends_on: ['W1'] }],
  ]);
  expect(await call(lee.c, 'resolve', { address: 'kj:test/shop-binding#W1' })).toMatchObject({ content: expect.stringMatching(/^Card payments Take card payments\./) });
  expect(await call(lee.c, 'list_rulings', {})).toMatchObject({ rulings: [{ ref: 'D3', on: 'kj:shop@1#CHK1', ruled_at: '2026-01-02T23:59:59.999Z', ruled_by: 'lee' }] });
  // The open work packages are pullable: a job lee takes gets the first, with its playbook and precedent.
  const job = await call(lee.c, 'take_job', { machine: 'lee-laptop' }) as { taken: boolean; kind: string; item: string; instructions: string };
  expect(job).toMatchObject({ taken: true, kind: 'build', item: 'kj:shop-binding#W1' });
  expect(job.instructions).toMatch(/Done when: A test card payment succeeds\./);
  expect(job.instructions).toMatch(/D3 on kj:shop@1#CHK1: "Cards only at launch\."/);

  const again = JSON.parse((await konjir(server, lee.token, ['import', path])).out);
  expect(again).toMatchObject({ complete: true, created: [], differs: [] });
  expect(new Set(again.steps.map((s: { outcome: string }) => s.outcome))).toStrictEqual(new Set(['unchanged']));
});

test('konjir import --dry-run writes nothing and says what it would; an engineer pass before the spec exits 0 saying what waits; a difference exits 1 (W6.3)', async () => {
  const { kolab, server, signIn } = await leesKolab();
  const early = await konjir(server, (await signIn('lee', 'engineer')).token, ['import', fileOf(FILE)]);
  expect(JSON.parse(early.out)).toMatchObject({ role: 'engineer', complete: false, created: [], failed: [], next: 'konjir login --kolab test --role product, then konjir import again' });
  expect(early.err).toMatch(/waiting +node kj:test\/shop-binding: it binds shop, which isn't made: the product pass writes the spec/);
  expect(process.exitCode ?? 0).toBe(0);
  const lee = await signIn('lee', 'product');
  const dry = await konjir(server, lee.token, ['import', fileOf(FILE), '--dry-run']);
  expect(JSON.parse(dry.out)).toMatchObject({ dry_run: true, created: [], complete: false });
  expect(dry.err).toMatch(/^Dry run: nothing written\. Import into kolab test, as lee, the product pass:$/m);
  expect(dry.err).toMatch(/would_create +version kj:test\/shop/);
  expect((await kolab.db.query(`select count(*)::int as n from node`)).rows).toStrictEqual([{ n: 0 }]);

  await konjir(server, lee.token, ['import', fileOf(FILE)]);
  const changed = { ...FILE, spec: { ...FILE.spec, elements: [FILE.spec.elements[0], { id: 'CHK2', text: 'A receipt is emailed at once.' }] } };
  const r = await konjir(server, lee.token, ['import', fileOf(changed)]);
  expect(JSON.parse(r.out)).toMatchObject({ differs: ['version kj:test/shop'] });
  expect(r.err).toMatch(/differs +version kj:test\/shop@1: shop@1 differs from the file: the file changes CHK2/);
  expect(process.exitCode).toBe(1);
  // A path with '=' in it is still a file to read.
  const dir = mkdtempSync(join(tmpdir(), 'konjir-import-'));
  const named = join(dir, 'a=b.json');
  writeFileSync(named, JSON.stringify(FILE));
  expect(JSON.parse((await konjir(server, lee.token, ['import', named, '--dry-run'])).out)).toMatchObject({ dry_run: true });
});

test('konjir import refuses inside a job, as an agent, and with bad arguments, writing nothing (W6.3)', async () => {
  const { kolab, server, signIn, admin } = await leesKolab();
  const lee = await signIn('lee', 'engineer');
  const bot = await signIn('lee-bot', 'engineer');
  const path = fileOf(FILE);
  process.env.KONJIR_JOB = 'job-1';
  expect(await rejection(konjir(server, lee.token, ['import', path]))).toMatch(/konjir import doesn't run inside a Konjir job \(KONJIR_JOB is set\)/);
  delete process.env.KONJIR_JOB;
  expect(await rejection(konjir(server, bot.token, ['import', path]))).toMatch(/lee-bot is an agent, and an agent imports nothing/);
  expect(await rejection(konjir(server, lee.token, ['import']))).toMatch(/konjir import <file\.json> \[--dry-run\] \[--update\]: name one file/);
  expect(await rejection(konjir(server, lee.token, ['import', path, '--force']))).toMatch(/unknown --force/);
  expect(await rejection(konjir(server, lee.token, ['import', fileOf([1, 2])]))).toMatch(/is one JSON object/);
  expect(await rejection(konjir(server, lee.token, ['import', fileOf({ ...FILE, kolab: 'elsewhere' })]))).toMatch(/imports into kolab elsewhere, and this session works in kolab test/);
  expect((await kolab.db.query(`select count(*)::int as n from node`)).rows).toStrictEqual([{ n: 0 }]);
  // The admin token has no session, so it imports nothing.
  expect(await rejection(call(admin, 'import', { file: FILE }))).toMatch(/this tool needs an agent session token, not the admin token/);
  // Backdating is the import's alone: konjir_rule takes no date.
  expect(await rejection(call(lee.c, 'rule', { address: 'kj:x#R1', text: 'Then.', effect: 'keep_intent', ruled_at: '2026-01-01' }))).toMatch(/unknown argument ruled_at/);
  // The client checks the size Kolab takes before it sends anything.
  const sent = jest.fn(async () => ({}));
  const big = fileOf({ ...FILE, padding: 'x'.repeat(2 * 1024 * 1024) });
  expect(await rejection(importKolab(sent, [big]))).toMatch(/Kolab takes an import of at most/);
  expect(sent).not.toHaveBeenCalled();
});
