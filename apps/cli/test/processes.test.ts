// Two Kolab server processes on one Postgres database (API5, W2.2; D9): an agent listening on
// one hears a change made through the other, and a session ended through one closes its
// streams on the other (D41). Process A runs in this test; process B is
// `konjir serve` from the compiled dist/, in a child process, as the instance runs it.
import { expect, test } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { startServer } from '@konjir/server';
import { closeAtEnd, els, openKolab, people, testStore } from '@konjir/engine/testing';
import { call, connect, watch } from '../src/cli.js';

const root = resolve(import.meta.dirname, '../../..');
const onPostgres = !!process.env.KONJIR_TEST_DATABASE_URL;

let child: ChildProcess | undefined;

/** Stops the child server, and resolves once it has exited. */
async function stopChild() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child!.once('exit', () => done()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child!.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  }
}

/** Starts `konjir serve` on the database in a child process, and resolves with its MCP URL. */
async function serveInChild(databaseUrl: string, adminToken: string): Promise<string> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  closeAtEnd({ close: stopChild });
  child = spawn('node', [join(root, 'apps/cli/dist/main.js'), 'serve', '--port', String(port), '--database-url', databaseUrl, '--quiet'], {
    env: { ...process.env, NODE_OPTIONS: '--no-experimental-strip-types', KONJIR_ADMIN_TOKEN: adminToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  const exited = new Promise<'exited'>((done) => child!.on('exit', () => done('exited')));
  const listening = new Promise<'listening'>((done) => child!.stdout!.on('data', () => { if (output.includes('Kolab listening')) done('listening'); }));
  expect({ outcome: await Promise.race([listening, exited]), output: child.exitCode === null ? '' : output })
    .toStrictEqual({ outcome: 'listening', output: '' });
  return `http://127.0.0.1:${port}/mcp`;
}

const settle = () => new Promise((r) => setTimeout(r, 500));
/** How a subscription closed, or 'open' if it is still open after `ms`. */
const settled = (closed: Promise<unknown>, ms: number) =>
  Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), ms).unref())]);
async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// PGlite is one process: a second can't open its database.
(onPostgres ? test : test.skip)('an agent listening on one server process hears a change made through another, once', async () => {
  const { databaseUrl } = await testStore();
  const a = await startServer({ adminToken: 'admin', databaseUrl });
  closeAtEnd(a);
  const bUrl = await serveInChild(databaseUrl!, 'admin');

  // Sessions live in the database, so a token opened on B works on A.
  const adminB = await connect(bUrl, 'admin');
  closeAtEnd(adminB);
  const session = async (actor: string, role: 'product' | 'engineer') => {
    await call(adminB, 'admin_add_actor', { id: actor });
    await call(adminB, 'admin_add_organization', { id: 'test-org' }).catch(() => undefined);
  await call(adminB, 'admin_add_kolab', { name: 'test', owner: 'test-org' }).catch(() => undefined);
  await call(adminB, 'admin_grant', { kolab: 'test', to: actor, level: 'write' });
    return (await call(adminB, 'admin_open_session', { actor, role }) as { token: string }).token;
  };
  const pmToken = await session('pm', 'product');
  const engToken = await session('eng', 'engineer');
  const client = async (url: string, token: string) => { const c = await connect(url, token); closeAtEnd(c); return c; };
  const pmOnA = await client(a.url, pmToken);
  const engOnA = await client(a.url, engToken);
  const pmOnB = await client(bUrl, pmToken);
  const engOnB = await client(bUrl, engToken);

  // Both agents listen on A.
  const pushed: { who: string; uri: string; body: { queries?: { question: string; answer?: string | null }[] } }[] = [];
  const subscriptions: Record<string, Awaited<ReturnType<typeof watch>>['subscription']> = {};
  for (const [who, c] of [['pm', pmOnA], ['eng', engOnA]] as const) {
    const w = await watch(c, (uri, body) => { pushed.push({ who, uri, body: body as never }); });
    subscriptions[who] = w.subscription;
    closeAtEnd(w.subscription);
  }

  await call(pmOnB, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(pmOnB, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(pmOnB, 'submit_for_review', { node: 'orders', version: 1 });

  // The engineer asks through B; product, listening on A, hears it.
  pushed.length = 0;
  const { query } = await call(engOnB, 'ask', { address: 'kj:orders#R8', question: 'From which statuses?' }) as { query: string };
  await until(() => pushed.length >= 1);
  expect(pushed.map((p) => [p.who, p.uri, p.body.queries!.map((q) => q.question)]))
    .toStrictEqual([['pm', 'konjir://inbox/functional', ['From which statuses?']]]);

  // Product answers through B; the engineer, listening on A, hears it in its answers.
  pushed.length = 0;
  await call(pmOnB, 'answer_query', { query, answer: 'Any status before Completed.' });
  await until(() => pushed.some((p) => p.who === 'eng'));
  await settle();
  expect(pushed.filter((p) => p.who === 'eng').map((p) => [p.uri, p.body.queries!.map((q) => q.answer)]))
    .toStrictEqual([['konjir://answers/eng', ['Any status before Completed.']]]);
  expect(pushed.filter((p) => p.who === 'pm').map((p) => [p.uri, p.body.queries]))
    .toStrictEqual([['konjir://inbox/functional', []]]);

  // A change made through A itself is heard once: A tells its own listeners when it commits,
  // and skips its own NOTIFY when that comes back.
  pushed.length = 0;
  await call(engOnA, 'annotate', { address: 'kj:orders#R8', note: 'Assuming office staff means the Office role.' });
  await until(() => pushed.length >= 1);
  await settle();
  expect(pushed.map((p) => [p.who, p.uri])).toStrictEqual([['pm', 'konjir://inbox/functional']]);

  // Ending the engineer's session through B closes its stream on A at once, with no further
  // change to trigger A's own check: the session-ended event crossed processes. Product's stays open.
  const t0 = Date.now();
  await call(adminB, 'admin_end_session', { token: engToken });
  expect(await settled(subscriptions.eng.closed, 2000)).toBe('graceful');
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(await settled(subscriptions.pm.closed, 100)).toBe('open');
}, 60_000);

// The listener re-establishes a lost LISTEN connection; what was committed meanwhile reaches
// that process's subscribers once it's back, as the Kolab resyncs (W2.10, D46). The other
// process here is a Kolab in this test: only its writes matter.
(onPostgres ? test : test.skip)('a change committed while a server\'s listener reconnects reaches its subscribers once it\'s back', async () => {
  const { databaseUrl } = await testStore();
  const a = await startServer({ adminToken: 'admin', databaseUrl });
  closeAtEnd(a);
  const b = await openKolab({ databaseUrl });
  await people(b, ['pm', 'eng']);
  const pmToken = await b.openSession('pm', 'product');
  const engToken = await b.openSession('eng', 'engineer');
  await b.createNode(pmToken, 'functional_spec', 'Orders', 'orders');
  await b.commit(pmToken, 'orders', { elements: els({ R8: 'Office staff can cancel an order.' }) });

  const pm = await connect(a.url, pmToken);
  closeAtEnd(pm);
  const pushed: { uri: string; questions: string[] }[] = [];
  const w = await watch(pm, (uri, body) => {
    pushed.push({ uri, questions: ((body as { queries?: { question: string }[] }).queries ?? []).map((q) => q.question) });
  });
  closeAtEnd(w.subscription);

  const originals = { error: console.error, warn: console.warn };
  console.error = console.warn = () => undefined;   // the listener's own lines about the loss
  try {
    // Drop A's listening connection, and only that, as the same login may.
    const killed = await b.db.query<{ ok: boolean }>(
      `select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = $1`,
      [`kolab-listen-${(a.kolab as unknown as { origin: string }).origin}`]);
    expect(killed.rows.map((r) => r.ok)).toStrictEqual([true]);
    const down = Date.now() + 5000;
    while ((await a.kolab.listenerConnected()) !== false) {
      if (Date.now() > down) throw new Error('the listener never noticed');
      await new Promise((r) => setTimeout(r, 20));
    }

    // The engineer asks through the other process while A can't hear it.
    await b.raiseQuery(engToken, 'kj:orders#R8', 'From which statuses?');
    expect(await a.kolab.listenerConnected()).toBe(false);
    await settle();
    expect(pushed).toStrictEqual([]);

    // Once A's listener is back, product, listening on A, hears it and reads the question.
    await until(() => pushed.some((p) => p.uri === 'konjir://inbox/functional'), 20_000);
    expect(await a.kolab.listenerConnected()).toBe(true);
    expect(pushed.find((p) => p.uri === 'konjir://inbox/functional')!.questions).toStrictEqual(['From which statuses?']);
    expect(await settled(w.subscription.closed, 100)).toBe('open');
  } finally {
    Object.assign(console, originals);
  }
}, 60_000);
