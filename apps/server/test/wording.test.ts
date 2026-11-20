// How Kolab's errors name the CLI's commands (step 1b of docs/plans/rebrand-and-site.md): `kolab
// <command>` only for a client that opts in by saying it is the kolab CLI, `konjir <command>` for
// every other, as published konnect and konjir read them. End to end over MCP in
// apps/cli/test/server-wording.test.ts, and over OAuth in setup.test.ts.
import { expect, test } from '@jest/globals';
import { AccessError } from '@konjir/engine';
import { fail } from '../src/results.js';
import { clientInfoOf, currentWording, mcpWording, mcpWordingMiddleware, oauthWording, worded } from '../src/wording.js';

test('worded says each konjir <command> as kolab <command> for kolab, and leaves the text as it is for konjir', () => {
  const text = 'Run konjir connect again; konjir login --kolab k, then konjir import again; konjir work deliver kj:b#W1 --submit; '
    + 'konjir repo register --binding b; (konjir archive_agent label=<label>); konjir admin_open_session actor=you';
  expect(worded(text, 'konjir')).toBe(text);
  expect(worded(text, 'kolab')).toBe('Run kolab connect again; kolab login --kolab k, then kolab import again; kolab work deliver kj:b#W1 --submit; '
    + 'kolab repo register --binding b; (kolab archive_agent label=<label>); kolab admin_open_session actor=you');
  // Tools, addresses, scopes, entries, paths, the product and phrasing about kolabs are never touched.
  const kept = 'konjir_whoami, konjir_record_release work=kj:b#W1, konjir://answers/k/a, kj:konjir/x, konjir kolab:k role:product, '
    + 'konjir choose:kolab, konjir-product, ~/.config/konjir/, @konjir/kolab, the konjir CLI, Konjir connect, konjir connected, '
    + 'only the owner of kolab k can archive it, ann is not a member of kolab k, so a message can\'t mention them';
  expect(worded(kept, 'kolab')).toBe(kept);
});

test('an MCP client opts in only by saying it is kolab, exactly; anything else, published konjir\'s and konnect\'s names among them, keeps the old wording', () => {
  expect(mcpWording('kolab')).toBe('kolab');
  for (const name of ['konjir-cli', 'konnect', 'konjir-channel-bridge', 'claude-code', 'Kolab', 'kolab ', 'kolab-cli', '', undefined, null, 7, { name: 'kolab' }]) {
    expect([name, mcpWording(name)]).toStrictEqual([name, 'konjir']);
  }
});

test('an OAuth client opts in by the name it registered with: kolab, or kolab and a space; any other, or none, keeps the old wording', () => {
  for (const name of ['kolab', 'kolab CLI', 'kolab connect', 'kolab channel (Claude Code)']) expect([name, oauthWording(name)]).toStrictEqual([name, 'kolab']);
  for (const name of ['konjir CLI', 'konjir connect', 'konjir channel (Claude Code)', 'konnect', 'konnect agent', 'Claude Code', 'kolabs', 'Kolab CLI', '', undefined, null]) {
    expect([name, oauthWording(name)]).toStrictEqual([name, 'konjir']);
  }
});

test('the client a request names: an initialize\'s clientInfo, or the clientInfo in a 2026-07-28 request\'s _meta; none for a batch or a request without one', () => {
  const meta = (info: unknown) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'konjir_whoami', _meta: { 'io.modelcontextprotocol/clientInfo': info } } });
  expect(clientInfoOf({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'kolab', version: '1' } } })).toStrictEqual({ name: 'kolab', version: '1' });
  expect(clientInfoOf(meta({ name: 'kolab', version: '0.9.0' }))).toStrictEqual({ name: 'kolab', version: '0.9.0' });
  for (const body of [meta('kolab'), meta(undefined), [meta({ name: 'kolab' })], { method: 'tools/call' }, { params: 'x' }, undefined, null, 'kolab']) {
    expect(clientInfoOf(body)).toBeUndefined();
  }
});

test('a tool\'s error is worded for the request it answers, by McpWording; outside a request, the old wording', async () => {
  const told = (e: Error) => fail(e).content[0].text;
  const error = new AccessError('a person imports a kolab, from their own session (konjir import, signed in as themselves with konjir login)');
  expect(currentWording()).toBe('konjir');
  expect(told(error)).toBe('AccessError: a person imports a kolab, from their own session (konjir import, signed in as themselves with konjir login). '
    + 'Your access to this kolab does not allow it. Access is granted by an admin of the kolab; do not retry unchanged.');
  const answer = (body: unknown) => new Promise<string>((resolve) => {
    // The answer comes later, after awaits, as a tool's does: the wording holds through them.
    mcpWordingMiddleware({ body } as never, {} as never, () => { void Promise.resolve().then(() => resolve(told(error))); });
  });
  const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name, version: '1' } } } });
  expect(await answer(call('kolab'))).toContain('(kolab import, signed in as themselves with kolab login).');
  expect(await answer(call('konnect'))).toContain('(konjir import, signed in as themselves with konjir login).');
  expect(await answer(call('konjir-cli'))).toContain('(konjir import, signed in as themselves with konjir login).');
  expect(await answer({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toContain('(konjir import, signed in as themselves with konjir login).');
  expect(currentWording()).toBe('konjir');
});

test('requests answered at once, interleaved, each across timers, are each worded for their own client: the wording is the request\'s, never shared', async () => {
  const error = new AccessError('a person imports a kolab, from their own session (konjir import, signed in as themselves with konjir login)');
  const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name, version: '1' } } } });
  // Each request's answer waits a timer of its own (a macrotask, as a database round trip over the
  // network is), so the others start and finish meanwhile, in an order the timers decide.
  const answer = (name: string) => new Promise<string>((resolve) => {
    mcpWordingMiddleware({ body: call(name) } as never, {} as never, () => {
      setTimeout(() => { void Promise.resolve().then(() => resolve(fail(error).content[0].text)); }, Math.floor(Math.random() * 20));
    });
  });
  const names = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 'konnect' : i % 3 === 1 ? 'kolab' : 'konjir-cli'));
  const told = await Promise.all(names.map(answer));
  expect(told.map((t, i) => [names[i], /\((kolab|konjir) import, signed in as themselves with (kolab|konjir) login\)/.exec(t)?.slice(1)]))
    .toStrictEqual(names.map((n) => [n, n === 'kolab' ? ['kolab', 'kolab'] : ['konjir', 'konjir']]));
  expect(currentWording()).toBe('konjir');
});
