// The instructions for an agent connected only over MCP, with no konjir CLI: its client shows the
// prompts to the person, not to the model, so the same texts are a tool, konjir_instructions, and
// two resources. Each serves exactly what the matching prompt serves, scoped to the session's kolab.
import { expect, test } from '@jest/globals';
import type { Client } from '@modelcontextprotocol/client';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, testStore } from '@konjir/engine/testing';

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
  await call(c, 'create_node', { kind: 'functional_spec', title: 'Spec', id: 'spec' });
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
  await server.close();
});
