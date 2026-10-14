import type { Reviewer } from '@konjir/types';
import { Kolab } from './kolab.js';

export async function setup(reviewer?: Reviewer) {
  const kolab = await Kolab.open({ reviewer });
  await kolab.addActor('alice');   // product owner
  await kolab.addActor('bob');     // engineer
  await kolab.addActor('carol');   // holds both roles, one at a time
  const product = await kolab.openSession('alice', 'product');
  const engineer = await kolab.openSession('bob', 'engineer');
  return { kolab, product, engineer };
}

export const els = (pairs: Record<string, string>, parents: Record<string, string> = {}) =>
  Object.entries(pairs).map(([id, text]) => ({ id, text, parent: parents[id] }));

/** Open marks on any version of one node. */
export async function marksOn(kolab: Kolab, nodeId: string) {
  const ids = new Set((await kolab.db.query<{ id: string }>(`select id from version where node_id = $1`, [nodeId])).rows.map((r) => r.id));
  return (await kolab.openMarks()).filter((m) => ids.has(m.version_id));
}

export async function textOf(kolab: Kolab, nodeId: string) {
  const v = (await kolab.latestCommitted(nodeId))!;
  return Object.fromEntries((await kolab.elements(v.id)).map((e) => [e.element_id, e.text]));
}
