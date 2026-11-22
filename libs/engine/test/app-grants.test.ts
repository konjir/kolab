// konnect's app's sign-in (one grant for every team the person is in, switchTeam): when the person can
// no longer work in its team (removed, left, their access gone, the team erased or archived), the
// sign-in moves to another of their teams, the one they used last or else the first by name, and is
// revoked only when none is left; every other client's grant is left as it was. A sign-out, a switch
// and a refresh take the access lock first, so on Postgres they never deadlock on the grant's and
// its session's rows.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@jest/globals';
import { sessionKey } from '@konjir/engine';
import { appSignIn, openKolab, rejection, type TestKolab } from '@konjir/engine/testing';

/** Ann owns `anns`, where Bob and Dee hold Read; Bob owns `bobs` too. Each signs in through the app, in anns. */
async function world() {
  const k = await openKolab();
  for (const id of ['ann', 'bob', 'dee']) await k.addActor(id);
  await k.createKolab('anns', { owner: 'ann' });
  await k.createKolab('bobs', { owner: 'bob' });
  for (const id of ['bob', 'dee']) await k.grant('anns', id, 'read');
  const ann = await k.openSession('ann', 'product', { kolab: 'anns' });
  const ended: string[] = [];
  k.onEvent((e) => { if ('session' in e && e.session === 'ended') ended.push(e.id); });
  return { k, ann, ended };
}

/** The grant a refresh token belongs to: its scope, whether it is revoked, and the kolabs of its open sessions. */
async function grantOf(k: TestKolab, refresh: string) {
  return (await k.db.query<{ scope: string; revoked: boolean; open: string[] }>(
    `select g.scope, g.revoked_at is not null as revoked,
            coalesce((select array_agg(s.kolab_id) from session s where s.grant_id = g.id and s.ended_at is null), '{}') as open
       from oauth_grant g join oauth_refresh_token t on t.grant_id = g.id where t.key = $1`, [sessionKey(refresh)])).rows[0];
}

test('removed from its team, the app\'s sign-in moves to another of the person\'s teams, its old session ended and told, and the next refresh lands there', async () => {
  const { k, ann, ended } = await world();
  const bob = await appSignIn(k, 'bob', 'anns');
  await k.removeKolabMember(ann, 'bob');
  expect(ended).toContain(bob.session);
  expect(await k.sessionOpen(bob.access)).toBe(false);
  expect(await grantOf(k, bob.refresh)).toStrictEqual({ scope: 'konjir kolab:bobs role:product', revoked: false, open: ['bobs'] });
  const t = await k.refreshGrant({ refreshToken: bob.refresh, clientId: bob.client });
  expect([t.scope, (await k.sessionInfo(t.accessToken)).kolab]).toStrictEqual(['konjir kolab:bobs role:product', 'bobs']);
  // With no team left, it is revoked, as signing out revokes it.
  const dee = await appSignIn(k, 'dee', 'anns');
  await k.removeKolabMember(ann, 'dee');
  expect(await grantOf(k, dee.refresh)).toStrictEqual({ scope: 'konjir kolab:anns role:product', revoked: true, open: [] });
  expect(await rejection(k.refreshGrant({ refreshToken: dee.refresh, clientId: dee.client }))).toMatch(/invalid_grant|refresh token is unknown/);
});

test('it moves to the team the person used last, or else the first by name, never back to the one it left', async () => {
  const { k, ann } = await world();
  await k.createKolab('aaa', { owner: 'ann' });
  await k.createKolab('zzz', { owner: 'ann' });
  for (const id of ['aaa', 'zzz']) await k.grant(id, 'dee', 'read');
  // Never worked in either: the first by name.
  const first = await appSignIn(k, 'dee', 'anns');
  await k.revoke('anns', 'dee');
  expect((await grantOf(k, first.refresh)).open).toStrictEqual(['aaa']);
  // Worked in zzz last: there.
  await k.grant('anns', 'dee', 'read');
  await k.endSession(await k.openSession('dee', 'product', { kolab: 'zzz' }));
  const again = await appSignIn(k, 'dee', 'anns');
  await k.removeKolabMember(ann, 'dee');
  expect((await grantOf(k, again.refresh)).open).toStrictEqual(['zzz']);
});

test('leaving, losing access by any change, access gone outside Kolab\'s verbs, erasing and archiving the team each move it the same way', async () => {
  const { k, ann } = await world();
  // Leaving, from the app itself: its own session ends, and the sign-in goes on in bobs.
  const left = await appSignIn(k, 'bob', 'anns');
  await k.leaveKolab(left.access);
  expect((await grantOf(k, left.refresh)).open).toStrictEqual(['bobs']);
  // An admin's revoke (a change of access).
  await k.grant('anns', 'bob', 'read');
  const revoked = await appSignIn(k, 'bob', 'anns');
  await k.revoke('anns', 'bob');
  expect((await grantOf(k, revoked.refresh)).open).toStrictEqual(['bobs']);
  // Access gone outside Kolab's verbs: the next refresh finds it, and lands in bobs instead of failing.
  await k.grant('anns', 'bob', 'read');
  const outside = await appSignIn(k, 'bob', 'anns');
  await k.db.transaction(async (tx) => {
    await tx.query(`delete from kolab_grant where kolab_id = 'anns' and user_id = 'bob'`);
    // The database requires a change of access to be recorded (W2.20), even one made by hand.
    await tx.query(`insert into audit_event(action, kolab_id, subject, done_by) values ('grant.removed', 'anns', 'bob', 'test')`);
  });
  const t = await k.refreshGrant({ refreshToken: outside.refresh, clientId: outside.client });
  expect(t.scope).toBe('konjir kolab:bobs role:product');
  expect((await grantOf(k, t.refreshToken)).open).toStrictEqual(['bobs']);
  // Erasing the team the app works in, from the app: on to the person's other team.
  await k.createKolab('scratch', { owner: 'bob' });
  const erasing = await appSignIn(k, 'bob', 'scratch');
  await k.eraseOwnKolab(erasing.access, 'scratch');
  expect(await grantOf(k, erasing.refresh)).toMatchObject({ scope: 'konjir kolab:bobs role:product', revoked: false, open: ['bobs'] });
  // Archiving it.
  await k.grant('anns', 'bob', 'read');
  const archived = await appSignIn(k, 'bob', 'anns');
  await k.archive({ kolab: 'anns' });
  expect((await grantOf(k, archived.refresh)).open).toStrictEqual(['bobs']);
  expect(ann).toBeTruthy();
});

test('every other client\'s grant is left as it was: its session ends, and nothing opens elsewhere', async () => {
  const { k, ann } = await world();
  const redirectUri = 'http://127.0.0.1:9/cb';
  const client = (await k.registerClient({ name: 'konnect', redirectUris: [redirectUri] })).id;
  const verifier = randomBytes(32).toString('base64url');
  const { binding, state } = await k.beginAuthorization({ provider: 'github', clientId: client, redirectUri, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'konjir choose:kolab' });
  const { csrf } = await k.identifyAuthorization(binding, state, 'bob');
  const { code } = await k.consentPerson(binding, csrf, { kolab: 'anns' });
  const cli = await k.exchangeCode({ code, clientId: client, redirectUri, codeVerifier: verifier });
  await k.removeKolabMember(ann, 'bob');
  expect(await grantOf(k, cli.refreshToken)).toStrictEqual({ scope: 'konjir kolab:anns role:product', revoked: false, open: [] });
});

test('a sign-out, a switch and a refresh of one grant at once each take the access lock first: none deadlocks or fails for the order, and the grant ends revoked with no session', async () => {
  const { k } = await world();
  for (let i = 0; i < 5; i++) {
    const bob = await appSignIn(k, 'bob', 'anns');
    const [out, sw, re] = await Promise.allSettled([
      k.revokeToken(bob.refresh),
      k.switchTeam(bob.access, 'bobs'),
      k.refreshGrant({ refreshToken: bob.refresh, clientId: bob.client }),
    ]);
    expect(out).toMatchObject({ status: 'fulfilled', value: true });
    // The switch and the refresh either went first or are refused as a revoked sign-in is: never by a deadlock.
    for (const r of [sw, re]) if (r.status === 'rejected') expect(String(r.reason)).not.toMatch(/deadlock/);
    expect(await grantOf(k, bob.refresh)).toMatchObject({ revoked: true, open: [] });
  }
});
