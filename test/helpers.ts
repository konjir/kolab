import { Hub, type Reviewer } from '../src/hub.js';

export async function setup(reviewer?: Reviewer) {
  const hub = await Hub.open({ reviewer });
  await hub.addActor('alice');   // product owner
  await hub.addActor('bob');     // engineer
  await hub.addActor('carol');   // holds both roles, one at a time
  const product = await hub.openSession('alice', 'product');
  const engineer = await hub.openSession('bob', 'engineer');
  return { hub, product, engineer };
}

export const els = (pairs: Record<string, string>, parents: Record<string, string> = {}) =>
  Object.entries(pairs).map(([id, text]) => ({ id, text, parent: parents[id] }));

/** Open marks on any version of one node. */
export async function marksOn(hub: Hub, nodeId: string) {
  const ids = new Set((await hub.db.query<{ id: string }>(`select id from version where node_id = $1`, [nodeId])).rows.map((r) => r.id));
  return (await hub.openMarks()).filter((m) => ids.has(m.version_id));
}

export async function textOf(hub: Hub, nodeId: string) {
  const v = (await hub.latestCommitted(nodeId))!;
  return Object.fromEntries((await hub.elements(v.id)).map((e) => [e.element_id, e.text]));
}
