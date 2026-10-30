// The instructions for an agent connected only over MCP, with no konjir CLI: its client shows the
// prompts to the person, not to the model, so the same texts are a tool, konjir_instructions, and
// two resources. Each serves exactly what the matching prompt serves, scoped to the session's kolab.
import { expect, jest, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer } from '@konjir/server';
import { connect, call, main } from '../src/cli.js';
import { closeAtEnd, testStore } from '@konjir/engine/testing';
import { buildInstructions } from '@konjir/engine';

const ADMIN = 'instructions-test-admin';

const promptText = async (c: Client, name: string) => (await c.getPrompt({ name })).messages
  .map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
const toolText = async (c: Client, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name: 'konjir_instructions', arguments: args });
  expect(r.isError).toBeFalsy();
  return (r.content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n');
};
const resourceText = async (c: Client, uri: string) => {
  const r = await c.readResource({ uri });
  expect(r.contents.map((x) => [x.uri, x.mimeType])).toStrictEqual([[uri, 'text/plain']]);
  return (r.contents[0] as { text: string }).text;
};

async function boot() {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  const open = async (actor: string, kolab: string) => {
    await call(admin, 'admin_add_actor', { id: actor });
    await call(admin, 'admin_add_kolab', { name: kolab, owner: actor });
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'product', kolab }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return { client, token };
  };
  return { server, admin, open };
}

/** Precedent of a kolab's own: a ruling, and a question answered. */
async function precedent(c: Client, word: string) {
  await call(c, 'create_node', { kind: 'spec', title: 'Spec', id: 'spec' });
  await call(c, 'draft', { node: 'spec', elements: [{ id: 'R1', text: `The ${word} requirement.` }] });
  await call(c, 'submit_for_review', { node: 'spec', version: 1 });
  await call(c, 'rule', { address: 'kj:spec#R1', text: `Ruling private to ${word}.`, effect: 'keep_intent' });
  const { query } = await call(c, 'ask', { address: 'kj:spec#R1', question: `What does ${word} mean?` }) as { query: string };
  await call(c, 'answer_query', { query, answer: `Answer private to ${word}.` });
}

test('an agent with only MCP tools gets the full operating instructions with its own kolab\'s precedent, and never another\'s', async () => {
  const { server, admin, open } = await boot();
  const ann = await open('ann', 'anns');
  const bo = await open('bo', 'bos');
  await precedent(ann.client, 'alpha');
  await precedent(bo.client, 'bravo');

  const tools = (await ann.client.listTools()).tools;
  const tool = tools.find((t) => t.name === 'konjir_instructions')!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  expect(tool.inputSchema).toMatchObject({ properties: { which: { enum: ['operating', 'reviewer'] } } });
  expect((tool.inputSchema as { required?: string[] }).required ?? []).toStrictEqual([]);

  const text = await toolText(ann.client);
  expect(text).toBe(await toolText(ann.client, { which: 'operating' }));
  expect(text).toBe(await promptText(ann.client, 'konjir_operating_instructions'));
  expect(text).toMatch(/^Konjir holds the canonical specs/);
  expect(text).toMatch(/Rulings, newest first \(1\): kj:spec@1#R1: "Ruling private to alpha\."/);
  expect(text).toMatch(/What does alpha mean\?" -> "Answer private to alpha\./);
  expect(text).not.toMatch(/bravo/);

  const bos = await toolText(bo.client);
  expect(bos).toMatch(/Ruling private to bravo/);
  expect(bos).not.toMatch(/alpha/);

  // The admin token works in no kolab: the rules alone, as the prompt gives it.
  const forAdmin = await toolText(admin);
  expect(forAdmin).toBe(await promptText(admin, 'konjir_operating_instructions'));
  expect(forAdmin).toMatch(/Rulings, newest first \(0\): none yet/);
  expect(forAdmin).not.toMatch(/alpha|bravo/);

  // A kind it doesn't know is refused, as the schema says.
  const bad = await ann.client.callTool({ name: 'konjir_instructions', arguments: { which: 'admin' } }).catch((e: unknown) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
  expect(bad.isError).toBe(true);
  await server.close();
});

test('one actor in two kolabs: each session sees only its own kolab\'s precedent (TEN13)', async () => {
  const { server, admin, open } = await boot();
  // Ann holds Write in two kolabs, each with its own precedent. An actor has one open session at a
  // time, so she works in each in turn.
  const first = await open('ann', 'anns');
  await call(admin, 'admin_add_kolab', { name: 'teams', owner: 'ann' });
  await precedent(first.client, 'alpha');
  const check = async (c: Client, own: string, other: string) => {
    const text = await toolText(c);
    expect(text).toBe(await promptText(c, 'konjir_operating_instructions'));
    expect(text).toBe(await resourceText(c, 'konjir://instructions'));
    expect(text).toMatch(new RegExp(`Rulings, newest first \\(1\\): kj:spec@1#R1: "Ruling private to ${own}\\."`));
    expect(text).toMatch(new RegExp(`What does ${own} mean\\?" -> "Answer private to ${own}\\.`));
    expect(text).not.toMatch(new RegExp(other));
  };
  await check(first.client, 'alpha', 'bravo');
  await call(admin, 'admin_end_session', { token: first.token });

  const session = async (kolab: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor: 'ann', role: 'product', kolab }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return { client, token };
  };
  const inTeams = await session('teams');
  await precedent(inTeams.client, 'bravo');
  await check(inTeams.client, 'bravo', 'alpha');
  await call(admin, 'admin_end_session', { token: inTeams.token });

  // Back in her first kolab, after the second has its own precedent: still only the first's.
  const { client: again } = await session('anns');
  await check(again, 'alpha', 'bravo');
  await server.close();
});

test('a session that holds only Read gets no precedent and no question a mark raised (D49, D51), as list_queries gives it', async () => {
  const { server, admin, open } = await boot();
  const erin = await open('erin', 'other');
  await precedent(erin.client, 'alpha');
  // A ruling that changes the intent raises a question on the element, by its mark (D51); amending
  // the element settles it, answered.
  await call(erin.client, 'rule', { address: 'kj:spec#R1', text: 'Mark-raised ruling.', effect: 'change_intent' });
  const raised = (await call(erin.client, 'list_queries', {}) as { queries: { id: string; mark: string | null }[] }).queries.filter((q) => q.mark);
  expect(raised.length).toBe(1);
  await call(erin.client, 'draft', { node: 'spec', elements: [{ id: 'R1', text: 'The amended requirement.' }] });
  await call(erin.client, 'submit_for_review', { node: 'spec', version: 2 });
  const inside = await toolText(erin.client);
  expect(inside).toMatch(/Answered questions and notes \(2\)/);
  expect(inside).toMatch(/Mark-raised ruling/);

  await call(admin, 'admin_add_actor', { id: 'alice' });
  await call(admin, 'admin_grant', { kolab: 'other', to: 'alice', level: 'read' });
  const { token } = await call(admin, 'admin_open_session', { actor: 'alice', role: 'product', kolab: 'other' }) as { token: string };
  const alice = await connect(server.url, token);
  closeAtEnd(alice);
  const text = await toolText(alice);
  expect(text).toBe(await promptText(alice, 'konjir_operating_instructions'));
  expect(text).toBe(await resourceText(alice, 'konjir://instructions'));
  expect(text).toMatch(/Precedent on stale overrides \(0\): none yet/);
  expect(text).toMatch(/Rulings, newest first \(0\): none yet/);
  expect(text).toMatch(/Answered questions and notes \(1\): kj:spec@1#R1: asked "What does alpha mean\?" -> "Answer private to alpha\."/);
  expect(text).not.toMatch(/Answered by mark|Mark-raised|Ruling private/);
  // konjir_list_queries gives the same session the same: only the question a person asked (0022).
  const listed = (await call(alice, 'list_queries', { state: 'answered', all_layers: true }) as { queries: { question: string; mark: string | null }[] }).queries;
  expect(listed.map((q) => [q.question, q.mark])).toStrictEqual([['What does alpha mean?', null]]);
  await server.close();
});

test('the instructions print the newest 20 answered questions, and say how many there are in all', async () => {
  const { server, open } = await boot();
  const ann = await open('ann', 'anns');
  await call(ann.client, 'create_node', { kind: 'spec', title: 'Spec', id: 'spec' });
  await call(ann.client, 'draft', { node: 'spec', elements: [{ id: 'R1', text: 'The requirement.' }] });
  await call(ann.client, 'submit_for_review', { node: 'spec', version: 1 });
  for (let i = 1; i <= 22; i++) {
    const { query } = await call(ann.client, 'ask', { address: 'kj:spec#R1', question: `Q${i}?` }) as { query: string };
    await call(ann.client, 'answer_query', { query, answer: `A${i}.` });
  }
  const text = await toolText(ann.client);
  expect(text).toMatch(/Answered questions and notes \(newest 20 of 22\): kj:spec@1#R1: asked "Q3\?" -> "A3\."/);
  expect(text).toMatch(/"Q22\?" -> "A22\."$/);
  expect(text).not.toMatch(/"Q[12]\?"/);
  await server.close();
});

test('the reviewer variant is the reviewer prompt, for every session and the admin token', async () => {
  const { server, admin, open } = await boot();
  const ann = await open('ann', 'anns');
  const reviewer = await toolText(ann.client, { which: 'reviewer' });
  expect(reviewer).toMatch(/^Konjir reviewer instructions\./);
  expect(reviewer).toBe(await promptText(ann.client, 'konjir_reviewer_instructions'));
  expect(await toolText(admin, { which: 'reviewer' })).toBe(reviewer);
  await server.close();
});

test('the resources konjir://instructions and konjir://instructions/reviewer hold the same texts, and no listen stream may ask for them', async () => {
  const { server, admin, open } = await boot();
  const ann = await open('ann', 'anns');
  await precedent(ann.client, 'alpha');

  const listed = (await ann.client.listResources()).resources.map((r) => r.uri);
  expect(listed).toEqual(expect.arrayContaining(['konjir://instructions', 'konjir://instructions/reviewer']));
  const operating = await resourceText(ann.client, 'konjir://instructions');
  expect(operating).toBe(await toolText(ann.client));
  expect(operating).toMatch(/Ruling private to alpha/);
  expect(await resourceText(ann.client, 'konjir://instructions/reviewer')).toBe(await toolText(ann.client, { which: 'reviewer' }));
  expect(await resourceText(admin, 'konjir://instructions')).toBe(await promptText(admin, 'konjir_operating_instructions'));

  // They are read, never pushed: a session's listen stream that asks for one is refused, as for
  // anything but its own kolab's inboxes and answers (D50).
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ann.token}`,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'subscriptions/listen',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'i:1', method: 'subscriptions/listen',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} }, notifications: { resourceSubscriptions: ['konjir://instructions'] } },
    }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id: 'i:1', error: { code: -32003, data: { reason: 'not_subscribable' } } });
  await server.close();
});

test('the server instructions tell an MCP session to call konjir_instructions first, and name the prompts and the CLI only as alternatives', async () => {
  const { server, open } = await boot();
  const ann = await open('ann', 'anns');
  const served = ann.client.getInstructions() ?? '';
  expect(served).toMatch(/Before your first change, call the konjir_instructions tool/);
  expect(served).toMatch(/Before reviewing a version, call konjir_instructions which=reviewer/);
  expect(served.indexOf('konjir_instructions')).toBeLessThan(served.indexOf('konjir_operating_instructions'));
  expect(served).toMatch(/Alternatives: a person can invoke them as the konjir_operating_instructions and konjir_reviewer_instructions prompts, and an agent working in a shell with the konjir CLI can run `konjir instructions`/);
  // No advice to run the CLI is given as if every session had it.
  expect(served).not.toMatch(/run `konjir instructions` in a shell/);
  expect(served).not.toMatch(/Otherwise, while you wait on answers, run `konjir watch/);
  // Without subscriptions, rule 8 says when to check, and checks the inbox as well as the answers.
  expect(served).toMatch(/Otherwise, check both at the start of work, before finishing, and after each commit or submit: your inbox with konjir_list_queries, konjir_list_stale, konjir_list_cases and konjir_list_reviews, and your answers with konjir_list_queries mine=true and konjir_list_cases mine=true/);
  await server.close();
});

test('the CLI: konjir instructions, konjir instructions reviewer and konjir instructions which=reviewer', async () => {
  const { server, open } = await boot();
  const ann = await open('ann', 'anns');
  await precedent(ann.client, 'alpha');
  const env = { ...process.env };
  const out: string[] = [];
  const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  try {
    process.env.KONJIR_URL = server.url;
    process.env.KONJIR_TOKEN = ann.token;
    const run = async (...argv: string[]) => { out.length = 0; await main(argv); return out.join('\n'); };
    const operating = await promptText(ann.client, 'konjir_operating_instructions');
    const reviewer = await promptText(ann.client, 'konjir_reviewer_instructions');
    expect(await run('instructions')).toBe(operating);
    expect(await run('instructions', 'which=operating')).toBe(operating);
    expect(await run('instructions', 'reviewer')).toBe(reviewer);
    expect(await run('instructions', 'which=reviewer')).toBe(reviewer);
    await expect(main(['instructions', 'admin'])).rejects.toThrow(/no instructions "admin"/);
  } finally {
    log.mockRestore();
    process.env = env;
  }
  await server.close();
});

test('the served instructions carry the build loop (W5.3; PLN11, CASE5): pull, build, the trailer, deliver, submit, review, at risk and revisit, as the tools and a job\'s instructions say', async () => {
  const { server, admin, open } = await boot();
  const ann = await open('ann', 'anns');
  // The server instructions every MCP session gets with its connection carry the loop in short (rule 9).
  const served = ann.client.getInstructions() ?? '';
  const rule9 = served.slice(served.indexOf('\n9. '));
  expect(rule9).toMatch(/^\n9\. Build work packages, never decisions \(engineer\)\./);
  for (const step of ['konjir_pull_work', 'konjir_read_work', 'git commit --trailer "Konjir-Work: kj:<kolab>/<binding>#<id>"', 'konjir work deliver <work> --submit',
    'konjir_submit_work', 'konjir_review work=<work>', 'konjir_reopen_work']) {
    expect(rule9).toContain(step);
  }
  // In that order: pull, read, commit with the trailer, deliver, review.
  const at = (s: string) => rule9.indexOf(s);
  expect(at('konjir_pull_work')).toBeLessThan(at('konjir_read_work'));
  expect(at('konjir_read_work')).toBeLessThan(at('git commit --trailer'));
  expect(at('git commit --trailer')).toBeLessThan(at('konjir work deliver'));
  expect(at('konjir work deliver')).toBeLessThan(at('konjir_review work='));
  // PLN11: work with nothing behind it is a question to the binding layer, not a work package.
  expect(rule9).toMatch(/Work with no spec element to serve and no decision to rely on is a question to the binding layer \(konjir_ask the binding\), not a work package/);
  // CASE5: a spec that can't be met as written gets a case file with evidence, never a patch; and ask in Konjir, not the person.
  expect(served).toMatch(/If, building it, you find the spec can't be met as written, raise a case file against the spec element with your evidence \(konjir_open_case: commits, file and line, test runs\), and don't patch the behavior\./);
  expect(served).toMatch(/don't stop to ask whoever runs you instead/);
  expect(served).toMatch(/an open question or case file blocks pulling the work packages that serve or rely on its element/);

  // The full operating instructions spell the loop out step by step, with reviewing work and at risk.
  const text = await toolText(ann.client);
  const loop = text.slice(text.indexOf('The build loop (engineer), step by step:'));
  for (let n = 1; n <= 7; n++) expect(loop).toMatch(new RegExp(`\\n {2}${n}\\. `));
  expect(loop).toMatch(/konjir work deliver <work> --submit, adding --pr <url> for a pull request and --test "<the test command: its result>"/);
  expect(loop).toMatch(/Submitting needs at least one commit or pull request\./);
  expect(loop).toMatch(/konjir_ask the element now, with from=<the package>/);
  expect(loop).toMatch(/konjir_open_case on the spec element with your evidence and don't patch the behavior/);
  expect(loop).toMatch(/a job stops after its one item/);
  expect(text).toMatch(/Reviewing work: .*konjir_review work=<work> verdict=approve note=.*verdict=request_changes note=/);
  expect(text).toMatch(/At risk and revisit: .*konjir_clear_mark the mark \(recorded as confirmed, and it stays Done\).*konjir_reopen_work work=<work> note=/);
  expect(text).toMatch(/marked_downstream/);
  expect(text).toMatch(/work you would propose with neither behind it is a question to the binding layer \(konjir_ask on the binding\), not a work package; Kolab doesn't check this, so its reviewer does/);
  // The reviewer instructions send such a package back.
  expect(await toolText(ann.client, { which: 'reviewer' })).toMatch(/request changes for a work package that serves no spec element and relies on no decision/);

  // The tools say the same: open_case no longer says it blocks nothing, and a submit's next step tells a job to stop.
  const tools = (await ann.client.listTools()).tools;
  const describe = (name: string) => tools.find((t) => t.name === name)!.description!;
  expect(describe('konjir_open_case')).not.toMatch(/blocks nothing/);
  expect(describe('konjir_open_case')).toMatch(/until it is ruled no one can pull a work package that serves or relies on its element/);
  // A job's own instructions agree with the served loop: the same trailer, deliver --submit, and a case file rather than a patch.
  const job = buildInstructions({ kolab: 'anns', agent: 'ann-engineer-1', person: 'ann', work: 'kj:b#W1', text: 'Do it.', trailer: 'Konjir-Work: kj:anns/b#W1', repository: 'https://github.com/a/b' });
  expect(job).toContain('git commit --trailer "Konjir-Work: kj:anns/b#W1"');
  expect(job).toContain('konjir work deliver kj:b#W1 --submit');
  expect(job).toMatch(/a commit alone is evidence enough/);
  expect(job).toMatch(/konjir_ask \(from=kj:b#W1\)/);
  expect(job).toMatch(/open a case file on its element with your evidence \(konjir_open_case\) and don't patch the behavior/);
  expect(await toolText(admin)).toContain('The build loop (engineer), step by step:');
  await server.close();
});

test('konjir help shows the build loop, in the order the served instructions give it (W5.3)', async () => {
  const out: string[] = [];
  const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  try {
    await main(['help']);
  } finally {
    log.mockRestore();
  }
  const help = out.join('\n');
  const build = help.slice(help.indexOf('Build:'), help.indexOf('Git:'));
  expect(build).toMatch(/^Build: {5}the loop for an engineer \(konjir instructions has it step by step\)/);
  const flat = build.replace(/\n +/g, ' ');
  const steps = ['konjir pull_work', 'konjir read_work', 'git commit --trailer "Konjir-Work: kj:<kolab>/<binding>#<id>"', 'konjir work deliver <work> --submit',
    'konjir review', 'konjir open_case', 'konjir reopen_work'];
  for (const s of steps) expect(flat).toContain(s);
  for (let i = 1; i < steps.length; i++) expect(flat.indexOf(steps[i - 1])).toBeLessThan(flat.indexOf(steps[i]));
});
