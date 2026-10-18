// A person makes a kolab of their own (D54), within limits, and moves a session between kolabs
// and roles in one transaction (the web interface's kolab picker and role switch).
import { expect, test } from '@jest/globals';
import type { KolabEvent } from '@konjir/types';
import { people, rejection, setup } from '../src/testing.js';

test('a person who writes makes a private kolab of their own, within the cap, the rate, the grammar and the reserved names', async () => {
  const { kolab, product } = await setup();
  kolab.ownKolabs.max = 4;
  kolab.ownKolabs.burst = 3;
  await kolab.createOwnKolab(product, 'alices', { title: 'Alice\'s' });
  expect((await kolab.listKolabs()).find((k) => k.id === 'alices')).toMatchObject({ owner: 'alice', title: 'Alice\'s', visibility: 'private' });

  for (const name of ['kolab', 'konjir', 'konjir-site', 'konjir-brand', 'konjirx']) {
    expect(await rejection(kolab.createOwnKolab(product, name, { title: 'Mine' }))).toMatch(/TenancyError: the kolab name .* is reserved/);
  }
  expect(await rejection(kolab.createOwnKolab(product, 'Bad_Name', { title: 'x' }))).toMatch(/isn't a valid kolab name/);
  expect(await rejection(kolab.createOwnKolab(product, 'a'.repeat(41), { title: 'x' }))).toMatch(/isn't a valid kolab name/);
  expect(await rejection(kolab.createOwnKolab(product, 'long-title', { title: 'x'.repeat(101) }))).toMatch(/title is 1 to 100 characters/);
  expect(await rejection(kolab.createOwnKolab(product, 'test', { title: 'Taken' }))).toMatch(/the kolab name test is taken/);

  // The rate: three in the window, then wait.
  await kolab.createOwnKolab(product, 'alices-2', { title: 'Two' });
  await kolab.createOwnKolab(product, 'alices-3', { title: 'Three' });
  expect(await rejection(kolab.createOwnKolab(product, 'alices-4', { title: 'Four' }))).toMatch(/wait a while/);
  // The cap: a person owns at most ownKolabs.max.
  kolab.ownKolabs.burst = 100;
  await kolab.createOwnKolab(product, 'alices-4', { title: 'Four' });
  expect(await rejection(kolab.createOwnKolab(product, 'alices-5', { title: 'Five' }))).toMatch(/you own 4 kolabs, the most a person may own here \(4\)/);
});

test('a reader, an agent and the admin\'s kolabs: only a person with Write makes one', async () => {
  const { kolab } = await setup();
  const reader = await kolab.openSession('carol', 'product');
  expect(await rejection(kolab.createOwnKolab(reader, 'carols', { title: 'C' }))).toMatch(/AccessError: making a kolab needs Write/);
  await people(kolab, 'alice-pm', { owner: 'alice', layers: ['functional'] });
  const agent = await kolab.openSession('alice-pm', 'product');
  expect(await rejection(kolab.createOwnKolab(agent, 'agents', { title: 'A' }))).toMatch(/AccessError: alice-pm is an agent/);
  // The admin's createKolab keeps no such limits: it may make a reserved name.
  await kolab.createKolab('konjir-site', { owner: 'test-org' });
});

test('a switch ends the session and opens another in one transaction; a refused one leaves it open', async () => {
  const { kolab, product } = await setup();
  await kolab.createKolab('second', { owner: 'test-org' });
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));
  expect(await rejection(kolab.switchSession(product, { kolab: 'second', role: 'engineer' }))).toMatch(/no kolab second you can reach/);
  expect([await kolab.sessionOpen(product), events]).toStrictEqual([true, []]);   // intact, and nothing signalled

  await kolab.grant('second', 'alice', 'read');
  const next = await kolab.switchSession(product, { kolab: 'second', role: 'engineer' });
  expect([await kolab.sessionOpen(product), await kolab.sessionOpen(next)]).toStrictEqual([false, true]);
  expect(await kolab.sessionInfo(next)).toMatchObject({ actor: 'alice', role: 'engineer', kolab: 'second' });
  expect(events.filter((e) => 'session' in e)).toHaveLength(1);
  expect(await rejection(kolab.switchSession(product, { kolab: 'test', role: 'product' }))).toMatch(/this session has ended/);
});
