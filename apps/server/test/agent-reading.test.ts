// A person reads their own agents' messages over MCP (Lee, 2026-11-22, PR #211): the four tools,
// the agent's state from what it said (konjir_say_state) feeding not_running_with_unread, the
// disclosure on the DM tools (readable_by, owner_reads), and the per-agent push prefs.
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { StubIdentity, startServer } from '../src/server.js';

const PROTOCOL = '2026-07-28';
const META = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };

async function serve(kolab: Kolab) {
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null, identity: new StubIdentity() });
  closeAtEnd(server);
  return server.url;
}

/** A tool's structured result, or its error's text. */
async function tool(mcp: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ ok?: Record<string, unknown>; error?: string }> {
  const res = await fetch(mcp, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } }),
  });
  const text = await res.text();
  const body = JSON.parse(text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)![1]) as { result?: { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> }; error?: { message: string } };
  if (body.error) return { error: body.error.message };
  return body.result!.isError ? { error: body.result!.content[0].text } : { ok: body.result!.structuredContent };
}

test('the owner reads their agent over MCP: its conversations, its messages, the activity and its status, with state from what it said; an agent and another person are refused; the DM tools say who else reads', async () => {
  const kolab = await openKolab();
  for (const id of ['ann', 'bo']) await kolab.addActor(id);
  await kolab.addActor('ann-claude', { owner: 'ann' });
  await kolab.createKolab('hub', { owner: 'ann' });
  for (const id of ['bo', 'ann-claude']) await kolab.grant('hub', id, 'write');
  const ann = await kolab.openSession('ann', 'product', { kolab: 'hub' });
  const bo = await kolab.openSession('bo', 'engineer', { kolab: 'hub' });
  const agent = await kolab.openSession('ann-claude', 'engineer', { kolab: 'hub' });
  const mcp = await serve(kolab);

  // Bo writes to Ann's agent; the send says Ann reads it, and so does the members list.
  const sent = await tool(mcp, bo, 'konjir_send_message', { to: 'ann-claude', message: 'can you take the importer?' });
  expect(sent.ok!.sent).toMatchObject({ to: 'ann-claude', readable_by: ['ann'] });
  const members = (await tool(mcp, bo, 'konjir_list_members')).ok!.members as { actor: string; owner_reads?: true }[];
  expect(members.find((m) => m.actor === 'ann-claude')).toMatchObject({ owner_reads: true });
  expect((await tool(mcp, bo, 'konjir_list_messages', { with: 'ann/claude' })).ok!.messages).toMatchObject([{ readable_by: ['ann'] }]);
  expect((await tool(mcp, bo, 'konjir_list_conversations')).ok!.conversations).toMatchObject([{ with: 'ann-claude', readable_by: ['ann'] }]);

  expect((await tool(mcp, ann, 'konjir_list_agent_conversations', { agent: 'claude' })).ok).toMatchObject({ agent: 'ann-claude', conversations: [{ with: 'bo', unread: 1, readable_by: ['ann'] }], next: null });
  expect((await tool(mcp, ann, 'konjir_list_agent_messages', { agent: 'ann/claude', with: 'bo' })).ok).toMatchObject({ agent: 'ann-claude', with: 'bo', messages: [{ message: 'can you take the importer?', read_at: null }], next: null });
  expect((await tool(mcp, ann, 'konjir_agent_activity')).ok).toMatchObject({ items: [{ kind: 'dm', agent: 'ann-claude', from: 'bo', to: 'ann-claude' }], next: null });

  // Nothing runs as it (it said nothing, and no stream of it listens): it has unread, so it needs Ann.
  const status = async () => ((await tool(mcp, ann, 'konjir_list_my_agents_status')).ok!.agents as { state: string | null; needs_you: { not_running_with_unread: number } }[])[0];
  expect(await status()).toMatchObject({ agent: 'ann-claude', label: 'claude', state: null, here: true, unread: 1, needs_you: { mentioned_unread: 0, capped: 0, not_running_with_unread: 1 } });
  // Once it says it is idle, it runs.
  expect((await tool(mcp, agent, 'konjir_say_state', { state: 'idle' })).error).toBeUndefined();
  expect(await status()).toMatchObject({ state: 'idle', needs_you: { not_running_with_unread: 0 } });
  // Reading left it unread.
  expect((await tool(mcp, agent, 'konjir_read_messages')).ok!.messages).toMatchObject([{ from: 'bo', readable_by: ['ann'] }]);

  for (const [who, token, name, args] of [
    ['agent', agent, 'konjir_list_agent_conversations', { agent: 'ann/claude' }], ['agent', agent, 'konjir_list_my_agents_status', {}],
    ['bo', bo, 'konjir_list_agent_messages', { agent: 'ann/claude', with: 'bo' }], ['bo', bo, 'konjir_agent_activity', { agent: 'ann/claude' }],
  ] as const) {
    expect([who, name, (await tool(mcp, token, name, args)).error]).toStrictEqual([who, name, expect.stringMatching(/is an agent: only a person reads|names no agent of yours/)]);
  }
  // Bo's own status lists no agent.
  expect((await tool(mcp, bo, 'konjir_list_my_agents_status')).ok).toStrictEqual({ kolab: 'hub', agents: [] });
});
