// Hosts in a kolab (migration 0055): a person's own machine serves `konnect host run`, and from
// another machine the same person asks it, through Kolab, to start or stop one of their agents.
// Everything is the session's own person's: an agent's session is refused every verb, a non-member
// is refused, and another person's host or request answers exactly as one that doesn't exist. A
// request is taken once, ever; answered once, which empties its body; and never read back with it.
import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import {
  HOST_CLEANUP_OTHERS, HOST_TAKEN_SECONDS, MAX_HOST_ASKS_PER_HOUR, HOST_FORGOTTEN_DAYS, HOST_FRESH_SECONDS, HOST_REQUEST_SECONDS, HOST_REQUESTS_AT_ONCE, MAX_HOST_BODY, MAX_HOST_REQUESTS_WAITING, MAX_HOST_RESULT, MAX_HOSTS_PER_PERSON,
} from '@konjir/types';
import { openKolab, rejection, TestKolab } from '@konjir/engine/testing';

/** Ann owns `hub`; Bo writes there; each has an agent there (ann-claude, bo-claude). Sam has nothing. */
async function hub(kolab?: TestKolab) {
  const k = kolab ?? await openKolab();
  for (const id of ['ann', 'bo', 'sam']) await k.addActor(id);
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
  return { kolab: k, ann, bo, annAgent, boAgent };
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const KEY = 'k'.repeat(43);
const I1 = 'a'.repeat(32);
const I2 = 'b'.repeat(32);
/** What a host's machine sends on each call. */
const serving = (name: string, instance = I1, extra: Record<string, unknown> = {}) => ({ name, instance, public_key: KEY, folder: '/home/ann/work', agents: ['claude', 'codex'], running: ['claude'], ...extra });

/** Moves a host's last call into the past, as time passing would: no sleeping. */
const quiet = (kolab: TestKolab, owner: string, name: string, seconds: number) =>
  kolab.db.query(`update kolab_host set seen_at = clock_timestamp() - make_interval(secs => $3) where owner = $1 and name = $2`, [owner, name, seconds]);
/** Moves a request's expiry into the past. */
const expire = (kolab: TestKolab, id: string) =>
  kolab.db.query(`update kolab_host_request set expires_at = clock_timestamp() - interval '1 second', created_at = clock_timestamp() - interval '2 minutes' where id = $1`, [id]);

test('a host serves, is listed, and takes what its person asks of it, once; the asker reads it through to done; the body goes once answered', async () => {
  const { kolab, ann } = await hub();
  const first = await kolab.serveHost(ann, serving('laptop'));
  expect(first).toStrictEqual({
    host: {
      name: 'laptop', folder: '/home/ann/work', serving: true, started_at: expect.any(String), seen_at: expect.any(String),
      agents: ['claude', 'codex'], running: ['claude'], public_key: KEY,
    },
    requests: [],
  });
  expect(first.host.started_at).toBe(first.host.seen_at);
  expect(await kolab.listHosts(ann)).toStrictEqual({ hosts: [first.host] });

  const asked = await kolab.askHost(ann, 'laptop', 'start', 'sealed-body-1');
  expect(asked).toStrictEqual({ request: expect.stringMatching(/^[a-f0-9]{32}$/), expires_at: expect.any(String) });
  const second = await kolab.askHost(ann, 'laptop', 'stop', 'sealed-body-2');
  expect(await kolab.readHostRequest(ann, asked.request)).toStrictEqual({
    request: { id: asked.request, host: 'laptop', kind: 'start', state: 'waiting', requested_at: expect.any(String), expires_at: asked.expires_at },
  });
  const r = await kolab.readHostRequest(ann, asked.request);
  expect(Math.round((Date.parse(r.request.expires_at) - Date.parse(r.request.requested_at)) / 1000)).toBe(HOST_REQUEST_SECONDS);

  // Served: both, oldest first, and from its person; the host's started_at kept, seen_at moved on.
  const served = await kolab.serveHost(ann, serving('laptop', I1, { running: [] }));
  expect(served.requests).toStrictEqual([
    { id: asked.request, kind: 'start', body: 'sealed-body-1', from: 'ann', requested_at: expect.any(String), expires_at: asked.expires_at },
    { id: second.request, kind: 'stop', body: 'sealed-body-2', from: 'ann', requested_at: expect.any(String), expires_at: second.expires_at },
  ]);
  expect(served.host).toMatchObject({ started_at: first.host.started_at, running: [] });
  expect(Date.parse(served.host.seen_at)).toBeGreaterThanOrEqual(Date.parse(first.host.seen_at));
  // Never again.
  expect((await kolab.serveHost(ann, serving('laptop'))).requests).toStrictEqual([]);
  expect((await kolab.readHostRequest(ann, asked.request)).request.state).toBe('taken');

  expect(await kolab.answerHost(ann, asked.request, true, 'started claude')).toStrictEqual({ answered: true });
  expect(await kolab.readHostRequest(ann, asked.request)).toStrictEqual({
    request: { id: asked.request, host: 'laptop', kind: 'start', state: 'done', requested_at: expect.any(String), expires_at: asked.expires_at, ok: true, result: 'started claude' },
  });
  expect((await kolab.db.query(`select body, answered_by from kolab_host_request where id = $1`, [asked.request])).rows).toStrictEqual([{ body: '', answered_by: 'ann' }]);
  // Answered once.
  expect(await rejection(kolab.answerHost(ann, asked.request, false, 'again'))).toMatch(/^TenancyError: that request was answered at \S+: a request is answered once/);
  expect(await kolab.answerHost(ann, second.request, false, 'no such agent')).toStrictEqual({ answered: true });
  expect((await kolab.readHostRequest(ann, second.request)).request).toMatchObject({ state: 'done', ok: false, result: 'no such agent' });
});

test('read never returns the body, in any state', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const { request } = await kolab.askHost(ann, 'laptop', 'start', 'SECRET-BODY');
  const states = [JSON.stringify(await kolab.readHostRequest(ann, request))];
  await kolab.serveHost(ann, serving('laptop'));
  states.push(JSON.stringify(await kolab.readHostRequest(ann, request)));
  await kolab.answerHost(ann, request, true, 'ok');
  states.push(JSON.stringify(await kolab.readHostRequest(ann, request)));
  for (const s of states) {
    expect(s).not.toContain('SECRET-BODY');
    expect(s).not.toContain('"body"');
  }
});

test('an agent\'s session is refused every host verb, even for its own person\'s host', async () => {
  const { kolab, ann, annAgent } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const { request } = await kolab.askHost(ann, 'laptop', 'start', 'b');
  const refusal = /^AccessError: ann-claude is an agent: hosts are a person's own machines/;
  expect(await rejection(kolab.serveHost(annAgent, serving('laptop')))).toMatch(refusal);
  expect(await rejection(kolab.serveHost(annAgent, serving('agent-host')))).toMatch(refusal);
  expect(await rejection(kolab.askHost(annAgent, 'laptop', 'start', 'b'))).toMatch(refusal);
  expect(await rejection(kolab.answerHost(annAgent, request, true, 'r'))).toMatch(refusal);
  expect(await rejection(kolab.readHostRequest(annAgent, request))).toMatch(refusal);
  expect(await rejection(kolab.listHosts(annAgent))).toMatch(refusal);
  expect(await rejection(kolab.endHost(annAgent, 'laptop'))).toMatch(refusal);
  expect((await kolab.db.query(`select name from kolab_host`)).rows).toStrictEqual([{ name: 'laptop' }]);
  expect((await kolab.readHostRequest(ann, request)).request.state).toBe('waiting');
});

test('a reader of a public kolab, no member, is refused every host verb', async () => {
  const kolab = await openKolab();
  for (const id of ['cy', 'dee']) await kolab.addActor(id);
  await kolab.createKolab('open', { owner: 'cy', visibility: 'public' });
  const dee = await kolab.openSession('dee', 'product', { kolab: 'open' });
  const refusal = /^AccessError: dee is not a member of kolab open: hosts are for those who hold access there/;
  expect(await rejection(kolab.serveHost(dee, serving('laptop')))).toMatch(refusal);
  expect(await rejection(kolab.askHost(dee, 'laptop', 'start', 'b'))).toMatch(refusal);
  expect(await rejection(kolab.answerHost(dee, 'a'.repeat(32), true, 'r'))).toMatch(refusal);
  expect(await rejection(kolab.readHostRequest(dee, 'a'.repeat(32)))).toMatch(refusal);
  expect(await rejection(kolab.listHosts(dee))).toMatch(refusal);
  expect(await rejection(kolab.endHost(dee, 'laptop'))).toMatch(refusal);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host`)).rows[0]).toStrictEqual({ n: 0 });
});

test('another person in the same kolab never reaches your hosts or requests: theirs of the same name is another host, and your ids read as unknown', async () => {
  const { kolab, ann, bo } = await hub();
  const annHost = (await kolab.serveHost(ann, serving('laptop'))).host;
  const { request } = await kolab.askHost(ann, 'laptop', 'start', 'ann-body');

  // Bo lists none of Ann's, and asks no host of Ann's, in the very words an unknown name gets.
  expect(await kolab.listHosts(bo)).toStrictEqual({ hosts: [] });
  const noLaptop = await rejection(kolab.askHost(bo, 'laptop', 'start', 'b'));
  expect(noLaptop).toBe('TenancyError: you have no host named laptop in kolab hub: konjir_list_hosts lists yours, and a host is yours once it serves (konnect host run on its machine)');
  expect(await rejection(kolab.askHost(bo, 'nothing', 'start', 'b'))).toBe(noLaptop.replace('laptop', 'nothing'));

  // Ann's request id: read, answered, by Bo, exactly as one that never was.
  const unknown = 'TenancyError: there is no request of yours by that id in kolab hub';
  expect(await rejection(kolab.readHostRequest(bo, request))).toBe(unknown);
  expect(await rejection(kolab.readHostRequest(bo, 'f'.repeat(32)))).toBe(unknown);
  expect(await rejection(kolab.readHostRequest(bo, 'not hex'))).toBe(unknown);
  expect(await rejection(kolab.answerHost(bo, request, true, 'mine now'))).toBe(unknown);
  expect(await rejection(kolab.answerHost(bo, 'f'.repeat(32), true, 'r'))).toBe(unknown);
  expect(await kolab.endHost(bo, 'laptop')).toStrictEqual({ ended: false });

  // Bo serving "laptop" is Bo's own laptop: Ann's is neither taken over nor refused, and Bo takes none of Ann's requests.
  const boHost = await kolab.serveHost(bo, serving('laptop', I2, { folder: '/home/bo' }));
  expect(boHost).toMatchObject({ host: { name: 'laptop', folder: '/home/bo' }, requests: [] });
  expect(await kolab.listHosts(bo)).toMatchObject({ hosts: [{ name: 'laptop', folder: '/home/bo' }] });
  expect(await kolab.listHosts(ann)).toStrictEqual({ hosts: [{ ...annHost, seen_at: expect.any(String) }] });
  const boReq = await kolab.askHost(bo, 'laptop', 'stop', 'bo-body');
  // Ann's serve hands Ann hers alone, and Bo's his.
  expect((await kolab.serveHost(ann, serving('laptop'))).requests.map((r) => [r.id, r.from, r.body])).toStrictEqual([[request, 'ann', 'ann-body']]);
  expect((await kolab.serveHost(bo, serving('laptop', I2))).requests.map((r) => [r.id, r.from, r.body])).toStrictEqual([[boReq.request, 'bo', 'bo-body']]);
  // Taken now, Ann's request is still not Bo's to answer.
  expect(await rejection(kolab.answerHost(bo, request, true, 'mine now'))).toBe(unknown);
  expect((await kolab.readHostRequest(ann, request)).request.state).toBe('taken');

  // Bo ending his laptop leaves Ann's.
  expect(await kolab.endHost(bo, 'laptop')).toStrictEqual({ ended: true });
  expect((await kolab.listHosts(ann)).hosts.map((h) => h.name)).toStrictEqual(['laptop']);
  expect((await kolab.db.query(`select owner, name from kolab_host`)).rows).toStrictEqual([{ owner: 'ann', name: 'laptop' }]);
});

test('a host name served by another instance is refused while it is fresh, saying when it was seen and where; once quiet it is taken over, and what waited for the old one goes', async () => {
  const { kolab, ann } = await hub();
  const first = await kolab.serveHost(ann, serving('laptop'));
  const waiting = await kolab.askHost(ann, 'laptop', 'start', 'sealed to the old key');
  expect(await rejection(kolab.serveHost(ann, serving('laptop', I2))))
    .toMatch(/^TenancyError: host laptop is being served by another machine or process: it was last seen at \S+, in \/home\/ann\/work\. Give this one another name, or stop that one/);
  // Its own instance carries on.
  expect((await kolab.serveHost(ann, serving('laptop', I1, { folder: null }))).requests.map((r) => r.id)).toStrictEqual([waiting.request]);
  const taken = await kolab.askHost(ann, 'laptop', 'stop', 'b');
  await kolab.serveHost(ann, serving('laptop'));
  const done = await kolab.askHost(ann, 'laptop', 'stop', 'b');
  await kolab.serveHost(ann, serving('laptop'));
  await kolab.answerHost(ann, done.request, true, 'stopped');
  const pending = await kolab.askHost(ann, 'laptop', 'start', 'b');

  // Just inside the window: still refused; with no folder, none is named.
  await kolab.serveHost(ann, serving('laptop', I1, { folder: null }));
  await quiet(kolab, 'ann', 'laptop', HOST_FRESH_SECONDS - 2);
  expect(await rejection(kolab.serveHost(ann, serving('laptop', I2)))).toMatch(/last seen at \S+\. Give this one another name/);
  // Quiet past it: taken over, started now, with its new key; the requests not answered go, the answered one stays readable.
  await quiet(kolab, 'ann', 'laptop', HOST_FRESH_SECONDS + 1);
  const NEW_KEY = 'n'.repeat(43);
  const over = await kolab.serveHost(ann, serving('laptop', I2, { public_key: NEW_KEY }));
  expect(over.requests).toStrictEqual([]);
  expect(over.host).toMatchObject({ public_key: NEW_KEY, serving: true });
  expect(Date.parse(over.host.started_at)).toBeGreaterThan(Date.parse(first.host.started_at));
  expect((await kolab.db.query(`select instance from kolab_host`)).rows).toStrictEqual([{ instance: I2 }]);
  for (const id of [waiting.request, taken.request, pending.request]) {
    expect(await rejection(kolab.readHostRequest(ann, id))).toMatch(/no request of yours by that id/);
  }
  expect((await kolab.readHostRequest(ann, done.request)).request).toMatchObject({ state: 'done', result: 'stopped' });
  // And now the old instance is the one refused.
  expect(await rejection(kolab.serveHost(ann, serving('laptop', I1)))).toMatch(/is being served by another machine or process/);
});

test('two serves at once hand each request out exactly once', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  for (let round = 0; round < 5; round++) {
    const asked = [];
    for (let i = 0; i < 3; i++) asked.push((await kolab.askHost(ann, 'laptop', 'start', `b${i}`)).request);
    const results = await Promise.all([0, 1, 2, 3].map(() => kolab.serveHost(ann, serving('laptop'))));
    const handed = results.flatMap((r) => r.requests.map((q) => q.id));
    expect(handed.sort()).toStrictEqual([...asked].sort());
    for (const id of asked) await kolab.answerHost(ann, id, true, 'r');
  }
});

test(`at most ${HOST_REQUESTS_AT_ONCE} requests are taken at a call, oldest first; the rest wait for the next`, async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const ids = [];
  for (let i = 0; i < HOST_REQUESTS_AT_ONCE + 2; i++) ids.push((await kolab.askHost(ann, 'laptop', 'start', `b${i}`)).request);
  expect((await kolab.serveHost(ann, serving('laptop'))).requests.map((r) => r.id)).toStrictEqual(ids.slice(0, HOST_REQUESTS_AT_ONCE));
  expect((await kolab.serveHost(ann, serving('laptop'))).requests.map((r) => r.id)).toStrictEqual(ids.slice(HOST_REQUESTS_AT_ONCE));
});

test('asking a host that is not serving is refused, saying when it was last seen; an unknown kind is refused', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  await quiet(kolab, 'ann', 'laptop', HOST_FRESH_SECONDS + 1);
  expect(await rejection(kolab.askHost(ann, 'laptop', 'start', 'b')))
    .toMatch(/^TenancyError: host laptop is not serving: it was last seen at \d{4}-\d\d-\d\dT\S+, and a host serves while it calls at least every 30 seconds/);
  expect((await kolab.listHosts(ann)).hosts).toMatchObject([{ name: 'laptop', serving: false }]);
  await kolab.serveHost(ann, serving('laptop'));
  expect((await kolab.listHosts(ann)).hosts).toMatchObject([{ name: 'laptop', serving: true }]);
  expect(await rejection(kolab.askHost(ann, 'laptop', 'restart', 'b'))).toMatch(/^LimitError: kind is what the request asks of the host: one of start, stop, end/);
  expect((await kolab.askHost(ann, 'laptop', 'end', 'b')).request).toMatch(/^[a-f0-9]{32}$/);
});

test('a request not taken in time reads as expired and is never handed out; one not taken can\'t be answered', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const late = await kolab.askHost(ann, 'laptop', 'start', 'b');
  expect(await rejection(kolab.answerHost(ann, late.request, true, 'r'))).toMatch(/^TenancyError: that request has not been taken by its host/);
  await expire(kolab, late.request);
  expect((await kolab.readHostRequest(ann, late.request)).request.state).toBe('expired');
  expect((await kolab.serveHost(ann, serving('laptop'))).requests).toStrictEqual([]);
  // Its body is emptied as the host serves, and the row stays, reading as expired, for the rest of its hour.
  const body = async (id: string) => (await kolab.db.query<{ body: string }>(`select body from kolab_host_request where id = $1`, [id])).rows[0]?.body;
  expect(await body(late.request)).toBe('');
  expect((await kolab.readHostRequest(ann, late.request)).request.state).toBe('expired');
  expect(await rejection(kolab.answerHost(ann, late.request, true, 'r'))).toMatch(/has not been taken by its host/);
  // Asking empties the asker's own expired bodies too.
  const another = await kolab.askHost(ann, 'laptop', 'start', 'sealed');
  await expire(kolab, another.request);
  expect(await body(another.request)).toBe('sealed');
  await kolab.askHost(ann, 'laptop', 'stop', 'b');
  expect(await body(another.request)).toBe('');
  expect((await kolab.readHostRequest(ann, another.request)).request.state).toBe('expired');
  // A taken request past its expiry is still the host's to answer, and keeps its body until then.
  await kolab.serveHost(ann, serving('laptop'));
  const slow = await kolab.askHost(ann, 'laptop', 'start', 'b');
  await kolab.serveHost(ann, serving('laptop'));
  await expire(kolab, slow.request);
  await kolab.serveHost(ann, serving('laptop'));
  expect(await body(slow.request)).toBe('b');
  expect((await kolab.readHostRequest(ann, slow.request)).request.state).toBe('taken');
  expect(await kolab.answerHost(ann, slow.request, true, 'started late')).toStrictEqual({ answered: true });
});

test('answering a request that went between its read and its write is refused as unknown, never reported as answered', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const { request } = await kolab.askHost(ann, 'laptop', 'start', 'b');
  await kolab.serveHost(ann, serving('laptop'));
  // Deleted right after answerHost reads it, as another member's cleanup could.
  const proto = Object.getPrototypeOf(kolab.db);
  const query = proto.query;
  let fired = false;
  proto.query = async function (this: unknown, sql: string, params?: unknown[]) {
    const result = await query.call(this, sql, params);
    if (!fired && sql.includes('select taken_at, done_at from kolab_host_request')) {
      fired = true;
      await query.call(this, `delete from kolab_host_request where id = $1`, [request]);
    }
    return result;
  };
  try {
    expect(await rejection(kolab.answerHost(ann, request, true, 'r'))).toBe('TenancyError: there is no request of yours by that id in kolab hub');
  } finally { proto.query = query; }
  expect(fired).toBe(true);
});

test(`a request taken and never answered stops counting toward the ${MAX_HOST_REQUESTS_WAITING} after ${HOST_TAKEN_SECONDS} seconds, and still reads as taken`, async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  for (let i = 0; i < MAX_HOST_REQUESTS_WAITING; i++) await kolab.askHost(ann, 'laptop', 'start', 'b');
  const taken = [...(await kolab.serveHost(ann, serving('laptop'))).requests, ...(await kolab.serveHost(ann, serving('laptop'))).requests];
  expect(taken).toHaveLength(MAX_HOST_REQUESTS_WAITING);
  expect(await rejection(kolab.askHost(ann, 'laptop', 'start', 'b'))).toMatch(/requests not answered yet/);
  // The host crashed: just inside the window, they still count; past it, they don't.
  await kolab.db.query(`update kolab_host_request set taken_at = clock_timestamp() - make_interval(secs => $1)`, [HOST_TAKEN_SECONDS - 5]);
  expect(await rejection(kolab.askHost(ann, 'laptop', 'start', 'b'))).toMatch(/requests not answered yet/);
  await kolab.db.query(`update kolab_host_request set taken_at = clock_timestamp() - make_interval(secs => $1)`, [HOST_TAKEN_SECONDS + 1]);
  expect((await kolab.askHost(ann, 'laptop', 'start', 'b')).request).toMatch(/^[a-f0-9]{32}$/);
  expect((await kolab.readHostRequest(ann, taken[0].id)).request.state).toBe('taken');
  expect(await kolab.answerHost(ann, taken[0].id, true, 'late')).toStrictEqual({ answered: true });
});

test(`a person makes at most ${MAX_HOST_ASKS_PER_HOUR} requests in a kolab an hour, counted from their requests of the last hour; past it, told when to try again`, async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  await kolab.serveHost(bo, serving('laptop'));
  // Answered requests of the last hour, as asking and answering leave them: they count, though none waits.
  const made = (owner: string, n: number, minutesAgo: number) => kolab.db.query(
    `insert into kolab_host_request(id, kolab_id, owner, host, kind, body, created_at, expires_at, taken_at, done_at, ok, answered_by)
     select md5($1 || i::text), 'hub', $1, 'laptop', 'start', '', t, t + interval '1 minute', t, t, true, $1
       from generate_series(1, $2) i, lateral (select clock_timestamp() - make_interval(mins => $3) - make_interval(secs => i) as t) x`, [owner, n, minutesAgo]);
  await made('ann', MAX_HOST_ASKS_PER_HOUR - 1, 30);
  expect((await kolab.askHost(ann, 'laptop', 'start', 'b')).request).toMatch(/^[a-f0-9]{32}$/);
  const refused = await rejection(kolab.askHost(ann, 'laptop', 'start', 'b'));
  expect(refused).toMatch(new RegExp(`^LimitError: you have made ${MAX_HOST_ASKS_PER_HOUR} requests of your hosts in kolab hub in the last hour, the most a person makes \\(${MAX_HOST_ASKS_PER_HOUR}\\): try again after (\\S+)$`));
  // When the oldest of them is an hour old.
  const oldest = (await kolab.db.query<{ t: Date }>(`select min(created_at) as t from kolab_host_request where owner = 'ann'`)).rows[0].t;
  expect(refused.endsWith(`after ${new Date(new Date(oldest).getTime() + 3600_000).toISOString()}`)).toBe(true);
  // Another person's budget is their own.
  expect((await kolab.askHost(bo, 'laptop', 'start', 'b')).request).toMatch(/^[a-f0-9]{32}$/);
  // Past the hour, they no longer count, and they are cleared away.
  await kolab.db.query(`update kolab_host_request set created_at = created_at - interval '31 minutes', expires_at = expires_at - interval '31 minutes' where owner = 'ann' and body = ''`);
  expect((await kolab.askHost(ann, 'laptop', 'start', 'b')).request).toMatch(/^[a-f0-9]{32}$/);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request where owner = 'ann'`)).rows[0]).toStrictEqual({ n: 2 });
});

test(`cleanup clears the caller's own old rows without limit, and at most ${HOST_CLEANUP_OTHERS} of anyone else's a call, oldest first`, async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  await kolab.serveHost(bo, serving('laptop'));
  const old = (owner: string, n: number) => kolab.db.query(
    `insert into kolab_host_request(id, kolab_id, owner, host, kind, body, created_at, expires_at)
     select md5($1 || i::text), 'hub', $1, 'laptop', 'start', 'sealed', t, t + interval '1 minute'
       from generate_series(1, $2) i, lateral (select clock_timestamp() - interval '2 hours' - make_interval(secs => i) as t) x`, [owner, n]);
  const count = async (owner: string) => (await kolab.db.query<{ n: number }>(`select count(*)::int as n from kolab_host_request where owner = $1`, [owner])).rows[0].n;
  await old('ann', 50);
  await old('bo', 50);
  // Ann serving: all of hers go, and the 20 oldest of Bo's.
  await kolab.serveHost(ann, serving('laptop'));
  expect(await count('ann')).toBe(0);
  expect(await count('bo')).toBe(50 - HOST_CLEANUP_OTHERS);
  const left = (await kolab.db.query<{ id: string }>(`select id from kolab_host_request where owner = 'bo' order by created_at`)).rows.map((r) => r.id);
  expect(left).toStrictEqual(Array.from({ length: 30 }, (_, i) => i + 1).reverse().map((i) => md5(`bo${i}`)));
  // Asking clears too: Ann's own new old rows, and 20 more of Bo's.
  await old('ann', 5);
  await kolab.askHost(ann, 'laptop', 'start', 'b');
  expect(await count('ann')).toBe(1);
  expect(await count('bo')).toBe(50 - 2 * HOST_CLEANUP_OTHERS);
  // Bo's own serve clears the rest of his.
  await kolab.serveHost(bo, serving('laptop'));
  expect(await count('bo')).toBe(0);

  // Expired bodies: the caller's own all, others' at most 20 a call.
  const expired = (owner: string, n: number) => kolab.db.query(
    `insert into kolab_host_request(id, kolab_id, owner, host, kind, body, created_at, expires_at)
     select md5('x' || $1 || i::text), 'hub', $1, 'laptop', 'start', 'sealed', t, t + interval '1 minute'
       from generate_series(1, $2) i, lateral (select clock_timestamp() - interval '10 minutes' - make_interval(secs => i) as t) x`, [owner, n]);
  await expired('ann', 30);
  await expired('bo', 30);
  await kolab.serveHost(ann, serving('laptop'));
  const sealed = async (owner: string) => (await kolab.db.query<{ n: number }>(`select count(*)::int as n from kolab_host_request where owner = $1 and body <> '' and taken_at is null`, [owner])).rows[0].n;
  expect(await sealed('ann')).toBe(0);
  expect(await sealed('bo')).toBe(30 - HOST_CLEANUP_OTHERS);
  // The rows stay, reading as expired.
  expect(await count('bo')).toBe(30);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request where owner = 'ann' and taken_at is null`)).rows[0]).toStrictEqual({ n: 30 });

  // Forgotten hosts: the caller's own, and at most 20 of others'.
  await kolab.db.query(
    `insert into kolab_host(kolab_id, owner, name, instance, public_key, started_at, seen_at)
     select 'hub', 'bo', 'old-' || i, $1, $2, t, t from generate_series(1, 25) i,
       lateral (select clock_timestamp() - interval '8 days' - make_interval(secs => i) as t) x`, [I1, KEY]);
  await kolab.serveHost(ann, serving('laptop'));
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host where owner = 'bo' and name like 'old-%'`)).rows[0]).toStrictEqual({ n: 25 - HOST_CLEANUP_OTHERS });
});

test('a request taken at the very moment it expires is judged at the serve\'s one moment', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const { request } = await kolab.askHost(ann, 'laptop', 'start', 'b');
  // Expires exactly at the moment the serve reads: not in the future, so not taken.
  const proto = Object.getPrototypeOf(kolab.db);
  const query = proto.query;
  let fired = false;
  proto.query = async function (this: unknown, sql: string, params?: unknown[]) {
    const result = await query.call(this, sql, params);
    if (!fired && sql.includes('clock_timestamp()::text as at')) {
      fired = true;
      await query.call(this, `update kolab_host_request set expires_at = $1::timestamptz where id = $2`, [(result as { rows: { at: string }[] }).rows[0].at, request]);
    }
    return result;
  };
  try {
    expect((await kolab.serveHost(ann, serving('laptop'))).requests).toStrictEqual([]);
  } finally { proto.query = query; }
  expect(fired).toBe(true);
  expect((await kolab.readHostRequest(ann, request)).request.state).toBe('expired');
});

test(`caps: ${MAX_HOSTS_PER_PERSON} hosts a person in a kolab, ${MAX_HOST_REQUESTS_WAITING} requests not answered a host; a body over ${MAX_HOST_BODY} characters, a result over ${MAX_HOST_RESULT}`, async () => {
  const { kolab, ann, bo } = await hub();
  for (let i = 0; i < MAX_HOSTS_PER_PERSON; i++) await kolab.serveHost(ann, serving(`h-${i}`));
  expect(await rejection(kolab.serveHost(ann, serving('one-more')))).toMatch(new RegExp(`^LimitError: you have ${MAX_HOSTS_PER_PERSON} hosts in kolab hub, the most a person has`));
  // Serving one already had is no new host; another person counts apart.
  expect((await kolab.serveHost(ann, serving('h-0'))).host.name).toBe('h-0');
  expect((await kolab.serveHost(bo, serving('one-more'))).host.name).toBe('one-more');

  for (let i = 0; i < MAX_HOST_REQUESTS_WAITING; i++) await kolab.askHost(ann, 'h-0', 'start', 'b');
  expect(await rejection(kolab.askHost(ann, 'h-0', 'start', 'b'))).toMatch(new RegExp(`^LimitError: host h-0 has ${MAX_HOST_REQUESTS_WAITING} requests not answered yet`));
  // Taken and not answered still count; answered ones and expired ones don't.
  const taken = (await kolab.serveHost(ann, serving('h-0'))).requests;
  expect(await rejection(kolab.askHost(ann, 'h-0', 'start', 'b'))).toMatch(/requests not answered yet/);
  await kolab.answerHost(ann, taken[0].id, true, 'r');
  const next = await kolab.askHost(ann, 'h-0', 'start', 'b');
  expect(await rejection(kolab.askHost(ann, 'h-0', 'start', 'b'))).toMatch(/requests not answered yet/);
  await expire(kolab, next.request);
  expect((await kolab.askHost(ann, 'h-0', 'start', 'b')).request).toMatch(/^[a-f0-9]{32}$/);
  // Another host of the same person counts apart.
  expect((await kolab.askHost(ann, 'h-1', 'start', 'b')).request).toMatch(/^[a-f0-9]{32}$/);

  // The body, counted as message text is, in code points; refused before anything is written, and never quoted.
  const before = (await kolab.db.query<{ n: number }>(`select count(*)::int as n from kolab_host_request`)).rows[0];
  expect((await kolab.askHost(ann, 'h-2', 'start', 'x'.repeat(MAX_HOST_BODY))).request).toMatch(/^[a-f0-9]{32}$/);
  const big = await rejection(kolab.askHost(ann, 'h-2', 'start', 'SECRET'.repeat(MAX_HOST_BODY / 6) + 'x'));
  expect(big).toMatch(new RegExp(`^LimitError: the request's body is ${(MAX_HOST_BODY + 1).toLocaleString('en')} characters; the limit is ${MAX_HOST_BODY.toLocaleString('en')}`));
  expect(big).not.toContain('SECRET');
  expect(await rejection(kolab.askHost(ann, 'h-2', 'start', '😀'.repeat(MAX_HOST_BODY + 1)))).toMatch(/the request's body is/);
  expect(await rejection(kolab.askHost(ann, 'h-2', 'start', 'nul\u0000here'))).toMatch(/^LimitError: the request's body holds a NUL character/);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request`)).rows[0]).toStrictEqual({ n: before.n + 1 });

  const [one] = (await kolab.serveHost(ann, serving('h-2'))).requests;
  expect(await rejection(kolab.answerHost(ann, one.id, true, 'r'.repeat(MAX_HOST_RESULT + 1)))).toMatch(new RegExp(`^LimitError: the answer's result is ${(MAX_HOST_RESULT + 1).toLocaleString('en')} characters`));
  expect(await kolab.answerHost(ann, one.id, true, 'r'.repeat(MAX_HOST_RESULT))).toStrictEqual({ answered: true });
});

test('what a host says is checked: its name, instance, key, folder and agents', async () => {
  const { kolab, ann } = await hub();
  for (const name of ['', 'Laptop', '-x', 'a b', 'x'.repeat(41), 'café']) {
    expect(await rejection(kolab.serveHost(ann, serving(name)))).toMatch(/^LimitError: .* is no host name/);
    expect(await rejection(kolab.askHost(ann, name, 'start', 'b'))).toMatch(/is no host name/);
    expect(await rejection(kolab.endHost(ann, name))).toMatch(/is no host name/);
  }
  expect((await kolab.serveHost(ann, serving('x'.repeat(40)))).host.name).toBe('x'.repeat(40));
  for (const instance of ['short', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(65)]) {
    expect(await rejection(kolab.serveHost(ann, serving('laptop', instance)))).toMatch(/^LimitError: instance names the process serving the host/);
  }
  for (const public_key of ['k'.repeat(42), 'k'.repeat(44), `${'k'.repeat(42)}=`, `${'k'.repeat(42)}+`]) {
    expect(await rejection(kolab.serveHost(ann, serving('laptop', I1, { public_key })))).toMatch(/^LimitError: public_key is the host's X25519 public key/);
  }
  for (const folder of ['', 'a\nb', 'tab\there', 'f'.repeat(401)]) {
    expect(await rejection(kolab.serveHost(ann, serving('laptop', I1, { folder })))).toMatch(/^LimitError: (folder is where|a host's folder is one line|the host's folder is 401)/);
  }
  for (const agents of [['Claude'], ['a b'], ['x'.repeat(25)], Array.from({ length: 101 }, (_, i) => `a${i}`), 'claude', [1]]) {
    expect(await rejection(kolab.serveHost(ann, serving('laptop', I1, { agents })))).toMatch(/^LimitError: agents is a list of at most 100 agent labels/);
    expect(await rejection(kolab.serveHost(ann, serving('laptop', I1, { running: agents })))).toMatch(/^LimitError: running is a list/);
  }
  const bare = await kolab.serveHost(ann, { name: 'bare', instance: I1, public_key: KEY });
  expect(bare.host).toMatchObject({ folder: null, agents: [], running: [] });
});

test('end deletes the host and every request to it; with an instance, only while that instance serves it', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop', I1));
  await kolab.askHost(ann, 'laptop', 'start', 'b');
  expect(await kolab.endHost(ann, 'laptop', I2)).toStrictEqual({ ended: false });
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request`)).rows[0]).toStrictEqual({ n: 1 });
  expect((await kolab.listHosts(ann)).hosts).toHaveLength(1);
  expect(await kolab.endHost(ann, 'laptop', I1)).toStrictEqual({ ended: true });
  expect(await kolab.listHosts(ann)).toStrictEqual({ hosts: [] });
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request`)).rows[0]).toStrictEqual({ n: 0 });
  expect(await kolab.endHost(ann, 'laptop')).toStrictEqual({ ended: false });
  await kolab.serveHost(ann, serving('laptop', I2));
  expect(await kolab.endHost(ann, 'laptop')).toStrictEqual({ ended: true });
  // Kolab's record of each end, for its admins: who, which kolab, which host.
  expect((await kolab.auditLog({ kolab: 'hub' })).filter((a) => a.action === 'host.ended').map((a) => [a.by, a.subject, a.detail]))
    .toStrictEqual([['ann', 'ann', { host: 'laptop' }], ['ann', 'ann', { host: 'laptop' }]]);
  expect(await rejection(kolab.endHost(ann, 'laptop', 'nope'))).toMatch(/^LimitError: instance names the process/);
});

test('a person removed from a kolab, or leaving it, loses their hosts and requests there in the same transaction; others keep theirs', async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.createKolab('side', { owner: 'bo' });
  // Bo's host in another kolab too, written as serving there would write it (one session per machine here).
  await kolab.db.query(`insert into kolab_host(kolab_id, owner, name, instance, public_key, started_at, seen_at) values ('side', 'bo', 'laptop', $1, $2, now(), now())`, [I1, KEY]);
  await kolab.db.query(`insert into kolab_host_request(id, kolab_id, owner, host, kind, body, created_at, expires_at) values ($1, 'side', 'bo', 'laptop', 'start', 'b', now(), now() + interval '1 minute')`, ['c'.repeat(32)]);
  await kolab.serveHost(bo, serving('laptop'));
  await kolab.askHost(bo, 'laptop', 'start', 'b');
  await kolab.serveHost(ann, serving('laptop'));
  await kolab.askHost(ann, 'laptop', 'start', 'b');

  await kolab.removeKolabMember(ann, 'bo');
  expect((await kolab.db.query(`select kolab_id, owner from kolab_host order by kolab_id, owner`)).rows)
    .toStrictEqual([{ kolab_id: 'hub', owner: 'ann' }, { kolab_id: 'side', owner: 'bo' }]);
  expect((await kolab.db.query(`select kolab_id, owner from kolab_host_request order by kolab_id, owner`)).rows)
    .toStrictEqual([{ kolab_id: 'hub', owner: 'ann' }, { kolab_id: 'side', owner: 'bo' }]);

  // Leaving takes them too.
  await kolab.grant('hub', 'bo', 'write');
  const bo2 = await kolab.openSession('bo', 'engineer', { kolab: 'hub' });
  await kolab.serveHost(bo2, serving('desk'));
  await kolab.askHost(bo2, 'desk', 'stop', 'b');
  await kolab.leaveKolab(bo2);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host where kolab_id = 'hub' and owner = 'bo'`)).rows[0]).toStrictEqual({ n: 0 });
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request where kolab_id = 'hub' and owner = 'bo'`)).rows[0]).toStrictEqual({ n: 0 });
  expect((await kolab.listHosts(ann)).hosts.map((h) => h.name)).toStrictEqual(['laptop']);
});

test('requests over an hour old and hosts unseen for days are cleared away as hosts serve', async () => {
  const { kolab, ann, bo } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const old = await kolab.askHost(ann, 'laptop', 'start', 'b');
  await kolab.serveHost(bo, serving('gone'));
  await kolab.askHost(bo, 'gone', 'start', 'b');
  await kolab.db.query(`update kolab_host_request set created_at = clock_timestamp() - interval '61 minutes', expires_at = clock_timestamp() - interval '60 minutes' where id = $1`, [old.request]);
  await kolab.db.query(`update kolab_host set seen_at = clock_timestamp() - make_interval(days => $1) - interval '1 minute' where owner = 'bo'`, [HOST_FORGOTTEN_DAYS]);
  await kolab.serveHost(ann, serving('laptop'));
  expect((await kolab.db.query(`select owner, name from kolab_host`)).rows).toStrictEqual([{ owner: 'ann', name: 'laptop' }]);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request`)).rows[0]).toStrictEqual({ n: 0 });
});

test('serve, answer, read, list and end are quiet: they renew no work lease', async () => {
  const { kolab, ann } = await hub();
  const calls: string[] = [];
  const renew = (kolab as unknown as { renewLease: (...a: unknown[]) => Promise<void> }).renewLease;
  (kolab as unknown as { renewLease: (...a: unknown[]) => Promise<void> }).renewLease = async function (this: unknown, ...a: unknown[]) {
    calls.push(String(a[0]));
    return renew.apply(this, a);
  };
  try {
    await kolab.serveHost(ann, serving('laptop'));
    await kolab.listHosts(ann);
    expect(calls).toStrictEqual([]);
    // Asking is a person working, as any other verb is: it renews, which shows the check can see a renewal.
    const { request } = await kolab.askHost(ann, 'laptop', 'start', 'b');
    expect(calls).toStrictEqual(['ann']);
    calls.length = 0;
    await kolab.serveHost(ann, serving('laptop'));
    await kolab.readHostRequest(ann, request);
    await kolab.answerHost(ann, request, true, 'r');
    await kolab.endHost(ann, 'laptop');
    expect(calls).toStrictEqual([]);
  } finally {
    (kolab as unknown as { renewLease: unknown }).renewLease = renew;
  }
});

test('archiving a kolab ends its sessions, so every host verb answers no open session; and the database refuses any change to its hosts and requests', async () => {
  const { kolab, ann } = await hub();
  await kolab.serveHost(ann, serving('laptop'));
  const { request } = await kolab.askHost(ann, 'laptop', 'start', 'b');
  await kolab.serveHost(ann, serving('laptop'));
  await kolab.archive({ kolab: 'hub' });
  const ended = /^RoleError: no open session for that token/;
  expect(await rejection(kolab.serveHost(ann, serving('laptop')))).toMatch(ended);
  expect(await rejection(kolab.askHost(ann, 'laptop', 'start', 'b'))).toMatch(ended);
  expect(await rejection(kolab.answerHost(ann, request, true, 'r'))).toMatch(ended);
  expect(await rejection(kolab.readHostRequest(ann, request))).toMatch(ended);
  expect(await rejection(kolab.listHosts(ann))).toMatch(ended);
  expect(await rejection(kolab.endHost(ann, 'laptop'))).toMatch(ended);
  // Nothing changed, and the database refuses a change made around the verbs.
  expect((await kolab.db.query(`select done_at from kolab_host_request where id = $1`, [request])).rows).toStrictEqual([{ done_at: null }]);
  expect(await rejection(kolab.db.query(`update kolab_host set folder = 'x'`))).toMatch(/archived/);
  expect(await rejection(kolab.db.query(`delete from kolab_host_request`))).toMatch(/archived/);
});

test('quiet only skips renewing leases: an ended or revoked session is refused serve, read, list, answer and end', async () => {
  const { kolab, ann, bo } = await hub();
  for (const who of [ann, bo]) await kolab.serveHost(who, serving('laptop'));
  const annReq = (await kolab.askHost(ann, 'laptop', 'start', 'b')).request;
  const boReq = (await kolab.askHost(bo, 'laptop', 'start', 'b')).request;
  for (const who of [ann, bo]) await kolab.serveHost(who, serving('laptop'));
  const everyQuietVerb = (s: string, req: string) => [
    kolab.serveHost(s, serving('laptop')), kolab.readHostRequest(s, req), kolab.listHosts(s), kolab.answerHost(s, req, true, 'r'), kolab.endHost(s, 'laptop'),
  ];
  // Ended: ann signs out.
  await kolab.endSession(ann, { signingOut: true });
  for (const p of everyQuietVerb(ann, annReq)) expect(await rejection(p)).toMatch(/^RoleError: no open session for that token/);
  // Revoked: bo's grant goes, and his session with it.
  await kolab.revoke('hub', 'bo');
  for (const p of everyQuietVerb(bo, boReq)) expect(await rejection(p)).toMatch(/no open session for that token|can no longer reach kolab hub/);
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host_request where done_at is not null`)).rows[0]).toStrictEqual({ n: 0 });
  expect((await kolab.db.query(`select count(*)::int as n from kolab_host`)).rows[0]).toStrictEqual({ n: 2 });
});
