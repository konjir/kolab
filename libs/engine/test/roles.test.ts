import { expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import { ActorError, GateError, RoleError, sessionKey } from '@konjir/engine';
import { setup, els, rejection } from '@konjir/engine/testing';
import { isInboxEvent, isSessionEnded, type KolabEvent } from '@konjir/types';

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

test('ending a session revokes it and tells listeners, by the session\'s key, so its streams close', async () => {
  const { kolab, product, engineer } = await setup();
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));
  expect(await kolab.sessionOpen(product)).toBe(true);
  await kolab.endSession(product);
  expect(await kolab.sessionOpen(product)).toBe(false);
  expect(await kolab.sessionOpen(engineer)).toBe(true);
  // Named by its key, the sha256 of the id, never by the id, which is the bearer token.
  const key = createHash('sha256').update(product).digest('base64url');
  expect(sessionKey(product)).toBe(key);
  expect(events).toStrictEqual([{ session: 'ended', id: key }]);
  expect(JSON.stringify(events)).not.toContain(product);
  expect(JSON.parse(JSON.stringify(events[0]))).toStrictEqual(events[0]); // plain JSON, to carry between processes
  expect(events.filter(isSessionEnded).map((e) => e.id)).toStrictEqual([key]);
  expect(await kolab.openSessions([product, engineer, 'kjs_no-such-session'])).toStrictEqual(new Set([engineer]));
  expect(events.filter(isInboxEvent)).toStrictEqual([]);
  // No such session: nothing to tell.
  await kolab.endSession('kjs_no-such-session');
  expect(events.length).toBe(1);
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
