import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GateError, RoleError } from '../src/hub.js';
import { setup, els } from './helpers.js';

test('an engineer session cannot create or write the functional layer', async () => {
  const { hub, product, engineer } = await setup();
  await assert.rejects(hub.createNode(engineer, 'functional_spec', 'Checkout'), RoleError);
  const spec = await hub.createNode(product, 'functional_spec', 'Checkout');
  await assert.rejects(hub.draft(engineer, spec, { elements: els({ R1: 'x' }) }), RoleError);
  await hub.close();
});

test('dynamic separation of duty: one active role per actor at a time', async () => {
  const { hub } = await setup();
  const asProduct = await hub.openSession('carol', 'product');
  await assert.rejects(hub.openSession('carol', 'engineer'), RoleError);
  await hub.endSession(asProduct);
  const asEngineer = await hub.openSession('carol', 'engineer');
  assert.ok(asEngineer);
  await hub.close();
});

test('row-level security backstops the hub: a direct write in the wrong layer is refused', async () => {
  const { hub, product, engineer } = await setup();
  const spec = await hub.createNode(product, 'functional_spec', 'Checkout');
  const attempt = (session: string) => hub.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [session]);
    await tx.query(
      `insert into version(id, node_id, seq, layer, state, actor_id, active_role)
       values ($1, $2, 1, 'functional', 'drafted', 'x', 'x')`, [`v-${session}`, spec]);
  });
  await assert.rejects(attempt(engineer), /row-level security/);
  await assert.doesNotReject(attempt(product));
  await hub.close();
});

test('review gate: nothing may derive from an uncommitted version', async () => {
  const { hub, product, engineer } = await setup();
  const spec = await hub.createNode(product, 'functional_spec', 'Checkout');
  const drafted = await hub.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  const binding = await hub.createNode(engineer, 'technical_binding', 'Checkout on Postgres');
  const b1 = await hub.commit(engineer, binding, { elements: els({ b1: 'A queue worker finalizes orders.' }) });
  await assert.rejects(
    hub.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: drafted, targetElement: 'R1' }),
    GateError);
  await hub.close();
});

test('review gate: a rejected draft is not committed', async () => {
  const { hub, product } = await setup(({ elements }) =>
    elements.some((e) => /TBD/.test(e.text)) ? { ok: false, note: 'contains TBD' } : { ok: true });
  const spec = await hub.createNode(product, 'functional_spec', 'Checkout');
  await assert.rejects(hub.commit(product, spec, { elements: els({ R1: 'Timeout is TBD.' }) }), GateError);
  assert.equal(await hub.latestCommitted(spec), undefined);
  await hub.close();
});
