// A server that boots runs the outbox's jobs a stopped process left behind (REV3, W1.8).
import { expect, test } from '@jest/globals';
import { structuralChecks, type Kolab } from '@konjir/engine';
import { closeAtEnd, els, openKolab, people, persistentStore, textOf } from '@konjir/engine/testing';
import type { Checks } from '@konjir/types';
import { startServer } from '../src/server.js';

test('a server that boots finishes the cascade a stopped process owed, without being asked', async () => {
  const store = await persistentStore();
  // The first process stops in P@2's cascade, as Kolab's rebase of the variant V reaches its checks.
  let reached!: () => void;
  const stopped = new Promise<void>((r) => { reached = r; });
  const checks: Checks = async (ctx) => {
    if (ctx.version.node_id !== 'V' || ctx.version.active_role !== 'system') return structuralChecks(ctx);
    reached();
    return new Promise(() => undefined);
  };
  const a = await openKolab({ ...store, checks, outboxLeaseMs: 300, closeWaitMs: 0 });
  await people(a, 'alice', { layers: ['functional'] });
  const alice = await a.openSession('alice', 'product');
  await a.createNode(alice, 'functional_spec', 'P', 'P');
  const p1 = await a.commit(alice, 'P', { elements: els({ E1: 'Parent one.' }) });
  await a.createNode(alice, 'functional_spec', 'V', 'V');
  await a.commit(alice, 'V', { parent: p1, deltas: [{ kind: 'add', element: 'A', text: 'V adds A.' }] });
  void a.commit(alice, 'P', { elements: els({ E1: 'Parent one, revised.' }) }).catch(() => undefined);
  await stopped;
  await a.db.close();   // as a process that dies: nothing it was doing finishes or cleans up

  const server = await startServer({ adminToken: 'admin', ...store });
  closeAtEnd(server);
  const owed = async (k: Kolab) => (await k.db.query(`select 1 from outbox`)).rows.length;
  for (let i = 0; i < 200 && await owed(server.kolab); i++) await new Promise((r) => setTimeout(r, 50));
  expect(await owed(server.kolab)).toBe(0);
  expect(await textOf(server.kolab, 'V')).toStrictEqual({ E1: 'Parent one, revised.', A: 'V adds A.' });
});
