// Asynchronous rebasing over MCP (P6, D43): what an agent sees of a variant's queued rebase.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

test('over MCP: a parent\'s commit says how many rebases it queued, and read_node and list_nodes show a variant\'s until it runs', async () => {
  // No worker runs in this server: the test runs the queue itself, once it has looked.
  const kolab = await openKolab({ queued: true });
  const server = await startServer({ adminToken: ADMIN, kolab });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  await call(admin, 'admin_add_actor', { id: 'pm-agent' });
  await call(admin, 'admin_add_organization', { id: 'test-org' });
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' });
  await call(admin, 'admin_grant', { kolab: 'test', to: 'pm-agent', level: 'write', layers: ['functional'] });
  const { token } = (await call(admin, 'admin_open_session', { actor: 'pm-agent', role: 'product' })) as { token: string };
  const pm = await connect(server.url, token);
  closeAtEnd(pm);

  await call(pm, 'create_node', { kind: 'functional_spec', title: 'Storefront', id: 'P' });
  await call(pm, 'draft', { node: 'P', elements: [{ id: 'E1', text: 'Background is white.' }, { id: 'E2', text: 'Logo sits top-left.' }] });
  expect(await call(pm, 'submit_for_review', { node: 'P', version: 1 })).not.toHaveProperty('rebases_queued');
  await call(pm, 'create_node', { kind: 'prototype', title: 'Storefront for Acme', id: 'V' });
  await call(pm, 'draft', { node: 'V', parent: 'kj:P@1', deltas: [{ kind: 'override', element: 'E1', text: 'Background is navy.' }] });
  await call(pm, 'submit_for_review', { node: 'V', version: 1 });
  expect(await call(pm, 'read_node', { node: 'V' })).not.toHaveProperty('rebase');

  await call(pm, 'draft', { node: 'P', elements: [{ id: 'E1', text: 'Background is white.' }, { id: 'E2', text: 'Logo sits top-center.' }] });
  const r = await call(pm, 'submit_for_review', { node: 'P', version: 2 }) as { ok: boolean; rebases_queued?: number; next: string };
  expect([r.ok, r.rebases_queued]).toStrictEqual([true, 1]);
  expect(r.next).toMatch(/One variant's rebase is queued/);
  expect(await call(pm, 'read_node', { node: 'V' })).toMatchObject({ version: 1, rebase: { state: 'pending', attempts: 0, after: 'kj:P@2' } });
  const { nodes } = await call(pm, 'list_nodes', {}) as { nodes: { id: string; rebase_pending?: boolean }[] };
  expect(nodes.find((n) => n.id === 'V')).toMatchObject({ rebase_pending: true });
  expect(nodes.find((n) => n.id === 'P')).not.toHaveProperty('rebase_pending');

  expect(await kolab.drainOutbox()).toBe(1);
  const v = await call(pm, 'read_node', { node: 'V' }) as { version: number; elements: { id: string; text: string }[] };
  expect(v).not.toHaveProperty('rebase');
  expect([v.version, v.elements.map((e) => e.text)]).toStrictEqual([2, ['Background is navy.', 'Logo sits top-center.']]);
  expect((await call(pm, 'list_nodes', {}) as { nodes: { id: string }[] }).nodes.find((n) => n.id === 'V')).not.toHaveProperty('rebase_pending');
});
