import { Inject, Injectable } from '@nestjs/common';
import { McpTool, type McpToolContext } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { GateError, Kolab } from '@konjir/engine';
import { parseAddress } from '@konjir/address';
import { DELTA_KINDS, EDGE_KINDS, KINDS, OVERRIDE_RESOLUTIONS, QUERY_KINDS, QUERY_STATES, type EdgeKind } from '@konjir/types';
import { asAgent, thread } from './results.js';
import { KOLAB } from './tokens.js';
import { answersUri, inboxUri } from './uris.js';

const address = z.string().describe('A Konjir address, e.g. kj:checkout@3#R1 or kj:checkout#R1~q({"exact":"30 seconds"}). Omit @version to use the latest committed version.');
const elementInput = z.object({
  id: z.string().optional().describe('Stable element ID. Reuse the existing ID when editing an element; omit only for a brand-new element.'),
  text: z.string(),
  parent: z.string().optional().describe('ID of the containing element (e.g. a section).'),
});
const deltaInput = z.object({
  kind: z.enum(DELTA_KINDS),
  element: z.string(),
  text: z.string().optional(),
  parent: z.string().optional(),
});
const from = address.optional().describe('Your own element that waits on this, e.g. kj:checkout-pg@1#b3 (drafts allowed). When the question is answered, that element gets a query_answered mark.');

const listNodes = z.object({ kind: z.enum(KINDS).optional() });
const resolve = z.object({ address });
const readNode = z.object({ node: z.string(), version: z.number().int().optional() });
const lineage = z.object({
  node: z.string(),
  direction: z.enum(['upstream', 'downstream']).describe('Required. upstream = what this node relies on; downstream = what relies on it.'),
});
const listStale = z.object({ all_layers: z.boolean().optional(), node: z.string().optional() });
const listQueries = z.object({
  mine: z.boolean().optional().describe('Questions and notes you raised, open and answered'),
  all_layers: z.boolean().optional(),
  state: z.enum(QUERY_STATES).optional(),
  kind: z.enum(QUERY_KINDS).optional(),
  node: z.string().optional().describe('Only those raised on this node'),
});
const createNode = z.object({ kind: z.enum(KINDS), title: z.string(), id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional().describe('Readable stable ID, e.g. checkout. Defaults to a ULID.') });
const draft = z.object({
  node: z.string(),
  elements: z.array(elementInput).optional(),
  deltas: z.array(deltaInput).optional(),
  parent: address.optional().describe('For a new variant: the parent spec version to inherit from, e.g. kj:storefront@2.'),
  links: z.array(z.object({
    source_element: z.string().optional().describe('Your element in this draft (same name as on konjir_link)'),
    element: z.string().optional().describe('Alias for source_element'),
    target: address.describe('What it relies on (committed)'),
    kind: z.enum(EDGE_KINDS).optional().describe('Defaults to dependency'),
  })).optional().describe('Links to declare from this draft\'s elements, in the same call: [{"source_element":"b1","target":"kj:spec#R1"}]. Links on earlier versions carry forward automatically.'),
});
const submit = z.object({ node: z.string(), version: z.number().int() });
const link = z.object({
  kind: z.enum(EDGE_KINDS).describe('dependency = relies on; derivation = generated from; equivalence = must stay in sync'),
  source: address.describe('Your element, e.g. kj:checkout-pg@2#b1 (drafts allowed).'),
  source_element: z.string().optional().describe('Alternative to putting #element in source.'),
  target: address.describe('What it relies on; must be committed and resolve exactly. e.g. kj:checkout@3#R1, or a span: kj:checkout#R1~q({"exact":"30 seconds","prefix":"Checkout completes within","suffix":"of payment confirming"}). For a span, quote only the few words you rely on (at most 1,000 characters), and give several whole words either side as prefix and suffix, not one word: they must still surround the quote in the target.'),
});
const clearMark = z.object({ mark: z.string() });
const resolveOverride = z.object({ mark: z.string(), resolution: z.enum(OVERRIDE_RESOLUTIONS), text: z.string().optional() });
const ask = z.object({ address, question: z.string(), from });
const annotate = z.object({ address, note: z.string(), from: address.optional().describe('Your own element the note is about') });
const answerQuery = z.object({ query: z.string(), answer: z.string() });

/** The verbs an agent session uses. Role and gate rules are enforced by Kolab, not here: this layer only translates. */
@Injectable()
export class AgentTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  // ---- read ----------------------------------------------------------------

  @McpTool({
    name: 'konjir_whoami',
    description: 'Show the actor, role and layer your session token carries (an agent also names the account that owns it), the kolab it works in and your access there, and the inbox resources to subscribe to for pushed updates.',
    annotations: { readOnlyHint: true },
  })
  whoami(_: unknown, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      return { ...me, subscribe: [inboxUri(me.layer), answersUri(me.actor)] };
    });
  }

  @McpTool({
    name: 'konjir_list_nodes',
    description: 'List the specs, bindings, WBS, work packages and implementations in your kolab, with their latest committed version number.',
    schema: listNodes,
    annotations: { readOnlyHint: true },
  })
  listNodes({ kind }: z.infer<typeof listNodes>, context?: McpToolContext) {
    return asAgent(context, async (s) => this.kolab.listNodes(kind, await this.kolab.sessionKolab(s)));
  }

  @McpTool({
    name: 'konjir_resolve',
    description: 'Resolve an address to its current content. Use this instead of caching spec text. Status is ok, fuzzy or orphan. For a quoted span: ok means the exact words, with the prefix or suffix you quoted still around them (or no prefix or suffix was quoted). fuzzy means the span changed: either its wording was edited, or the exact words now appear only without their quoted context, such as a copy in another statement. Both kinds of fuzzy mark whatever links to the span (fuzzy_reanchor). orphan means it is gone.',
    schema: resolve,
    annotations: { readOnlyHint: true },
  })
  resolve({ address: a }: z.infer<typeof resolve>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      await this.kolab.requireNodeIn(s, parseAddress(a).node);
      const r = await this.kolab.resolve(a);
      const v = r.versionId ? await this.kolab.version(r.versionId) : undefined;
      return { address: a, status: r.status, version: v?.seq ?? null, content: 'content' in r ? r.content : null };
    });
  }

  @McpTool({
    name: 'konjir_read_node',
    description: 'Read every element of a node version, with who wrote it, each with its address and the questions and notes raised on it (open and answered, from any version). Defaults to the latest committed version.',
    schema: readNode,
    annotations: { readOnlyHint: true },
  })
  readNode({ node, version }: z.infer<typeof readNode>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const kolab = this.kolab;
      await kolab.requireNodeIn(s, node);
      const v = version === undefined
        ? await kolab.latestCommitted(node)
        : (await kolab.db.query<{ id: string }>(`select id from version where node_id = $1 and seq = $2`, [node, version])).rows[0];
      if (!v) throw new Error(`${node} has no ${version === undefined ? 'committed version' : `version ${version}`}`);
      const row = await kolab.version(v.id);
      const els = await kolab.elements(v.id);
      const threads = new Map<string | null, ReturnType<typeof thread>[]>();
      for (const q of await kolab.listQueries({ node })) {
        const el = parseAddress(q.address).element ?? null;
        (threads.get(el) ?? threads.set(el, []).get(el)!).push(thread(q));
      }
      return {
        node, version: row.seq, state: row.state, versionId: row.id, author: await kolab.author(row.id),
        ...(threads.get(null) ? { questions: threads.get(null) } : {}),
        elements: els.map((e) => ({
          address: `kj:${node}@${row.seq}#${e.element_id}`, id: e.element_id, parent: e.parent_element_id, text: e.text,
          ...(threads.get(e.element_id) ? { questions: threads.get(e.element_id) } : {}),
        })),
      };
    });
  }

  @McpTool({
    name: 'konjir_lineage',
    description: 'Walk lineage from a node version: upstream = what it depends on; downstream = what depends on it.',
    schema: lineage,
    annotations: { readOnlyHint: true },
  })
  lineage({ node, direction }: z.infer<typeof lineage>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      await this.kolab.requireNodeIn(s, node);
      const v = await this.kolab.latestCommitted(node);
      if (!v) throw new Error(`${node} has no committed version`);
      return { node, version: v.seq, direction, edges: await this.kolab.lineage(v.id, direction) };
    });
  }

  @McpTool({
    name: 'konjir_list_stale',
    description: 'List open dirty marks: what is dirty, why, and the next step. Defaults to your own layer.',
    schema: listStale,
    annotations: { readOnlyHint: true },
  })
  listStale({ all_layers, node }: z.infer<typeof listStale>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      return { marks: await this.kolab.describeMarks({ layer: all_layers ? undefined : me.layer, node, kolab: me.kolab }) };
    });
  }

  @McpTool({
    name: 'konjir_list_queries',
    description: 'List questions and notes. Default: open ones your layer owns the answer to. mine=true: the ones you raised, with their answers.',
    schema: listQueries,
    annotations: { readOnlyHint: true },
  })
  listQueries({ mine, all_layers, state, kind, node }: z.infer<typeof listQueries>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      if (mine) return { queries: await this.kolab.listQueries({ raisedBy: me.actor, state, kind, node, kolab: me.kolab }) };
      return { queries: await this.kolab.listQueries({ layer: all_layers ? undefined : me.layer, state: state ?? 'open', kind, node, kolab: me.kolab }) };
    });
  }

  // ---- write ---------------------------------------------------------------

  @McpTool({
    name: 'konjir_create_node',
    description: 'Create a node in your kolab. Its kind fixes its layer: functional_spec and prototype are functional; the rest are technical.',
    schema: createNode,
    annotations: { readOnlyHint: false, idempotentHint: false },
  })
  createNode({ kind, title, id }: z.infer<typeof createNode>, context?: McpToolContext) {
    return asAgent(context, async (s) => ({ node: await this.kolab.createNode(s, kind, title, id) }));
  }

  @McpTool({
    name: 'konjir_draft',
    description: 'Draft a new version. To change a few elements, send only deltas: [{"kind":"override","element":"R2","text":"new text"}], plus add/remove; everything else carries over, so you never need to copy the whole node. Or send the full element list and Kolab computes the delta. A draft is not truth until konjir_submit_for_review commits it.',
    schema: draft,
  })
  draft(a: z.infer<typeof draft>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const kolab = this.kolab;
      for (const l of a.links ?? []) {
        if (!l.source_element && !l.element) throw new Error(`each link needs source_element (the element in your draft); missing for target ${l.target}`);
      }
      if (!a.elements === !a.deltas) throw new Error('send exactly one of elements or deltas');
      const parent = a.parent ? await versionIdOf(kolab, s, a.parent) : undefined;
      const id = await kolab.draft(s, a.node, { elements: a.elements, deltas: a.deltas, parent });
      const v = await kolab.version(id);
      const linked: string[] = [];
      for (const l of a.links ?? []) {
        const el = l.source_element ?? l.element!;
        await linkOne(kolab, s, { kind: l.kind ?? 'dependency', source: `kj:${a.node}@${v.seq}#${el}`, target: l.target });
        linked.push(`${el} -> ${l.target}`);
      }
      return { node: a.node, version: v.seq, versionId: id, state: v.state, linked, next: `konjir_submit_for_review node=${a.node} version=${v.seq}` };
    });
  }

  @McpTool({
    name: 'konjir_submit_for_review',
    description: 'Run the review gate on a draft. On pass it commits and the cascade runs; the result names the version that committed (a stale draft may be folded into a rebase).',
    schema: submit,
  })
  submitForReview({ node, version }: z.infer<typeof submit>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const kolab = this.kolab;
      const id = await versionIdOf(kolab, s, `kj:${node}@${version}`, true);
      const r = await kolab.review(id);
      const v = await kolab.version(r.version);
      return {
        ok: r.ok, review: r.note ?? null, committed: r.ok ? `kj:${node}@${v.seq}` : null, stale: r.stale ?? false,
        stale_after_commit: r.ok ? await kolab.describeMarks({ node, kolab: await kolab.sessionKolab(s) }) : [],
        next: r.ok ? 'Committed. Others can now link to it; check konjir_list_stale.'
          : r.retryable ? `Not reviewed yet; the draft is intact. Resubmit with konjir_submit_for_review node=${node} version=${version} shortly.`
          : r.stale ? `Stale: someone else committed to ${node} after you drafted. Nothing was wrong with the draft. Re-read the node with konjir_read_node and redraft on its current version.`
          : 'Rejected. Fix what the review names and draft again.',
      };
    });
  }

  @McpTool({
    name: 'konjir_link',
    description: 'Declare that one of your elements relies on an address, so you are told when it changes. Name your element either in source (kj:checkout-pg@2#b1) or in source_element; a link without a source element makes your whole version, and everything downstream of it, dirty on any change. kind: dependency (usual), derivation (generated from it), equivalence (must stay in sync). Linking two elements of the same spec is allowed.',
    schema: link,
  })
  link(a: z.infer<typeof link>, context?: McpToolContext) {
    return asAgent(context, async (s) => ({ edge: await linkOne(this.kolab, s, a) }));
  }

  @McpTool({
    name: 'konjir_clear_mark',
    description: 'Clear a dirty mark on your layer after checking that your work still holds against the new upstream. Re-pins the dependency and clears what it caused.',
    schema: clearMark,
  })
  clearMark({ mark }: z.infer<typeof clearMark>, context?: McpToolContext) {
    return asAgent(context, async (s) => { await this.kolab.clear(s, mark); return { cleared: mark }; });
  }

  @McpTool({
    name: 'konjir_resolve_override',
    description: 'Resolve a stale or orphaned override in a variant spec: reaffirm (keep yours), adopt_parent (take the parent text), or amend (new text). Becomes precedent for the same situation elsewhere.',
    schema: resolveOverride,
  })
  resolveOverride({ mark, resolution, text }: z.infer<typeof resolveOverride>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      if (resolution === 'amend' && !text) throw new Error('amend needs text');
      const r = await this.kolab.resolveOverride(s, mark, resolution, text);
      return { ok: r.verdict.ok, note: r.verdict.note ?? null };
    });
  }

  @McpTool({
    name: 'konjir_ask',
    description: 'Ask a question about an address. It routes to the layer that owns the answer: ask a functional spec about intent, a binding about implementation choices. Quote the words you mean with ~q(...). Set from to the element you wrote pending the answer.',
    schema: ask,
  })
  ask(a: z.infer<typeof ask>, context?: McpToolContext) {
    return asAgent(context, async (s) => ({ query: await this.kolab.raiseQuery(s, a.address, a.question, { from: a.from }) }));
  }

  @McpTool({
    name: 'konjir_annotate',
    description: 'Leave a note on an address for the layer that owns it: an interpretation you are proceeding on, an assumption, a risk, or something you could not check. It blocks nothing. The owner sees it beside the element in konjir_read_node and in its konjir_list_queries, and can reply. If you need a decision before you can proceed, use konjir_ask instead.',
    schema: annotate,
  })
  annotate(a: z.infer<typeof annotate>, context?: McpToolContext) {
    return asAgent(context, async (s) => ({ note: await this.kolab.raiseQuery(s, a.address, a.note, { kind: 'note', from: a.from }) }));
  }

  @McpTool({
    name: 'konjir_answer_query',
    description: 'Answer an open question, or reply to a note, that your layer owns. If the answer settles or changes intent, also amend the spec element: the answer reaches only the asker, the amendment reaches everyone who depends on it.',
    schema: answerQuery,
  })
  answerQuery({ query, answer }: z.infer<typeof answerQuery>, context?: McpToolContext) {
    return asAgent(context, async (s) => { await this.kolab.answerQuery(s, query, answer); return { answered: query }; });
  }
}

async function linkOne(kolab: Kolab, session: string,
  a: { kind: EdgeKind; source: string; source_element?: string; target: string }) {
  const src = parseAddress(a.source);
  const tgt = parseAddress(a.target);
  if (src.element && a.source_element && src.element !== a.source_element) {
    throw new Error(`source names element ${src.element} but source_element is ${a.source_element}; give one`);
  }
  return kolab.link(session, {
    kind: a.kind,
    source: await versionIdOf(kolab, session, a.source, true), sourceElement: a.source_element ?? src.element,
    target: await versionIdOf(kolab, session, a.target), targetElement: tgt.element, selector: tgt.selector,
  });
}

/** The version an address names, in the session's kolab only (TEN12). */
async function versionIdOf(kolab: Kolab, session: string, addr: string, allowDraft = false): Promise<string> {
  const a = parseAddress(addr);
  await kolab.requireNodeIn(session, a.node);
  if (a.version === undefined) {
    const v = await kolab.latestCommitted(a.node);
    if (!v) throw new Error(`${a.node} has no committed version`);
    return v.id;
  }
  const r = (await kolab.db.query<{ id: string; state: string }>(`select id, state from version where node_id = $1 and seq = $2`, [a.node, a.version])).rows[0];
  if (!r) throw new Error(`${a.node} has no version ${a.version}`);
  if (!allowDraft && r.state !== 'committed') throw new GateError(`kj:${a.node}@${a.version} is ${r.state}, not committed`);
  return r.id;
}
