// Hosts over MCP, as konnect calls them (migration 0055): konjir_serve_host, konjir_ask_host,
// konjir_answer_host, konjir_read_host_request, konjir_list_hosts and konjir_end_host, with their
// arguments and results as the contract fixes them. A person's own session only; never an agent's.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';
const KEY = 'k'.repeat(43);
const I1 = '0123456789abcdef0123456789abcdef';

test('a person serves a host, asks it, it takes and answers, and the asker reads the answer over MCP; an agent, another person and a bad argument are refused', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  for (const id of ['ann', 'bo']) await call(admin, 'admin_add_actor', { id });
  await call(admin, 'admin_add_actor', { id: 'ann-claude', owner: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'hub', owner: 'ann' });
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'ann-claude', level: 'write' });
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'bo', level: 'write' });
  const session = async (actor: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'engineer', kolab: 'hub' }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  const ann = await session('ann');
  const agent = await session('ann-claude');
  const bo = await session('bo');

  const host = { name: 'laptop', folder: '/home/ann', serving: true, started_at: expect.any(String), seen_at: expect.any(String), agents: ['claude'], running: [], public_key: KEY };
  expect(await call(ann, 'serve_host', { name: 'laptop', instance: I1, public_key: KEY, folder: '/home/ann', agents: ['claude'], running: [] }))
    .toStrictEqual({ host, requests: [] });
  expect(await call(ann, 'list_hosts', {})).toStrictEqual({ hosts: [host] });

  const asked = await call(ann, 'ask_host', { host: 'laptop', kind: 'start', body: 'sealed' }) as { request: string; expires_at: string };
  expect(asked).toStrictEqual({ request: expect.stringMatching(/^[a-f0-9]{32}$/), expires_at: expect.any(String) });
  expect(await call(ann, 'read_host_request', { request: asked.request })).toStrictEqual({
    request: { id: asked.request, host: 'laptop', kind: 'start', state: 'waiting', requested_at: expect.any(String), expires_at: asked.expires_at },
  });
  expect(await call(ann, 'serve_host', { name: 'laptop', instance: I1, public_key: KEY })).toStrictEqual({
    host: { ...host, folder: null, agents: [] },
    requests: [{ id: asked.request, kind: 'start', body: 'sealed', from: 'ann', requested_at: expect.any(String), expires_at: asked.expires_at }],
  });
  expect(await call(ann, 'answer_host', { request: asked.request, ok: true, result: 'started claude' })).toStrictEqual({ answered: true });
  expect(await call(ann, 'read_host_request', { request: asked.request })).toStrictEqual({
    request: { id: asked.request, host: 'laptop', kind: 'start', state: 'done', requested_at: expect.any(String), expires_at: asked.expires_at, ok: true, result: 'started claude' },
  });

  // An agent's session: every verb refused.
  const agentRefused = /AccessError: ann-claude is an agent: hosts are a person's own machines/;
  expect(await rejection(call(agent, 'serve_host', { name: 'laptop', instance: I1, public_key: KEY }))).toMatch(agentRefused);
  expect(await rejection(call(agent, 'ask_host', { host: 'laptop', kind: 'start', body: 'b' }))).toMatch(agentRefused);
  expect(await rejection(call(agent, 'answer_host', { request: asked.request, ok: true, result: 'r' }))).toMatch(agentRefused);
  expect(await rejection(call(agent, 'read_host_request', { request: asked.request }))).toMatch(agentRefused);
  expect(await rejection(call(agent, 'list_hosts', {}))).toMatch(agentRefused);
  expect(await rejection(call(agent, 'end_host', { name: 'laptop' }))).toMatch(agentRefused);

  // Another person: Ann's host and request are as unknown to Bo as ones that never were.
  expect(await call(bo, 'list_hosts', {})).toStrictEqual({ hosts: [] });
  expect(await rejection(call(bo, 'ask_host', { host: 'laptop', kind: 'start', body: 'b' }))).toMatch(/TenancyError: you have no host named laptop in kolab hub/);
  expect(await rejection(call(bo, 'read_host_request', { request: asked.request }))).toMatch(/TenancyError: there is no request of yours by that id in kolab hub/);
  expect(await call(bo, 'end_host', { name: 'laptop' })).toStrictEqual({ ended: false });

  // Bad arguments: refused by the schema, or by Kolab, never quoting a body.
  expect(await rejection(call(ann, 'ask_host', { host: 'laptop', kind: 'restart', body: 'b' }))).toMatch(/kind/);
  expect(await call(ann, 'ask_host', { host: 'laptop', kind: 'hello', body: 'b' })).toStrictEqual({ request: expect.stringMatching(/^[a-f0-9]{32}$/), expires_at: expect.any(String) });
  expect(await rejection(call(ann, 'serve_host', { name: 'laptop', instance: I1, public_key: KEY, owner: 'bo' }))).toMatch(/unknown argument owner/);
  expect(await rejection(call(ann, 'list_hosts', { owner: 'bo' }))).toMatch(/unknown argument owner/);
  const big = await rejection(call(ann, 'ask_host', { host: 'laptop', kind: 'start', body: 'SECRET'.repeat(20000) }));
  expect(big).toMatch(/LimitError: the request's body is 120,000 characters; the limit is 98,304/);
  expect(big).not.toContain('SECRET');

  expect(await call(ann, 'end_host', { name: 'laptop', instance: 'f'.repeat(32) })).toStrictEqual({ ended: false });
  expect(await call(ann, 'end_host', { name: 'laptop', instance: I1 })).toStrictEqual({ ended: true });
  expect(await call(ann, 'list_hosts', {})).toStrictEqual({ hosts: [] });
});
