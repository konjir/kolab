// What Kolab serves names its own nodes konstructs, or by their kind, never artifacts (API16, KON10);
// and the texts a reviewer and an engineer are given say what the binding decided, in each of them:
// REV7's split step and API17's case file.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, testStore } from '@konjir/engine/testing';
import { fillPlaybook, PLAYBOOK_KINDS, SPLIT_STEP } from '@konjir/engine';

const ADMIN = 'vocabulary-test-admin';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Phrases that name something outside Konjir, the only places "artifact" may stand (API16). */
const ALLOWED = [/\bCI (run's )?artifacts?\b/gi, /\bclaude\.ai artifacts?\b/gi];

/** Each text's "artifact"s that no allowed phrase covers, with a little of what is around them. */
function artifactsIn(texts: Record<string, string>): string[] {
  return Object.entries(texts).flatMap(([where, text]) => {
    const rest = ALLOWED.reduce((t, phrase) => t.replace(phrase, (m) => ' '.repeat(m.length)), text);
    return [...rest.matchAll(/artifact/gi)].map((m) => `${where}: …${text.slice(Math.max(0, m.index - 40), m.index + 48)}…`);
  });
}

const textOf = (blocks: unknown) => (blocks as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n');
const instructions = async (c: Client, args: Record<string, unknown>) => textOf((await c.callTool({ name: 'konjir_instructions', arguments: args })).content);

/** Everything a session is served over MCP: instructions, tools, prompts, resources and templates. */
async function served(c: Client, who: string): Promise<Record<string, string>> {
  const out: Record<string, string> = { [`${who} server instructions`]: c.getInstructions() ?? '' };
  for (const t of (await c.listTools()).tools) out[`${who} tool ${t.name}`] = JSON.stringify(t);
  for (const which of ['operating', 'reviewer']) out[`${who} which=${which}`] = await instructions(c, { which });
  for (const kind of PLAYBOOK_KINDS) out[`${who} playbook ${kind}`] = await instructions(c, { which: 'playbook', kind });
  for (const p of (await c.listPrompts()).prompts) {
    out[`${who} prompt ${p.name}`] = JSON.stringify(p) + (await c.getPrompt({ name: p.name })).messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
  }
  for (const r of (await c.listResources()).resources) out[`${who} resource ${r.uri}`] = JSON.stringify(r) + JSON.stringify((await c.readResource({ uri: r.uri })).contents);
  for (const r of (await c.listResourceTemplates()).resourceTemplates) out[`${who} template ${r.uriTemplate}`] = JSON.stringify(r);
  return out;
}

/** The source of what Kolab shows outside MCP: the web interface, the server's own pages and refusals, the CLI's output and help, sign-in's output, address parse errors, the migrations' refusals, and docs/verbs.md. */
function shown(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of ['apps/web/src', 'apps/server/src', 'apps/cli/src', 'apps/channel-bridge/src', 'libs/engine/src', 'libs/types/src', 'libs/login/src', 'libs/address/src', 'libs/db/src/migrations']) {
    for (const f of readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }).filter((f) => /\.(tsx?|html|css|sql)$/.test(f))) {
      out[`${dir}/${f}`] = readFileSync(join(ROOT, dir, f), 'utf8');
    }
  }
  out['docs/verbs.md'] = readFileSync(join(ROOT, 'docs/verbs.md'), 'utf8');
  return out;
}

async function boot() {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_actor', { id: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'anns', owner: 'ann' });
  const session = async (actor: string, role: 'product' | 'engineer') => {
    if (actor !== 'ann') {
      await call(admin, 'admin_add_actor', { id: actor });
      await call(admin, 'admin_grant', { kolab: 'anns', to: actor, level: 'write' });
    }
    const { token } = await call(admin, 'admin_open_session', { actor, role, kolab: 'anns' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  return { server, admin, session };
}

test('nothing Kolab serves or shows says "artifact", but for a phrase naming something outside Konjir, and a planted one is found (API16)', async () => {
  const { server, admin, session } = await boot();
  const ann = await session('ann', 'product');
  const bob = await session('bob', 'engineer');
  const texts = { ...(await served(ann, 'product')), ...(await served(bob, 'engineer')), ...(await served(admin, 'admin')), ...shown() };
  // It reads what it should: every tool, both layers' instructions, every playbook, the web's components.
  expect(Object.keys(texts)).toEqual(expect.arrayContaining([
    'product tool konjir_draft', 'engineer tool konjir_open_case', 'admin tool konjir_admin_grant', 'engineer which=reviewer', 'engineer playbook serve',
    'product prompt konjir_reviewer_instructions', 'product resource konjir://instructions', 'apps/web/src/components/NodeView.tsx', 'apps/server/src/web/web.controller.ts', 'docs/verbs.md',
  ]));
  expect(texts['engineer tool konjir_review']).toContain('"inputSchema"');
  expect(artifactsIn(texts)).toStrictEqual([]);

  // The check fails on a planted "artifact", in any text, whatever its case; an allowed phrase passes.
  expect(artifactsIn({ ...texts, 'engineer tool konjir_review': `${texts['engineer tool konjir_review']} Read the spec artifact.` }))
    .toStrictEqual([expect.stringMatching(/^engineer tool konjir_review: .*Read the spec artifact\./)]);
  expect(artifactsIn({ planted: 'Each Artifact is a node.' })).toHaveLength(1);
  expect(artifactsIn({ planted: 'A CI run\'s artifact, a CI artifact, and a claude.ai artifact.' })).toStrictEqual([]);
  expect(artifactsIn({ planted: 'A CI artifact, and an artifact.' })).toHaveLength(1);
  await server.close();
});

test('every text a reviewer is given carries the split step: the reviewer instructions, the review playbook, a review request\'s next and a submit\'s next (REV7)', async () => {
  const { server, session } = await boot();
  const ann = await session('ann', 'product');
  const cy = await session('cy', 'product');
  expect(SPLIT_STEP).toMatch(/one testable intent.*compound.*konjir_review verdict=request_changes, naming the elements to split in the note/);

  await call(ann, 'create_node', { kind: 'spec', title: 'Spec', id: 'spec' });
  await call(ann, 'draft', { node: 'spec', elements: [{ id: 'R1', text: 'Carts expire, and they are shared.' }] });
  const submitted = await call(ann, 'submit_for_review', { node: 'spec', version: 1 }) as { next: string };
  const request = (await call(cy, 'list_reviews', {}) as { for_you: { subject: string; next: string }[] }).for_you;
  expect(request.map((r) => r.subject)).toStrictEqual(['kj:spec@1']);

  const texts = {
    reviewer: await instructions(cy, { which: 'reviewer' }),
    prompt: (await cy.getPrompt({ name: 'konjir_reviewer_instructions' })).messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n'),
    reviewPlaybook: await instructions(cy, { which: 'playbook', kind: 'review' }),
    reviewJob: fillPlaybook('review', { kolab: 'anns', agent: 'ann-engineer-2', person: 'ann', item: 'kj:b@2', subject: 'version', author: 'ann-engineer-1', node: 'b', seq: 2 }),
    requestNext: request[0].next,
    submitNext: submitted.next,
  };
  for (const [where, text] of Object.entries(texts)) expect([where, text.includes(SPLIT_STEP)]).toStrictEqual([where, true]);
  // A compound element is no finding kind (REV2): the findings stay contradiction and layer_leak.
  expect(texts.reviewer).toMatch(/A compound element is not a finding kind/);
  await server.close();
});

test('an engineer that finds the spec can\'t be met as written is told the same in all three texts: the operating instructions, the build playbook and konjir_open_case (API17)', async () => {
  const { server, session } = await boot();
  const bob = await session('bob', 'engineer');
  const brief = { kolab: 'anns', agent: 'bob-engineer-1', person: 'bob', work: 'kj:b#W1', text: 'Do it.', trailer: 'Konjir-Work: kj:anns/b#W1' };
  const texts = {
    serverInstructions: bob.getInstructions() ?? '',
    operating: await instructions(bob, { which: 'operating' }),
    buildPlaybook: await instructions(bob, { which: 'playbook', kind: 'build' }),
    buildJob: fillPlaybook('build', { ...brief, repository: 'https://github.com/a/b' }),
    buildJobNoRepository: fillPlaybook('build', { ...brief, resumed: true }),
    // The tool's own description: the verb it names is the tool itself.
    openCase: `konjir_open_case: ${(await bob.listTools()).tools.find((t) => t.name === 'konjir_open_case')!.description}`,
  };
  const rule = [/can't be met as written/, /konjir_open_case/, /against the spec element|on the spec element/, /evidence \((konjir_open_case: )?commits, file and line, test runs\)/, /(never|don't) patch the behavior/];
  for (const [where, text] of Object.entries(texts)) {
    for (const part of rule) expect([where, part.source, part.test(text)]).toStrictEqual([where, part.source, true]);
  }
  await server.close();
});
