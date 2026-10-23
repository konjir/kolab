// W3.8 (D61): the channel bridge is Claude Code's one Konjir server. It serves Kolab's own tools,
// resources and prompts, unchanged, passed through on its one sign-in, beside the channel, so the
// session's tool calls and its channel are one session (ENF4). End to end: Kolab in-process, the
// bridge as a child process on stdio (as Claude Code starts it), and this test as Claude Code.
// In-process: a call is sent once (never again after a timeout), and errors are masked.
import { expect, test } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startServer, type KonjirServer } from '@konjir/server';
import { closeAtEnd, testStore } from '@konjir/engine/testing';
import { KolabBridge } from '../src/bridge.js';
import { servePassthrough, type BridgeHolder, type LowServer } from '../src/passthrough.js';
import { mask } from '../src/sign-in.js';
import type { ChannelMessage } from '../src/messages.js';

const ADMIN = 'passthrough-test-admin';
const START = resolve(import.meta.dirname, '../scripts/start.sh');
/** A scratch home for each spawned bridge: none ever reaches the person's own ~/.config. */
const scratchHome = () => mkdtempSync(join(tmpdir(), 'konjir-home-'));

async function kolabClient(url: string, token: string) {
  const c = new Client({ name: 'passthrough-test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  closeAtEnd(c);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name: `konjir_${name}`, arguments: args });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return r.structuredContent as Record<string, unknown>;
}

async function until<T>(what: string, check: () => T | undefined, ms = 20_000, more = () => ''): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${more()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function boot() {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  closeAtEnd(server);
  return server;
}

/** An agent session token for `actor`, alone on its layer of kolab `test`. */
async function session(server: KonjirServer, actor: string, role: 'product' | 'engineer') {
  const admin = await kolabClient(server.url, ADMIN);
  await call(admin, 'admin_add_actor', { id: actor }).catch(() => undefined);
  await call(admin, 'admin_add_organization', { id: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write', layers: [role === 'product' ? 'functional' : 'technical'] });
  const { token } = await call(admin, 'admin_open_session', { actor, role }) as { token: string };
  await admin.close();
  return token;
}

/** The bridge as Claude Code starts it, and this test as Claude Code, with `options` for its client. */
async function bridge(url: string, token: string, env: Record<string, string> = {}, options: ConstructorParameters<typeof Client>[1] = {}) {
  const transport = new StdioClientTransport({
    command: START,
    env: { PATH: process.env.PATH ?? '', HOME: scratchHome(), XDG_CONFIG_HOME: scratchHome(), KONJIR_URL: url, KONJIR_TOKEN: token, KONJIR_CHANNEL_BACKOFF_MS: '100,1000', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr!.on('data', (d) => { stderr += String(d); });
  const messages: ChannelMessage[] = [];
  const listChanged: string[] = [];
  const claude = new Client({ name: 'claude-code-stand-in', version: '0' }, options);
  claude.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') messages.push(n.params as unknown as ChannelMessage);
    else listChanged.push(n.method);
  };
  await claude.connect(transport);
  closeAtEnd(claude);
  return { claude, messages, listChanged, stderr: () => stderr, more: () => `messages: ${JSON.stringify(messages, null, 2)}\nbridge stderr:\n${stderr}` };
}

test('done when, by token: Claude Code lists Kolab\'s tools, prompts and resources unchanged, calls them, and receives its channel messages, on one session', async () => {
  const server = await boot();
  const pm = await session(server, 'pm', 'product');
  const eng = await kolabClient(server.url, await session(server, 'eng', 'engineer'));
  const direct = await kolabClient(server.url, pm);
  const b = await bridge(server.url, pm);

  // The bridge declares the channel, and Kolab's tools, prompts and resources; nothing of its own.
  const caps = b.claude.getServerCapabilities()!;
  expect(caps.experimental).toStrictEqual({ 'claude/channel': {} });
  expect(caps.tools).toStrictEqual({ listChanged: true });
  expect(b.claude.getNegotiatedProtocolVersion()).toBe('2025-11-25');
  expect(b.claude.getInstructions()).toMatch(/Call konjir_instructions before your first change/);

  // Exactly Kolab's tools: names, descriptions, input and output schemas, annotations.
  const kolabTools = (await direct.listTools()).tools;
  const served = (await b.claude.listTools()).tools;
  expect(served.map((t) => t.name).sort()).toStrictEqual(kolabTools.map((t) => t.name).sort());
  expect(served.every((t) => t.name.startsWith('konjir_'))).toBe(true);
  const byName = new Map(kolabTools.map((t) => [t.name, t]));
  for (const t of served) {
    const k = byName.get(t.name)!;
    expect({ description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations })
      .toStrictEqual({ description: k.description, inputSchema: k.inputSchema, outputSchema: k.outputSchema, annotations: k.annotations });
  }
  expect((await b.claude.listPrompts()).prompts.map((p) => p.name).sort()).toStrictEqual((await direct.listPrompts()).prompts.map((p) => p.name).sort());
  expect((await b.claude.listResources()).resources.map((r) => r.uri).sort()).toStrictEqual((await direct.listResources()).resources.map((r) => r.uri).sort());

  // Calls go through as the bridge's own session: the one the channel listens as.
  expect((await b.claude.callTool({ name: 'konjir_whoami', arguments: {} })).structuredContent).toMatchObject({ actor: 'pm', role: 'product', kolab: 'test' });
  const rules = await b.claude.callTool({ name: 'konjir_instructions', arguments: {} });
  expect(rules.isError).toBeFalsy();
  expect(JSON.stringify(rules.content)).toStrictEqual(JSON.stringify((await direct.callTool({ name: 'konjir_instructions', arguments: {} })).content));
  const read = await b.claude.readResource({ uri: 'konjir://instructions' });
  expect(read.contents[0]).toMatchObject({ uri: 'konjir://instructions', mimeType: 'text/plain' });
  const prompt = (await direct.listPrompts()).prompts[0];
  expect((await b.claude.getPrompt({ name: prompt.name })).messages.length).toBeGreaterThan(0);

  // Work through the bridge; the engineer asks about it; the same session hears it on the channel.
  await call(b.claude, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(b.claude, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(b.claude, 'submit_for_review', { node: 'orders', version: 1 });
  await until('listening', () => /connected to Kolab/.test(b.stderr()) || undefined, 20_000, b.more);
  await call(eng, 'ask', { address: 'kj:orders#R8', question: 'From which statuses?' });
  const asked = await until('the question', () => b.messages.find((m) => m.content.includes('"From which statuses?"')), 20_000, b.more);
  expect(asked.meta).toMatchObject({ uri: 'konjir://inbox/test/functional', kind: 'inbox' });

  // A list pages through the bridge as it does direct: cursor and limit reach Kolab, and next comes back (W2.21, D71).
  await call(b.claude, 'create_node', { kind: 'functional_spec', title: 'Invoices', id: 'invoices' });
  const first = await call(b.claude, 'list_nodes', { limit: 1 }) as { nodes: { id: string }[]; next: string | null };
  expect(first.nodes).toHaveLength(1);
  expect(first.next).toEqual(expect.any(String));
  const rest = await call(b.claude, 'list_nodes', { limit: 1, cursor: first.next }) as { nodes: { id: string }[]; next: string | null };
  expect(rest).toStrictEqual(await call(direct, 'list_nodes', { limit: 1, cursor: first.next }));
  expect([...first.nodes, ...rest.nodes].map((n) => n.id).sort()).toStrictEqual(['invoices', 'orders']);
  expect(rest.next).toBeNull();

  // Kolab's own errors come back as Kolab gave them.
  const bad = await b.claude.callTool({ name: 'konjir_read_node', arguments: { node: 'nowhere' } });
  const kolabBad = await direct.callTool({ name: 'konjir_read_node', arguments: { node: 'nowhere' } });
  expect(bad).toStrictEqual(kolabBad);
  expect(b.stderr()).not.toContain(pm);
  await b.claude.close();
  await server.close();
}, 90_000);

test('both protocol eras: a client that negotiates 2026-07-28 over stdio, where the bridge serves it, gets the same tools and calls', async () => {
  const server = await boot();
  const pm = await session(server, 'pm', 'product');
  for (const [protocol, era] of [['legacy', '2025-11-25'], ['auto', '2026-07-28']] as const) {
    const b = await bridge(server.url, pm, { KONJIR_CHANNEL_PROTOCOL: protocol }, { versionNegotiation: { mode: 'auto' } });
    expect(b.claude.getNegotiatedProtocolVersion()).toBe(era);
    const tools = (await b.claude.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('konjir_instructions');
    expect((await b.claude.callTool({ name: 'konjir_whoami', arguments: {} })).structuredContent).toMatchObject({ actor: 'pm' });
    await b.claude.close();
  }
  await server.close();
}, 90_000);

/** The pass-through's handlers on a stand-in server, to call as Claude Code would. */
function handlers(bridge: KolabBridge) {
  const at = new Map<string, (request: { params: Record<string, unknown> }, ctx: { mcpReq: { signal: AbortSignal } }) => unknown>();
  const low: LowServer = {
    registerCapabilities: () => undefined,
    setRequestHandler: (method, h) => { at.set(method, h); },
    projectCallToolResult: (r) => r,
  };
  const holder: BridgeHolder = { bridge, ready: Promise.resolve(bridge), redact: (t) => bridge.redact(t) };
  servePassthrough({ server: low }, holder);
  return (method: string, params: Record<string, unknown>) => at.get(method)!({ params }, { mcpReq: { signal: new AbortController().signal } }) as Promise<Record<string, unknown>>;
}

test('a call that got no answer in time is never sent again: the session is told it may or may not have run', async () => {
  const server = await boot();
  const pm = await session(server, 'pm', 'product');
  let sent = 0;
  // Kolab receives the ask and never answers it, as a lost reply would look.
  const fetchStub: typeof fetch = (input, init) => {
    if (typeof init?.body === 'string' && init.body.includes('"method":"tools/call"') && init.body.includes('"konjir_ask"')) {
      sent++;
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return fetch(input, init);
  };
  let listens = 0;
  const b = new KolabBridge({ url: server.url, token: pm, fetch: fetchStub as never, forward: async () => undefined, log: () => undefined, passthrough: { callTimeoutMs: 500 } });
  b.onListening = () => { listens++; };
  closeAtEnd({ close: () => b.stop() });
  b.start();
  await until('listening', () => listens > 0 || undefined);
  const callTool = handlers(b);
  const r = await callTool('tools/call', { name: 'konjir_ask', arguments: { address: 'kj:orders#R8', question: 'Twice?' } });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toMatch(/Kolab didn't answer konjir_ask in time. The call was sent once and may or may not have run: check \(with a read\) before calling it again/);
  await new Promise((r) => setTimeout(r, 1000));
  expect(sent).toBe(1);
  await b.stop();
  await server.close();
}, 60_000);

test('errors from Kolab and the transport are masked, and Kolab\'s text is otherwise kept', async () => {
  const server = await boot();
  const pm = await session(server, 'pm', 'product');
  const secret = 'kjs_ThisIsASessionToken0123456789';
  const fetchStub: typeof fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const id = /"id":(\d+)/.exec(body)?.[1];
    if (body.includes('"konjir_draft"')) {   // a JSON-RPC error, naming the token the request carried and another
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: Number(id), error: { code: -32602, message: `draft refused for ${pm} and ${secret}: node is locked`, data: { token: pm } } }), { headers: { 'content-type': 'application/json' } });
    }
    if (body.includes('"konjir_link"')) return new Response(`upstream broke near Bearer ${pm}`, { status: 502 });   // the transport's error
    if (body.includes('"konjir_clear_mark"')) {   // a tool error result
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: Number(id), result: { resultType: 'complete', content: [{ type: 'text', text: `mark not found; your token ${pm} is fine` }], isError: true } }), { headers: { 'content-type': 'application/json' } });
    }
    return fetch(input, init);
  };
  let listens = 0;
  const b = new KolabBridge({ url: server.url, token: pm, fetch: fetchStub as never, forward: async () => undefined, log: () => undefined });
  b.onListening = () => { listens++; };
  closeAtEnd({ close: () => b.stop() });
  b.start();
  await until('listening', () => listens > 0 || undefined);
  const callTool = handlers(b);

  const refused = await (callTool('tools/call', { name: 'konjir_draft', arguments: {} }) as Promise<unknown>).then(() => undefined, (e: { code: number; message: string; data: unknown }) => e);
  expect(refused?.code).toBe(-32602);
  expect(refused?.message).toContain('draft refused for *** and ***: node is locked');
  expect(refused?.data).toStrictEqual({ token: '***' });
  const broke = await callTool('tools/call', { name: 'konjir_link', arguments: {} });
  expect(JSON.stringify(broke)).toContain('upstream broke near Bearer ***');
  const missing = await callTool('tools/call', { name: 'konjir_clear_mark', arguments: {} });
  expect(missing).toStrictEqual({ content: [{ type: 'text', text: 'mark not found; your token *** is fine' }], isError: true });
  for (const r of [refused, broke, missing]) expect(JSON.stringify(r) + String((r as { message?: string } | undefined)?.message)).not.toContain(pm);
  expect(mask(secret)).toBe('***');
  await b.stop();
  await server.close();
}, 60_000);

test('Kolab\'s lists are read one at a time, in order: a burst of list_changed costs one more read, and the latest read wins', async () => {
  const server = await boot();
  const pm = await session(server, 'pm', 'product');
  let lists = 0;
  let running = 0;
  let overlapped = false;
  const fetchStub: typeof fetch = async (input, init) => {
    if (typeof init?.body === 'string' && init.body.includes('"method":"tools/list"')) {
      lists++;
      if (++running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 100));
      try { return await fetch(input, init); } finally { running--; }
    }
    return fetch(input, init);
  };
  let listens = 0;
  const b = new KolabBridge({ url: server.url, token: pm, fetch: fetchStub as never, forward: async () => undefined, log: () => undefined });
  b.onListening = () => { listens++; };
  closeAtEnd({ close: () => b.stop() });
  b.start();
  await until('listening', () => listens > 0 || undefined);
  const before = lists;
  const inner = b as unknown as { refresh(c: unknown, kinds: string[]): Promise<void>; live: unknown };
  await Promise.all(Array.from({ length: 6 }, () => inner.refresh(inner.live, ['tools'])));
  expect(lists - before).toBe(2);   // the one running, and one more for the burst
  expect(overlapped).toBe(false);
  expect((await b.list('tools')).length).toBeGreaterThan(0);
  await b.stop();
  await server.close();
}, 60_000);

test('after a wrong_actor refusal, what an earlier connection listed is no longer served: the lists empty, and Claude Code is told they changed', async () => {
  const server = await boot();
  const pm = await session(server, 'pm', 'product');
  const b = new KolabBridge({ url: server.url, token: pm, agent: 'pm', forward: async () => undefined, log: () => undefined, backoff: { initialMs: 100, maxMs: 200 } });
  const changed: string[] = [];
  let listens = 0;
  b.onListening = () => { listens++; };
  b.onListChanged = (kind) => { changed.push(kind); };
  closeAtEnd({ close: () => b.stop() });
  b.start();
  await until('listening', () => listens > 0 || undefined);
  expect((await b.list('tools')).length).toBeGreaterThan(0);
  // The bridge now finds its credential works as someone else (as a swapped sign-in would).
  (b as unknown as { opts: { agent: string } }).opts.agent = 'someone-else';
  changed.length = 0;
  await (b as unknown as { client?: { close(): Promise<void> } }).client?.close();
  await until('the lists cleared', () => (changed.includes('tools') && changed.includes('prompts')) || undefined);
  expect(await b.list('tools', 100)).toStrictEqual([]);
  await b.stop();
  await server.close();
}, 60_000);
