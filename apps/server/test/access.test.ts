// Who holds access, in the web page's API (W3.6, API8): a kolab's Admin lists everyone with their
// sources at /api/access, changes a direct grant's level and removes one, with no admin of
// Konjir's. Kolab decides who may (Admin, a person), what (direct grants only, never the last
// Admin, Admin only from the owners, an agent never above its owner), and what follows (sessions
// that can't reach the kolab end, and their event streams close); the API keeps the origin check.
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { closeAtEnd, openKolab } from '@konjir/engine/testing';
import type { KolabAccessView, WebAccessChanged } from '@konjir/types';
import { startServer } from '../src/server.js';

async function serve(kolab: Kolab) {
  const server = await startServer({ adminToken: 'admin-token', kolab, webRoot: null });
  closeAtEnd(server);
  return new URL(server.url).origin;
}

/** A page signed in as `token`, calling the API as the browser does, from Kolab's own origin unless told otherwise. */
async function signIn(base: string, token: string) {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const jar = res.headers.getSetCookie()[0].split(';')[0];
  return async <T = unknown>(path: string, body?: unknown, opts: { origin?: string | null } = {}) => {
    const headers: Record<string, string> = { cookie: jar };
    if (opts.origin !== null) headers.origin = opts.origin ?? base;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
}

/** Ann owns `anns`; Eli writes its technical layer, his agent too, and Fay is an Admin by grant. */
async function anns() {
  const kolab = await openKolab();
  for (const id of ['ann', 'eli', 'fay']) await kolab.addActor(id);
  await kolab.addActor('eli-claude', { owner: 'eli' });
  await kolab.createKolab('anns', { owner: 'ann' });
  await kolab.grant('anns', 'eli', 'write', { layers: ['technical'] });
  await kolab.grant('anns', 'fay', 'admin');
  await kolab.grant('anns', 'eli-claude', 'write', { layers: ['technical'] });
  return kolab;
}

test('an admin lists who holds access with its sources, changes a level and removes access; the sessions that lose it end', async () => {
  const kolab = await anns();
  const base = await serve(kolab);
  const ann = await signIn(base, await kolab.openSession('ann', 'product', { kolab: 'anns' }));
  const eliToken = await kolab.openSession('eli', 'engineer', { kolab: 'anns' });
  const agentToken = await kolab.openSession('eli-claude', 'engineer', { kolab: 'anns' });

  const list = await ann<KolabAccessView>('access');
  expect(list.status).toBe(200);
  expect(list.body.holders.map((h) => [h.actor, h.access.level, h.sources.map((s) => s.kind), h.grant?.level ?? null]))
    .toStrictEqual([['ann', 'admin', ['owner'], null], ['fay', 'admin', ['grant'], 'admin'], ['eli', 'write', ['grant'], 'write'], ['eli-claude', 'write', ['grant'], 'write']]);
  expect(JSON.stringify(list.body)).not.toContain(eliToken);

  // Eli to Write on both layers; then to Read, which caps his agent.
  expect(await ann<WebAccessChanged>('access/eli', { level: 'write', layers: ['functional', 'technical'] })).toStrictEqual({ status: 200, body: { ended: 0 } });
  expect(await kolab.access('eli', 'anns')).toStrictEqual({ level: 'write', layers: ['functional', 'technical'] });
  await ann('access/eli', { level: 'read' });
  expect((await ann<KolabAccessView>('access')).body.holders.find((h) => h.actor === 'eli-claude')).toMatchObject({ access: { level: 'read' }, capped: true });

  // Removing Eli ends his session and his agent's: nothing is left of either.
  expect(await ann<WebAccessChanged>('access/eli/remove', {})).toStrictEqual({ status: 200, body: { ended: 2 } });
  expect(await kolab.sessionOpen(eliToken)).toBe(false);
  expect(await kolab.sessionOpen(agentToken)).toBe(false);
  expect(await ann<WebAccessChanged>('access/eli-claude/remove', {})).toStrictEqual({ status: 200, body: { ended: 0 } });

  // Bad input is refused before Kolab, and Kolab's own refusals come back as the API's.
  expect((await ann('access/fay', { level: 'owner' })).status).toBe(400);
  expect((await ann('access/fay', { level: 'write', layers: 'technical' })).status).toBe(400);
  expect((await ann('access/eli/remove', {})).body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/eli holds no direct grant/) });
  expect((await ann(`access/${encodeURIComponent('acme/eng')}/remove`, {})).body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/a team's access/) });
});

test('only an Admin, from Kolab\'s own origin: Write is refused, the last Admin stays, Admin is the owners\' to give', async () => {
  const kolab = await openKolab();
  await kolab.addOrganization('acme');
  for (const id of ['fay', 'gus']) await kolab.addActor(id);
  await kolab.createKolab('shop', { owner: 'acme' });
  await kolab.grant('shop', 'fay', 'admin');
  await kolab.grant('shop', 'gus', 'write');
  const base = await serve(kolab);
  const fay = await signIn(base, await kolab.openSession('fay', 'product', { kolab: 'shop' }));
  const gus = await signIn(base, await kolab.openSession('gus', 'engineer', { kolab: 'shop' }));

  expect(await gus('access')).toMatchObject({ status: 403, body: { error: 'forbidden', message: expect.stringMatching(/for those with Admin there; you hold Write on both layers/) } });
  expect((await gus('access/fay/remove', {})).status).toBe(403);
  // A change from another origin, or with none, never reaches Kolab.
  expect((await fay('access/gus/remove', {}, { origin: 'http://evil.example' })).status).toBe(403);
  expect((await fay('access/gus', { level: 'read' }, { origin: null })).status).toBe(403);
  expect(await kolab.access('gus', 'shop')).toStrictEqual({ level: 'write', layers: ['functional', 'technical'] });

  expect(await fay('access/fay/remove', {})).toMatchObject({ status: 403, body: { message: expect.stringMatching(/nobody holding Admin/) } });
  expect(await fay('access/gus', { level: 'admin' })).toMatchObject({ status: 403, body: { message: expect.stringMatching(/Admin in kolab shop is given by its owners/) } });
  expect((await fay('access/gus', { level: 'maintain' })).status).toBe(200);
  expect((await kolab.access('gus', 'shop')).level).toBe('maintain');
});
