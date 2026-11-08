// The M5 check's findings over MCP (W5.7): every verb refuses an argument it doesn't take, naming it
// and the ones it takes; a test run's evidence takes a summary; no served message ends in '..';
// `konjir tools` and docs/verbs.md list each verb's parameters, from the schemas Kolab serves.
import { afterEach, expect, jest, test } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@konjir/server';
import { call, connect, main } from '../src/cli.js';
import { paramsOf, servedTools, toolsListing, usageLine, verbsMarkdown } from '../src/verbs.js';
import { closeAtEnd, openKolab, rejection } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';
const env = { ...process.env };
afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; });

/** A kolab with an engineer agent and a person with Maintain, a spec and a binding with one work package W1, pulled by the engineer. */
async function kolabWithWork() {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: ADMIN, kolab, webRoot: null });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  const actor = async (id: string, role: 'product' | 'engineer', level = 'write') => {
    await call(admin, 'admin_add_actor', { id });
    await call(admin, 'admin_grant', { kolab: 'test', to: id, level, ...(level === 'write' ? { layers: [role === 'product' ? 'functional' : 'technical'] } : {}) });
    const { token } = (await call(admin, 'admin_open_session', { actor: id, role })) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return { c, token };
  };
  const pm = await actor('pm', 'product');
  const eng = await actor('eng', 'engineer');
  return { kolab, server, admin, pm, eng, actor };
}

test('every verb refuses an argument it doesn\'t take, naming it and the arguments it takes; create_node says a node\'s name is its id, set once (W5.7)', async () => {
  const { admin, pm } = await kolabWithWork();
  // The M5 check: name=slugkit made a spec with no name, its ULID for one, silently.
  expect(await rejection(call(pm.c, 'create_node', { kind: 'spec', name: 'slugkit', title: 'Slugkit' })))
    .toBe('Error: Error executing konjir_create_node: Invalid arguments: unknown argument name: it takes kind, title, id, parent. A node\'s name is its id (id=checkout), given when it is made: no verb renames a node, and a kolab holds one spec, so name it in this call');
  // And kind=bogus foo=bar names both.
  const both = await rejection(call(pm.c, 'create_node', { kind: 'bogus', title: 'X', foo: 'bar' }));
  expect(both).toMatch(/bogus/);
  expect(both).toMatch(/unknown argument foo: it takes kind, title, id, parent/);
  // Nothing was made.
  expect((await call(pm.c, 'list_nodes', {}) as { nodes: unknown[] }).nodes).toStrictEqual([]);
  // A verb with no arguments, a nested object, and an admin verb.
  expect(await rejection(call(pm.c, 'whoami', { verbose: true }))).toMatch(/unknown argument verbose: it takes no arguments/);
  expect(await rejection(call(pm.c, 'list_work', { binding: 'b', status: 'todo' }))).toMatch(/unknown argument status: it takes binding, plan, state, ready, mine, cursor, limit/);
  expect(await rejection(call(pm.c, 'draft', { node: 'x', links: [{ source_element: 'R1', target: 'kj:x#R1', type: 'dependency' }] })))
    .toMatch(/links\.0: unknown argument type: it takes source_element, element, target, kind/);
  expect(await rejection(call(admin, 'admin_add_actor', { id: 'x', role: 'product' }))).toMatch(/unknown argument role: it takes id, name, owner/);
  // Every verb Kolab serves is strict, so none drops an argument (additionalProperties: false in its schema).
  const tools = (await admin.listTools()).tools;
  expect(tools.length).toBeGreaterThan(60);
  for (const t of tools) expect([t.name, (t.inputSchema as { additionalProperties?: unknown }).additionalProperties]).toStrictEqual([t.name, false]);
}, 120_000);

test('a test run\'s evidence takes a summary, as konjir_add_evidence says; and no refusal Kolab serves ends in \'..\' (WRK5, W5.7)', async () => {
  const { pm, eng, actor } = await kolabWithWork();
  await call(pm.c, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }] });
  await call(pm.c, 'submit_for_review', { node: 'orders', version: 1 });
  await call(eng.c, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await call(eng.c, 'draft', { node: 'orders-pg', elements: [{ id: 'W1', text: 'Build the endpoint.', work: { done_when: 'It cancels.' } }],
    links: [{ source_element: 'W1', target: 'kj:orders@1#R1' }] });
  await call(eng.c, 'submit_for_review', { node: 'orders-pg', version: 1 });
  const lead = await actor('lead', 'engineer', 'maintain');
  await call(lead.c, 'register_repository', { url: 'https://github.com/acme/orders', root_sha: 'f'.repeat(40), binding: 'orders-pg' });
  await call(eng.c, 'pull_work', {});
  expect(await call(eng.c, 'add_evidence', { work: 'kj:orders-pg#W1', evidence: [{ kind: 'test_run', summary: 'npm test: 120 passed' }] })).toMatchObject({ recorded: 1 });
  const read = await call(eng.c, 'read_work', { work: 'kj:orders-pg#W1' }) as { evidence: { kind: string; title: string }[] };
  expect(read.evidence).toMatchObject([{ kind: 'test_run', title: 'npm test: 120 passed' }]);

  // The M5 check's doubled full stops: an engine message that ends in one is served with one.
  const refusals = [
    await rejection(call(eng.c, 'add_evidence', { work: 'kj:orders-pg#W1', evidence: [{ kind: 'test_run', url: 'not a link' }] })),
    await rejection(call(eng.c, 'draft', { node: 'orders-pg', elements: [{ id: 'W2', text: 'Ship it.', work: { target_date: '2026-12-01' } }] })),
    await rejection(call(eng.c, 'read_work', { work: 'kj:other/orders-pg#W1' })),
  ];
  expect(refusals[0]).toMatch(/give an https link\. The review gate/);
  expect(refusals[1]).toMatch(/or leave the date out\. The review gate/);
  for (const r of refusals) expect(r).not.toMatch(/[^.]\.\.(?!\.)/);
}, 120_000);

test('no description, parameter or instruction Kolab serves holds a doubled full stop (W5.7)', async () => {
  const { pm } = await kolabWithWork();
  const tools = await servedTools();
  const texts = tools.flatMap((t) => [t.description ?? '', ...paramsOf(t).map((p) => p.description ?? '')]);
  for (const which of ['operating', 'reviewer']) {
    texts.push(((await call(pm.c, 'instructions', { which })) as string));
  }
  const doubled = texts.filter((t) => /[^.]\.\.(?![./])/.test(t)).map((t) => /.{0,60}[^.]\.\.(?![./]).{0,20}/s.exec(t)![0]);
  expect(doubled).toStrictEqual([]);
}, 120_000);

test('konjir tools lists each verb with its parameters, from the schemas; docs/verbs.md is generated from the same and up to date (W5.7)', async () => {
  const tools = await servedTools();
  const create = tools.find((t) => t.name === 'konjir_create_node')!;
  expect(usageLine(create)).toBe('create_node kind=<spec|prototype|binding|plan> title=<string> [id=<string>] [parent=<string>]');
  expect(toolsListing(tools)).toMatch(/^create_node kind=<spec\|prototype\|binding\|plan> title=<string> \[id=<string>\] \[parent=<string>\]\n {4}Create a node in your kolab\./m);
  expect(usageLine(tools.find((t) => t.name === 'konjir_add_evidence')!)).toMatch(/^add_evidence work=<string> evidence=<\[\{kind,sha\?,pr\?,url\?,title\?,summary\?,files\?,repo\?,checks\?\}\]>$/);
  // `npm run verbs` writes it; run it after changing a verb.
  const doc = readFileSync(fileURLToPath(new URL('../../../docs/verbs.md', import.meta.url)), 'utf8');
  expect(doc).toBe(verbsMarkdown(tools));

  // From a shell, over a running Kolab.
  const { server, eng } = await kolabWithWork();
  process.env.KONJIR_URL = server.url;
  process.env.KONJIR_TOKEN = eng.token;
  const out: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  await main(['tools']);
  expect(out.join('\n')).toMatch(/^pull_work \[binding=<string>\] \[plan=<string>\]$/m);
  await main(['help', 'create_node']);
  expect(out.at(-1)).toMatch(/^konjir create_node kind=<spec\|prototype\|binding\|plan> title=<string> \[id=<string>\] \[parent=<string>\]\n/);
}, 120_000);

test('a reviewer lists the links of the version waiting for it with lineage version=; deltas on a first version sent back say to send the full list (W5.7)', async () => {
  const { pm, eng, actor } = await kolabWithWork();
  const pm2 = await actor('pm2', 'product');
  const eng2 = await actor('eng2', 'engineer');
  await call(pm.c, 'create_node', { kind: 'spec', title: 'Orders', id: 'orders' });
  await call(pm.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'Orders ship in a day.' }] });
  await call(pm.c, 'submit_for_review', { node: 'orders', version: 1 });
  // Changes requested on the spec's first version: nothing has committed, so deltas have nothing to apply to.
  await call(pm2.c, 'review', { node: 'orders', version: 1, verdict: 'request_changes', note: 'Split R2.' });
  expect(await rejection(call(pm.c, 'draft', { node: 'orders', deltas: [{ kind: 'override', element: 'R2', text: 'Orders ship within a day.' }] })))
    .toMatch(/cannot override R2: not in parent\. Deltas apply to the latest committed version, and orders has none yet \(a version sent back for changes never committed\): send the full element list \(elements\) instead/);
  await call(pm.c, 'draft', { node: 'orders', elements: [{ id: 'R1', text: 'Orders can be cancelled.' }, { id: 'R2', text: 'Orders ship within a day.' }] });
  await call(pm.c, 'submit_for_review', { node: 'orders', version: 2 });
  await call(pm2.c, 'review', { node: 'orders', version: 2, verdict: 'approve' });
  // With a committed base, a delta naming no element of it is most likely a mistyped id.
  expect(await rejection(call(pm.c, 'draft', { node: 'orders', deltas: [{ kind: 'remove', element: 'R3' }] })))
    .toMatch(/cannot remove R3: not in parent\. The version this draft builds on has no element R3: check its id \(it has R1, R2\)\. If R3 was new in a draft that came back, add it again \(kind add\)/);

  await call(eng.c, 'create_node', { kind: 'binding', title: 'On Postgres', id: 'orders-pg' });
  await call(eng.c, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'A cancel endpoint.' }], links: [{ source_element: 'b1', target: 'kj:orders@2#R1' }] });
  expect(await call(eng.c, 'submit_for_review', { node: 'orders-pg', version: 1 })).toMatchObject({ in_review: 'kj:orders-pg@1' });
  // Nothing of the binding has committed, so lineage without version has nothing to walk; with it, the reviewer reads the links.
  expect(await rejection(call(eng2.c, 'lineage', { node: 'orders-pg', direction: 'upstream' }))).toMatch(/orders-pg has no committed version/);
  expect(await call(eng2.c, 'lineage', { node: 'orders-pg', version: 1, direction: 'upstream' }))
    .toMatchObject({ node: 'orders-pg', version: 1, edges: [{ kind: 'dependency', source: 'kj:orders-pg@1#b1', target: 'kj:orders@2#R1' }], next: null });
  expect(await rejection(call(eng2.c, 'lineage', { node: 'orders-pg', version: 9, direction: 'upstream' }))).toMatch(/orders-pg has no version 9/);
  const reviewer = await call(eng2.c, 'instructions', { which: 'reviewer' }) as string;
  expect(reviewer).toMatch(/konjir_lineage node=<node> version=<version> direction=upstream/);
  // version= walks one version's own links: upstream only.
  expect(await rejection(call(eng2.c, 'lineage', { node: 'orders-pg', version: 1, direction: 'downstream' }))).toMatch(/version= walks one version's links upstream/);
}, 120_000);

test('every `konjir_<verb> key=…` and `konjir <verb> key=…` Kolab serves or documents names only arguments the verb takes (W5.7)', async () => {
  // What a next step, a refusal, a description, the instructions, the README or the hands-on tells
  // an agent to type: each key=value example, checked against the schema the verb is served with.
  const params = new Map((await servedTools()).map((t) => [t.name.replace(/^konjir_/, ''), paramsOf(t).map((p) => p.name)]));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  const files = ['apps/server/src', 'libs/engine/src', 'apps/cli/src', 'apps/channel-bridge/src', 'libs/types/src', 'libs/login/src']
    .flatMap((d) => walk(join(root, d))).concat([join(root, 'site/src/hands-on.md'), join(root, 'README.md')]);
  const example = /konjir[_ ]([a-z][a-z_]*)((?:[ \t]+[a-z_]+=(?:"[^"]*"|'[^']*'|\[[^\]]*\]|\{[^}]*\}|[^\s`'"]+))+)/g;
  const wrong: string[] = [];
  let checked = 0;
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(example)) {
      const takes = params.get(m[1]);
      if (!takes) continue;
      checked++;
      const keys = [...m[2].matchAll(/(?:^|[ \t])([a-z_]+)=/g)].map((k) => k[1]);
      const bad = keys.filter((k) => !takes.includes(k));
      if (bad.length) wrong.push(`${f.slice(root.length)}: ${m[0].slice(0, 100)} (${bad.join(', ')})`);
    }
  }
  expect(checked).toBeGreaterThan(50);
  expect(wrong).toStrictEqual([]);
}, 120_000);
