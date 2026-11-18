// konnect lease, against a Kolab started here: a named thing one member, a person or an agent, holds
// at a time, for a while. Claiming, renewing, being told who holds it, waiting for it, giving it up,
// a person ending someone's, holding one while a command runs, and the agent's three lease tools.
import { afterEach, expect, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveMcp } from '../src/konnect.js';
import { browse, exitOf, fails, machine, pressing, teams } from './team.js';

afterEach(() => { process.exitCode = 0; });

test('konnect lease: claim and renew, who holds what, waiting for one, release, a person breaking one, and --for', async () => {
  const { server, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');

  expect(await bo.run(['lease', 'list'])).toBe('Nothing is held in team hub.');
  // Ann holds it, 15 minutes unless told, with a note for the others; claiming her own again renews it.
  expect(await ann.run(['lease', 'claim', 'testdb', 'running', 'migrations'])).toMatch(/^You hold testdb until \d\d:\d\d UTC \(15 min\)\. Give it up with: konnect lease release testdb$/);
  expect(await ann.run(['lease', 'claim', '--for', '2h', 'testdb'])).toMatch(/^Renewed testdb until \d\d:\d\d UTC \(120 min\)\./);
  expect(await bo.run(['lease', 'list'])).toMatch(/^testdb {3}@ann {3}until \d\d:\d\d UTC \(1(20|19) min\) {3}running migrations$/);
  expect(JSON.parse(await bo.run(['lease', 'list', '--json']))).toMatchObject([{ name: 'testdb', holder: 'ann', note: 'running migrations' }]);

  // Bo is told who holds it and until when (4), and holds nothing.
  expect(await fails(bo.run(['lease', 'claim', 'testdb']))).toMatch(/^testdb is held by @ann until \d\d:\d\d UTC \(\d+ min\): running migrations\. Wait for it with --wait <time>; a person can end it with konnect lease break testdb$/);
  expect(await exitOf(bo.run(['lease', 'claim', 'testdb']))).toBe(4);
  // --wait: it looks again every 2 seconds, and takes it when it comes free; when it doesn't, the wait runs out (5).
  const paused: number[] = [];
  expect(await exitOf(bo.run(['lease', 'claim', '--wait', '5s', 'testdb'], { pause: async (ms) => { paused.push(ms); } }))).toBe(5);
  expect(paused).toStrictEqual([2000, 2000, 1000]);
  let freed = false;
  expect(await bo.run(['lease', 'claim', '--wait', '1m', 'testdb'], { pause: async () => { if (!freed) { freed = true; await ann.run(['lease', 'release', 'testdb']); } } })).toMatch(/^You hold testdb until /);

  // Giving up: only what you hold. Ending someone else's is a person's, with lease break.
  expect(await exitOf(ann.run(['lease', 'release', 'testdb']))).toBe(4);
  expect(await ann.run(['lease', 'release', 'nothing-here'])).toBe('You weren\'t holding nothing-here.');
  expect(await ann.run(['lease', 'break', 'testdb'])).toBe('Ended @bo\'s lease on testdb.');
  expect(await ann.run(['lease', 'break', 'testdb'])).toBe('Nobody was holding testdb.');
  expect(await bo.run(['lease', 'list'])).toBe('Nothing is held in team hub.');

  // What is no lease's name or length is a usage error (2), before anything is asked.
  expect(await fails(ann.run(['lease', 'claim', 'has space']))).toMatch(/^has space isn't a lease's name: /);
  expect(await fails(ann.run(['lease', 'claim', '--for', '30s', 'x']))).toBe('--for is from 1m to 4h');
  expect(await fails(ann.run(['lease', 'claim']))).toBe('konnect lease claim <name> [<note>...]: name what to hold, such as testdb');
  expect(await fails(ann.run(['lease', 'steal', 'x']))).toBe('konnect lease has no steal: it is list, claim, release, break or run');
  expect(await fails(ann.run(['lease', 'list', '--for', '5m']))).toBe('konnect lease list takes no --for: konnect lease claim and konnect lease run do');
  expect(await exitOf(ann.run(['lease']))).toBe(2);
});

test('konnect lease run holds the lease while the command runs and releases it after; an agent holds leases as itself, with --agent and with its tools', async () => {
  const { server, idp, signIn, ann: annId, bo: boId } = await teams();
  const ann = machine(server.url, 'ann');
  const bo = machine(server.url, 'bo');
  await signIn(ann, annId, 'hub');
  await signIn(bo, boId, 'hub');

  // While the command runs the lease is held, noted with what is running; after, it is free again.
  let during = '';
  const ran: { cmd: string; args: string[] }[] = [];
  await ann.run(['lease', 'run', '--for', '5m', 'testdb', 'npm', 'test', '--json'], { start: async (c) => { ran.push(c); during = await bo.run(['lease', 'list']); return 3; } });
  expect(ran).toMatchObject([{ cmd: 'npm', args: ['test', '--json'] }]);
  expect(during).toMatch(/^testdb {3}@ann {3}until \d\d:\d\d UTC \([45] min\) {3}running npm$/);
  expect(process.exitCode).toBe(3);
  expect(await bo.run(['lease', 'list'])).toBe('Nothing is held in team hub.');
  // Held by someone else: the command isn't started (4); with --wait it is, once the lease is free.
  await bo.run(['lease', 'claim', 'testdb']);
  expect(await exitOf(ann.run(['lease', 'run', 'testdb', 'npm', 'test'], { start: async () => { throw new Error('started'); } }))).toBe(4);
  expect(await bo.run(['lease', 'list'])).toMatch(/^testdb {3}@bo /);
  let freed = false;
  await ann.run(['lease', 'run', '--wait', '1m', 'testdb', 'true'], { pause: async () => { if (!freed) { freed = true; await bo.run(['lease', 'release', 'testdb']); } }, start: async (c) => { ran.push(c); return 0; } });
  expect(ran).toHaveLength(2);
  expect(await fails(ann.run(['lease', 'run', 'testdb']))).toBe('konnect lease run testdb <command>...: say what to run while holding it');

  // A lease is a member's, not a process's: one Ann holds already (a claim, or another lease run) starts
  // nothing (4), and is left as it was, never released under whoever is using it.
  await ann.run(['lease', 'claim', 'testdb', 'by hand']);
  expect(await fails(ann.run(['lease', 'run', 'testdb', 'npm', 'test'], { start: async () => { throw new Error('started'); } })))
    .toBe('you hold testdb already, from another konnect lease run or a konnect lease claim, so this command wasn\'t started: wait for that to end, or konnect lease release testdb');
  expect(await bo.run(['lease', 'list'])).toMatch(/^testdb {3}@ann {3}until .* {3}by hand$/);
  let inner = '';
  await ann.run(['lease', 'release', 'testdb']);
  await ann.run(['lease', 'run', 'testdb', 'outer'], { start: async () => { inner = await fails(ann.run(['lease', 'run', 'testdb', 'inner'], { start: async () => { throw new Error('started'); } })); expect(await bo.run(['lease', 'list'])).toMatch(/^testdb {3}@ann /); return 0; } });
  expect(inner).toMatch(/^you hold testdb already/);
  // A person ends the lease while the command runs: it is not taken back, and not released from under its next holder.
  await ann.run(['lease', 'run', 'testdb', 'long'], { start: async () => { await bo.run(['lease', 'break', 'testdb']); await bo.run(['lease', 'claim', 'testdb']); return 0; } });
  expect(await ann.run(['lease', 'list'])).toMatch(/^testdb {3}@bo /);
  await bo.run(['lease', 'release', 'testdb']);
  expect(await fails(ann.run(['lease', 'run', 'testdb', '--wait', '1m', 'true']))).toMatch(/^konnect lease run: --wait is an option of konnect's, and options go before <name>/);

  // An agent holds leases as itself: with --agent from a script, and with its three tools in its harness. It can't break one.
  await ann.run(['agent', 'add', 'helper'], { open: (u) => { idp.next(annId); void browse(u, pressing('decision=allow')); }, self: () => ({ command: 'node', args: ['k.mjs'] }) });
  expect(await ann.run(['--agent', 'helper', 'lease', 'claim', 'port-3000'])).toMatch(/^You hold port-3000 until /);
  expect(await bo.run(['lease', 'list'])).toMatch(/^port-3000 {3}@ann\/helper {3}until /);
  expect(await exitOf(ann.run(['--agent', 'helper', 'lease', 'break', 'port-3000']))).toBe(4);
  await bo.run(['lease', 'claim', 'apps/server/src/x.ts', 'editing']);

  const [a, b] = InMemoryTransport.createLinkedPair();
  const s = await serveMcp({ team: 'hub', url: server.url, file: `${ann.env.KONNECT_CONFIG_DIR}/agents/hub/helper.json`, label: 'helper', wake: false }, b);
  const c = new Client({ name: 'harness-stand-in', version: '0' });
  await c.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await c.callTool({ name, arguments: args }); return (r.content as { text: string }[])[0].text; };
  try {
    expect(await call('konnect_lease_list')).toMatch(/^port-3000 +@ann\/helper {3}until .*\napps\/server\/src\/x\.ts {3}@bo +until .* {3}editing$/);
    expect(await call('konnect_lease_claim', { name: 'apps/server/src/x.ts' })).toMatch(/^apps\/server\/src\/x\.ts is held by @bo until \d\d:\d\d UTC \(\d+ min\): editing\. You don't hold it\.$/);
    expect(await call('konnect_lease_claim', { name: 'port-3000', minutes: 30, note: 'dev server' })).toMatch(/^Renewed port-3000 until \d\d:\d\d UTC \(30 min\)\.$/);
    expect(await call('konnect_lease_release', { name: 'port-3000' })).toBe('Released port-3000.');
    expect(await call('konnect_lease_release', { name: 'port-3000' })).toBe('You weren\'t holding port-3000.');
  } finally { await c.close(); await s.close(); }
});
