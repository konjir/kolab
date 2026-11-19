// Who connects to /mcp is logged (mcpClients): each client's own name and version, at initialize (a
// 2025-era client) and at server/discover (a 2026-07-28 one), once Kolab has answered it, and
// nothing else of the request; a request that isn't answered, or isn't one of those, logs nothing.
import { EventEmitter } from 'node:events';
import { expect, test } from '@jest/globals';
import { createLogger, type LogLevel } from '@konjir/log';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import { mcpClients } from '../src/mcp-clients.js';
import { startServer } from '../src/server.js';

const MODERN = '2026-07-28';

/** What a client sends as it connects: a 2025-era initialize, or a 2026-07-28 server/discover with its envelope. */
function connecting(era: 'initialize' | 'discover', clientInfo: unknown): { headers: Record<string, string>; body: { jsonrpc: '2.0'; id: string | number; method: string; params: { _meta?: Record<string, unknown> } & Record<string, unknown> } } {
  if (era === 'initialize') {
    return { headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo } } };
  }
  return {
    headers: { 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' },
    body: {
      jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': clientInfo,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  };
}

/** Kolab's info lines (stdout) while `fn` runs, parsed. */
async function logged(fn: () => Promise<void>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = original; }
  return lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } }).filter((l) => l.event === 'mcp_client');
}

test('each client that connects is logged, by the name and version it gives, in either era; one refused, or any other request, is not', async () => {
  const kolab = await openKolab();
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null });
  closeAtEnd(server);
  const post = (token: string | null, { headers, body }: { headers: Record<string, string>; body: unknown }) => fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => { await r.text(); return r.status; });

  const lines = await logged(async () => {
    expect(await post('admin-token', connecting('discover', { name: 'konnect', version: '0.8.0' }))).toBe(200);
    expect(await post('admin-token', connecting('initialize', { name: 'konjir-cli', version: '0.6.0' }))).toBe(200);
    // No token, or one that doesn't verify: refused (401) before Kolab answers, and not logged.
    expect(await post(null, connecting('discover', { name: 'nobody', version: '1' }))).toBe(401);
    expect(await post('kjs_not-a-session', connecting('initialize', { name: 'nobody', version: '2' }))).toBe(401);
    // Any other request isn't a connection.
    expect(await post('admin-token', { headers: { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: connecting('discover', { name: 'tools', version: '3' }).body.params._meta } } })).toBe(200);
  });
  expect(lines).toStrictEqual([
    { time: expect.any(String), level: 'info', message: 'an MCP client connected: konnect 0.8.0', event: 'mcp_client', client_name: 'konnect', client_version: '0.8.0' },
    { time: expect.any(String), level: 'info', message: 'an MCP client connected: konjir-cli 0.6.0', event: 'mcp_client', client_name: 'konjir-cli', client_version: '0.6.0' },
  ]);
});

test('a client\'s name and version are kept to 100 characters each, null when not given as text, and its other fields and the request\'s headers never logged', () => {
  const lines: [LogLevel, Record<string, unknown>][] = [];
  const mw = mcpClients(createLogger((level, line) => lines.push([level, JSON.parse(line)])));
  const answer = (body: unknown, status = 200) => {
    const res = Object.assign(new EventEmitter(), { statusCode: status });
    let nexted = false;
    mw({ body, headers: { authorization: 'Bearer kjs_secret1', 'x-forwarded-for': '203.0.113.9' } } as never, res as never, () => { nexted = true; });
    expect(nexted).toBe(true);
    res.emit('finish');
  };
  answer(connecting('initialize', { name: 'x'.repeat(300), version: 7, title: 'a title', websiteUrl: 'https://example.com' }).body);
  answer(connecting('discover', undefined).body);
  answer({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  answer(connecting('initialize', { name: 'a', version: '1' }).body, 500);
  answer([connecting('initialize', { name: 'batched', version: '1' }).body]);
  answer(undefined);
  expect(lines.map(([level, l]) => [level, l.message, l.client_name, l.client_version, Object.keys(l)])).toStrictEqual([
    ['info', `an MCP client connected: ${'x'.repeat(100)} (no version)`, 'x'.repeat(100), null, ['time', 'level', 'message', 'event', 'client_name', 'client_version']],
    ['info', 'an MCP client connected: (unnamed) (no version)', null, null, ['time', 'level', 'message', 'event', 'client_name', 'client_version']],
    ['info', 'an MCP client connected: (unnamed) (no version)', null, null, ['time', 'level', 'message', 'event', 'client_name', 'client_version']],
  ]);
  expect(JSON.stringify(lines)).not.toMatch(/kjs_|203\.0\.113|a title|example\.com/);
});
