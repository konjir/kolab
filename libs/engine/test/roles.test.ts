import { expect, test } from '@jest/globals';
import { ActorError, GateError, RoleError } from '@konjir/engine';
import { setup, els, rejection } from '@konjir/engine/testing';

test('an engineer session cannot create or write the functional layer', async () => {
  const { kolab, product, engineer } = await setup();
  await expect(kolab.createNode(engineer, 'functional_spec', 'Checkout')).rejects.toBeInstanceOf(RoleError);
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  await expect(kolab.draft(engineer, spec, { elements: els({ R1: 'x' }) })).rejects.toBeInstanceOf(RoleError);
  await kolab.close();
});

test('dynamic separation of duty: one active role per actor at a time', async () => {
  const { kolab } = await setup();
  const asProduct = await kolab.openSession('carol', 'product');
  await expect(kolab.openSession('carol', 'engineer')).rejects.toBeInstanceOf(ActorError);
  await kolab.endSession(asProduct);
  const asEngineer = await kolab.openSession('carol', 'engineer');
  expect(asEngineer).toBeTruthy();
  await kolab.close();
});

test('row-level security backstops Kolab: a direct write in the wrong layer is refused', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  // Each writes as its own actor and role, which row-level security also checks (0002).
  const attempt = async (session: string) => {
    const me = await kolab.sessionInfo(session);
    return kolab.db.transaction(async (tx) => {
      await tx.exec('set local role kj_agent');
      await tx.query(`select set_config('kj.session', $1, true)`, [session]);
      await tx.query(
        `insert into version(id, node_id, seq, layer, state, actor_id, active_role)
         values ($1, $2, 1, 'functional', 'drafted', $3, $4)`, [`v-${session}`, spec, me.actor, me.role]);
    });
  };
  expect(await rejection(attempt(engineer))).toMatch(/row-level security/);
  await attempt(product);
  await kolab.close();
});

test('review gate: nothing may derive from an uncommitted version', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  const drafted = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  const binding = await kolab.createNode(engineer, 'technical_binding', 'Checkout on Postgres');
  const b1 = await kolab.commit(engineer, binding, { elements: els({ b1: 'A queue worker finalizes orders.' }) });
  await expect(kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: drafted, targetElement: 'R1' })).rejects.toBeInstanceOf(GateError);
  await kolab.close();
});

test('review gate: a rejected draft is not committed', async () => {
  const { kolab, product } = await setup(({ elements }) =>
    elements.some((e) => /TBD/.test(e.text)) ? { ok: false, note: 'contains TBD' } : { ok: true });
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  await expect(kolab.commit(product, spec, { elements: els({ R1: 'Timeout is TBD.' }) })).rejects.toBeInstanceOf(GateError);
  expect(await kolab.latestCommitted(spec)).toBe(undefined);
  await kolab.close();
});
