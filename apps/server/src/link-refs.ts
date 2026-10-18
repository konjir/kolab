import * as z from 'zod/v4';
import { EDGE_KINDS, type LinkRef } from '@konjir/types';

/** A link to remove (LNK6, D48), as konjir_draft's and konjir_admin_apply_ruling's `unlink` and konjir_unlink take it. */
export const linkRef = z.object({
  link: z.string().optional().describe('The link\'s id, as konjir_lineage (edge) and konjir_list_stale (link) give it'),
  source_element: z.string().optional().describe('Or name it by what it links: your element it links from (omit for a link from the whole version)'),
  target: z.string().optional().describe('…and the address it links to, e.g. kj:checkout#R1 (any version; a quote with ~q(…) if the link quotes one)'),
  kind: z.enum(EDGE_KINDS).optional().describe('Only links of this kind; without it, links of every kind between the two go'),
});

/** One schema entry as the engine takes it: exactly one of `link`, or `target` with its source element. */
export function toLinkRef(r: z.infer<typeof linkRef>): LinkRef {
  if (r.link !== undefined) {
    if (r.target !== undefined || r.source_element !== undefined) throw new Error('name a link by its id (link) or by what it links (source_element and target), not both');
    return { link: r.link };
  }
  if (r.target === undefined) throw new Error('name each link to remove by its id (link), or by its target (target, with source_element)');
  return { sourceElement: r.source_element, target: r.target, kind: r.kind };
}
