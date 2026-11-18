// Leases over MCP, as konnect calls them (migration 0054): konjir_claim_lease, konjir_release_lease,
// konjir_break_lease and konjir_list_leases, with their arguments and results as the contract fixes them.
import { expect, test } from '@jest/globals';
import { startServer } from '@konjir/server';
import { connect, call } from '../src/cli.js';
import { closeAtEnd, rejection, testStore } from '@konjir/engine/testing';

const ADMIN = 'test-admin-token';

test('a person and an agent claim, contend for, renew, list, release and break leases over MCP; an outsider and a bad argument are refused', async () => {
  const server = await startServer({ adminToken: ADMIN, ...(await testStore()) });
  const admin = await connect(server.url, ADMIN);
  closeAtEnd(server, admin);
  for (const id of ['ann', 'sam']) await call(admin, 'admin_add_actor', { id });
  await call(admin, 'admin_add_actor', { id: 'ann-claude', owner: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'hub', owner: 'ann' });
  await call(admin, 'admin_add_kolab', { name: 'away', owner: 'sam' });
  await call(admin, 'admin_grant', { kolab: 'hub', to: 'ann-claude', level: 'write' });
  const session = async (actor: string, kolab?: string) => {
    const { token } = await call(admin, 'admin_open_session', { actor, role: 'engineer', ...(kolab ? { kolab } : {}) }) as { token: string };
    const client = await connect(server.url, token);
    closeAtEnd(client);
    return client;
  };
  const ann = await session('ann', 'hub');
  const agent = await session('ann-claude', 'hub');
  const sam = await session('sam', 'away');

  const lease = { name: 'testdb', holder: 'ann-claude', claimed_at: expect.any(String), expires_at: expect.any(String), note: 'e2e suite' };
  const claimed = await call(agent, 'claim_lease', { name: 'testdb', seconds: 600, note: 'e2e suite' }) as { lease: { claimed_at: string; expires_at: string } };
  expect(claimed).toStrictEqual({ claimed: true, renewed: false, lease });
  expect((Date.parse(claimed.lease.expires_at) - Date.parse(claimed.lease.claimed_at)) / 1000).toBe(600);
  expect(await call(agent, 'claim_lease', { name: 'testdb' })).toStrictEqual({ claimed: true, renewed: true, lease });
  const held = await call(ann, 'claim_lease', { name: 'testdb' }) as { claimed: boolean; lease: unknown };
  expect(held).toStrictEqual({ claimed: false, lease });
  expect(await call(ann, 'claim_lease', { name: 'port-3000' })).toMatchObject({ claimed: true, renewed: false, lease: { name: 'port-3000', holder: 'ann', note: null } });
  expect(await call(agent, 'list_leases', {})).toStrictEqual({ leases: [
    { name: 'testdb', holder: 'ann-claude', claimed_at: expect.any(String), expires_at: expect.any(String), note: 'e2e suite' },
    { name: 'port-3000', holder: 'ann', claimed_at: expect.any(String), expires_at: expect.any(String), note: null },
  ] });

  expect(await rejection(call(ann, 'release_lease', { name: 'testdb' }))).toMatch(/AccessError: lease testdb in kolab hub is held by ann-claude until/);
  expect(await call(agent, 'release_lease', { name: 'testdb' })).toStrictEqual({ released: true, name: 'testdb' });
  expect(await call(agent, 'release_lease', { name: 'testdb' })).toStrictEqual({ released: false, name: 'testdb' });

  expect(await rejection(call(agent, 'break_lease', { name: 'port-3000' }))).toMatch(/AccessError: ann-claude is an agent: only a person breaks a lease/);
  expect(await call(agent, 'claim_lease', { name: 'apps/server/src/x.ts' })).toMatchObject({ claimed: true });
  expect(await call(ann, 'break_lease', { name: 'apps/server/src/x.ts' })).toStrictEqual({
    broken: true, lease: { name: 'apps/server/src/x.ts', holder: 'ann-claude', claimed_at: expect.any(String), expires_at: expect.any(String), note: null },
  });
  expect(await call(ann, 'break_lease', { name: 'apps/server/src/x.ts' })).toStrictEqual({ broken: false, name: 'apps/server/src/x.ts' });

  // Per kolab: sam's kolab has none of hub's, and sam is no member of hub.
  expect(await call(sam, 'list_leases', {})).toStrictEqual({ leases: [] });
  expect(await call(sam, 'claim_lease', { name: 'port-3000' })).toMatchObject({ claimed: true, lease: { holder: 'sam' } });

  expect(await rejection(call(agent, 'claim_lease', { name: 'a b' }))).toMatch(/LimitError: "a b" is no lease name/);
  expect(await rejection(call(agent, 'claim_lease', { name: 'x', seconds: 30 }))).toMatch(/seconds is how long the lease is held: a whole number from 60 to 14400/);
  expect(await rejection(call(agent, 'claim_lease', { name: 'x', until: 5 }))).toMatch(/until/);
});
