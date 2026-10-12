import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GateError, RoleError } from '../src/kolab.js';
import { setup, els } from './helpers.js';

test('an engineer session cannot create or write the functional layer', async () => {
  const { kolab, product, engineer } = await setup();
  await assert.rejects(kolab.createNode(engineer, 'functional_spec', 'Checkout'), RoleError);
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  await assert.rejects(kolab.draft(engineer, spec, { elements: els({ R1: 'x' }) }), RoleError);
  await kolab.close();
});

test('dynamic separation of duty: one active role per actor at a time', async () => {
  const { kolab } = await setup();
  const asProduct = await kolab.openSession('carol', 'product');
  await assert.rejects(kolab.openSession('carol', 'engineer'), RoleError);
  await kolab.endSession(asProduct);
  const asEngineer = await kolab.openSession('carol', 'engineer');
  assert.ok(asEngineer);
  await kolab.close();
});

test('row-level security backstops Kolab: a direct write in the wrong layer is refused', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  const attempt = (session: string) => kolab.db.transaction(async (tx) => {
    await tx.exec('set local role kj_agent');
    await tx.query(`select set_config('kj.session', $1, true)`, [session]);
    await tx.query(
      `insert into version(id, node_id, seq, layer, state, actor_id, active_role)
       values ($1, $2, 1, 'functional', 'drafted', 'x', 'x')`, [`v-${session}`, spec]);
  });
  await assert.rejects(attempt(engineer), /row-level security/);
  await assert.doesNotReject(attempt(product));
  await kolab.close();
});

test('review gate: nothing may derive from an uncommitted version', async () => {
  const { kolab, product, engineer } = await setup();
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  const drafted = await kolab.draft(product, spec, { elements: els({ R1: 'Checkout completes in 30 seconds.' }) });
  const binding = await kolab.createNode(engineer, 'technical_binding', 'Checkout on Postgres');
  const b1 = await kolab.commit(engineer, binding, { elements: els({ b1: 'A queue worker finalizes orders.' }) });
  await assert.rejects(
    kolab.link(engineer, { kind: 'dependency', source: b1, sourceElement: 'b1', target: drafted, targetElement: 'R1' }),
    GateError);
  await kolab.close();
});

test('review gate: a rejected draft is not committed', async () => {
  const { kolab, product } = await setup(({ elements }) =>
    elements.some((e) => /TBD/.test(e.text)) ? { ok: false, note: 'contains TBD' } : { ok: true });
  const spec = await kolab.createNode(product, 'functional_spec', 'Checkout');
  await assert.rejects(kolab.commit(product, spec, { elements: els({ R1: 'Timeout is TBD.' }) }), GateError);
  assert.equal(await kolab.latestCommitted(spec), undefined);
  await kolab.close();
});
