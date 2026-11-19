// A kolab's owner archives it, or erases one that holds no documents (migration 0056; konnect's
// `team archive` and `team delete`). Archiving keeps everything, as an admin's does (D52). Erasing
// removes the kolab and everything in it, frees its name, and leaves only the audit log's rows.
// Only the owner, from a person's own session, naming the kolab; a kolab with documents is refused.
import { expect, test } from '@jest/globals';
import { openKolab, rejection, TestKolab } from '@konjir/engine/testing';

/** Ann owns `hub`; Bo writes there; each has an agent there. They have talked, in direct messages and a channel, and hold a lease and a host. */
async function hub(kolab?: TestKolab) {
  const k = kolab ?? await openKolab();
  for (const id of ['ann', 'bo']) await k.addActor(id);
  await k.addActor('ann-claude', { owner: 'ann' });
  await k.addActor('bo-claude', { owner: 'bo' });
  await k.createKolab('hub', { owner: 'ann' });
  await k.grant('hub', 'bo', 'write');
  await k.grant('hub', 'ann-claude', 'write');
  await k.grant('hub', 'bo-claude', 'write');
  const ann = await k.openSession('ann', 'product', { kolab: 'hub' });
  const bo = await k.openSession('bo', 'engineer', { kolab: 'hub' });
  const annAgent = await k.openSession('ann-claude', 'product', { kolab: 'hub' });
  const boAgent = await k.openSession('bo-claude', 'engineer', { kolab: 'hub' });
  const sent = await k.sendMessage(annAgent, 'bo-claude', 'Are you taking the importer?');
  await k.sendMessage(boAgent, 'ann-claude', 'Yes.', { replyTo: sent.id });
  await k.readMessages(boAgent);
  await k.makeChannel(ann, 'deploys');
  await k.followChannel(bo, 'deploys', true);
  const said = await k.sendChannelMessage(ann, 'deploys', 'Deploy is green.', { mentions: ['bo'] });
  await k.sendChannelMessage(bo, 'deploys', 'Thanks.', { replyTo: said.id });
  await k.readChannel(bo, 'deploys');
  await k.claimLease(annAgent, 'importer');
  await k.serveHost(ann, { name: 'desk', instance: 'a'.repeat(32), public_key: 'k'.repeat(43), folder: '/w', agents: ['claude'], running: [] });
  await k.askHost(ann, 'desk', 'hello', 'sealed');
  return { kolab: k, ann, bo, annAgent, boAgent };
}

/** Every table with a kolab_id, and how many of its rows are the kolab's. */
async function rowsOf(kolab: TestKolab, k: string) {
  const tables = (await kolab.db.query<{ t: string }>(
    `select table_name as t from information_schema.columns where column_name = 'kolab_id' and table_schema = 'public' order by 1`)).rows.map((r) => r.t);
  const out: Record<string, number> = {};
  for (const t of tables) {
    const n = Number((await kolab.db.query<{ n: string }>(`select count(*) as n from "${t}" where kolab_id = $1`, [k])).rows[0].n);
    if (n) out[t] = n;
  }
  return out;
}

test('its owner erases a kolab of messages: everything in it goes, its sessions end, and its name is free again; the audit log keeps the record', async () => {
  const { kolab, ann, bo, boAgent } = await hub();
  const before = await rowsOf(kolab, 'hub');
  for (const t of ['message', 'message_receipt', 'channel', 'channel_message', 'channel_mention', 'channel_follow', 'channel_read', 'kolab_lease', 'kolab_host', 'kolab_host_request', 'kolab_grant', 'session']) {
    expect([t, (before[t] ?? 0) > 0]).toStrictEqual([t, true]);
  }

  expect(await kolab.eraseOwnKolab(ann, 'hub')).toStrictEqual({ erased: 'hub', ended: 4, revoked: 0, messages: 4 });
  // Nothing of it is left but the audit log's rows, which name it.
  expect(Object.keys(await rowsOf(kolab, 'hub'))).toStrictEqual(['audit_event']);
  expect((await kolab.db.query(`select 1 from kolab where id = 'hub'`)).rows).toStrictEqual([]);
  const audited = (await kolab.db.query<{ action: string; subject: string; done_by: string }>(
    `select action, subject, done_by from audit_event where kolab_id = 'hub' and done_by = 'ann' order by id`)).rows;
  expect(audited.map((a) => `${a.action} ${a.subject}`).sort()).toStrictEqual(
    ['grant.removed ann-claude', 'grant.removed bo', 'grant.removed bo-claude', 'kolab.erased hub'].sort());
  // Every session there ended: none answers now.
  expect(await rejection(kolab.readMessages(boAgent))).toMatch(/session/);
  expect(await rejection(kolab.unreadChannels(bo))).toMatch(/session/);

  // The name is free: a new kolab of that name starts empty.
  await kolab.createKolab('hub', { owner: 'bo' });
  const again = await kolab.openSession('bo', 'product', { kolab: 'hub' });
  expect((await kolab.readMessages(again)).messages).toStrictEqual([]);
  expect(await kolab.unreadChannels(again)).toStrictEqual([]);
});

test('only the owner erases or archives, from a person\'s session, naming the kolab; one with documents is refused, and nothing changes', async () => {
  const { kolab, ann, bo, annAgent } = await hub();
  const before = await rowsOf(kolab, 'hub');
  expect(await rejection(kolab.eraseOwnKolab(annAgent, 'hub'))).toMatch(/ann-claude is an agent: only a kolab's owner can erase it/);
  expect(await rejection(kolab.eraseOwnKolab(bo, 'hub'))).toMatch(/AccessError: only the owner of kolab hub can erase it/);
  expect(await rejection(kolab.archiveOwnKolab(bo, 'hub'))).toMatch(/AccessError: only the owner of kolab hub can archive it/);
  expect(await rejection(kolab.eraseOwnKolab(ann, 'other'))).toMatch(/name the kolab to erase: this session is in kolab hub/);
  expect(await rejection(kolab.eraseOwnKolab(ann, undefined as unknown as string))).toMatch(/name the kolab to erase/);

  await kolab.createNode(ann, 'spec', 'Orders', 'orders');
  expect(await rejection(kolab.eraseOwnKolab(ann, 'hub'))).toMatch(/TenancyError: kolab hub holds documents, so it can't be erased: archive it instead/);
  const after = await rowsOf(kolab, 'hub');
  for (const t of Object.keys(before)) expect([t, after[t]]).toStrictEqual([t, before[t]]);
  expect((await kolab.readMessages(annAgent)).messages.length).toBeGreaterThan(0);
});

test('its owner archives a kolab: its sessions end and everything is kept, until an admin unarchives it', async () => {
  const { kolab, ann, bo } = await hub();
  const before = await rowsOf(kolab, 'hub');
  expect(await kolab.archiveOwnKolab(ann, 'hub')).toStrictEqual({ archived: 'hub', ended: 4 });
  expect(await rejection(kolab.unreadChannels(bo))).toMatch(/session|archived/);
  expect(await rejection(kolab.openSession('bo', 'engineer', { kolab: 'hub' }))).toMatch(/archived/);
  expect(await rowsOf(kolab, 'hub')).toMatchObject(Object.fromEntries(Object.entries(before).filter(([t]) => t !== 'audit_event')));
  expect((await kolab.db.query<{ done_by: string }>(`select done_by from archive_event where target_id = 'hub'`)).rows).toStrictEqual([{ done_by: 'ann' }]);
  await kolab.unarchive({ kolab: 'hub' }, { by: 'admin' });
  const back = await kolab.openSession('bo', 'engineer', { kolab: 'hub' });
  expect((await kolab.channelMessagesPage(back, 'deploys')).items.map((m) => m.message).sort()).toStrictEqual(['Deploy is green.', 'Thanks.'].sort());
});

test('messages stay unremovable outside an erase, and an erase of one kolab removes nothing of another', async () => {
  const { kolab, ann } = await hub();
  await expect(kolab.db.query(`delete from message where kolab_id = 'hub'`)).rejects.toThrow(/never edited or removed/);
  await expect(kolab.db.query(`delete from channel_message where kolab_id = 'hub'`)).rejects.toThrow(/never edited or removed/);
  // Set for another kolab, it exempts nothing here; and never under a session's role.
  await expect(kolab.db.transaction(async (tx) => {
    await tx.query(`select set_config('kj.erasing', 'elsewhere', true)`);
    await tx.query(`delete from message where kolab_id = 'hub'`);
  })).rejects.toThrow(/never edited or removed/);
  await expect(kolab.db.transaction(async (tx) => {
    await tx.query(`select set_config('kj.erasing', 'hub', true)`);
    await tx.exec('set local role kj_system');
    await tx.query(`delete from message where kolab_id = 'hub'`);
  })).rejects.toThrow(/never edited or removed|permission denied/);

  // Two kolabs: erasing one leaves the other whole.
  await kolab.addActor('cy');
  await kolab.createKolab('side', { owner: 'cy' });
  const cy = await kolab.openSession('cy', 'product', { kolab: 'side' });
  await kolab.makeChannel(cy, 'notes');
  await kolab.sendChannelMessage(cy, 'notes', 'kept');
  const side = await rowsOf(kolab, 'side');
  await kolab.eraseOwnKolab(ann, 'hub');
  expect(await rowsOf(kolab, 'side')).toStrictEqual(side);
});
