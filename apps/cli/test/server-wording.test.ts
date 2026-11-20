// Kolab words its errors for the client asking (step 1b of docs/plans/rebrand-and-site.md,
// apps/server/src/wording.ts): `kolab <command>` only for a client that says it is the kolab CLI,
// `konjir <command>` for any other, as published konnect and konjir read them. Here end to end, over
// MCP, with the SDK's own client: kolab's connect, and clients that call themselves what published
// konjir (konjir-cli) and konnect (konnect, and konjir-cli as it signs in) call themselves.
import { expect, test } from '@jest/globals';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WORDED_COMMANDS, startServer } from '@konjir/server';
import { KOLAB_COMMANDS } from '@konjir/channel-bridge/words';
import { closeAtEnd, testStore } from '@konjir/engine/testing';
import { call, connect } from '../src/cli.js';

const ADMIN = 'wording-test-admin';

/** A server, and a session of an agent's: an agent imports nothing, and the refusal names `konjir import` and `konjir login`. */
async function boot() {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_actor', { id: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'shop', owner: 'ann' });
  await call(admin, 'admin_add_actor', { id: 'ann-bot', owner: 'ann' });
  await call(admin, 'admin_grant', { kolab: 'shop', to: 'ann-bot', level: 'write' });
  const { token } = await call(admin, 'admin_open_session', { actor: 'ann-bot', role: 'product', kolab: 'shop' }) as { token: string };
  return { url: server.url, token };
}

/** A client of the SDK's that says it is `name`, in the era `mode` negotiates ('auto': 2026-07-28 with Kolab; none: 2025). */
async function clientAs(url: string, token: string, name: string, mode?: 'auto') {
  const client = new Client({ name, version: '0.1.0' }, mode ? { versionNegotiation: { mode } } : undefined);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  closeAtEnd(client);
  return client;
}

/** The refusal of an import by an agent, as `client` is told it. */
async function refusal(client: Client) {
  const r = await client.callTool({ name: 'konjir_import', arguments: { file: { kolab: 'shop' } } });
  expect(r.isError).toBe(true);
  return (r.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
}

test('an error names kolab login and kolab import for the kolab CLI, and konjir login and konjir import for konjir-cli, konnect or any other client', async () => {
  const { url, token } = await boot();
  const kolab = await refusal(await connect(url, token));
  expect(kolab).toContain('a person imports a kolab, from their own session (kolab import, signed in as themselves with kolab login)');
  expect(kolab).not.toMatch(/konjir (import|login)/);
  for (const name of ['konjir-cli', 'konnect', 'claude-code', 'kolab-ish', 'Kolab']) {
    const told = await refusal(await clientAs(url, token, name, 'auto'));
    expect([name, told]).toStrictEqual([name, expect.stringContaining('a person imports a kolab, from their own session (konjir import, signed in as themselves with konjir login)')]);
  }
  // A tool's name, and phrasing about kolabs, are the same for every client: only the command's name changes.
  expect(kolab).toContain('AccessError: ann-bot is an agent, and an agent imports nothing');
});

test('calls from kolab and from konnect at once, interleaved over HTTP, are each worded for their own client', async () => {
  const { url, token } = await boot();
  const [kolab, konnect] = [await connect(url, token), await clientAs(url, token, 'konnect', 'auto')];
  const who = Array.from({ length: 30 }, (_, i) => (i % 2 ? 'konnect' : 'kolab'));
  const told = await Promise.all(who.map((w) => refusal(w === 'kolab' ? kolab : konnect)));
  expect(told.map((t, i) => [who[i], /\((kolab|konjir) import, signed in as themselves with (kolab|konjir) login\)/.exec(t)?.slice(1)]))
    .toStrictEqual(who.map((w) => [w, w === 'kolab' ? ['kolab', 'kolab'] : ['konjir', 'konjir']]));
});

test('the server words the same commands the kolab CLI rewords itself: one list, held equal here', () => {
  expect([...WORDED_COMMANDS].sort()).toStrictEqual([...KOLAB_COMMANDS].sort());
});

test('a 2025-era client says who it is only at initialize, and Kolab is stateless, so even one called kolab gets the old wording on its calls', async () => {
  const { url, token } = await boot();
  const told = await refusal(await clientAs(url, token, 'kolab'));
  expect(told).toContain('(konjir import, signed in as themselves with konjir login)');
});
