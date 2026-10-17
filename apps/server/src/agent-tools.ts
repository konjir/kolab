import { Inject, Injectable } from '@nestjs/common';
import { McpTool, type McpToolContext } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { Kolab } from '@konjir/engine';
import { formatAddress, parseAddress, parseNodeRef } from '@konjir/address';
import { DELTA_KINDS, EDGE_KINDS, FINDING_KINDS, KINDS, OVERRIDE_RESOLUTIONS, QUERY_KINDS, QUERY_STATES, REVIEW_VERDICTS, type EdgeKind, type GateResult } from '@konjir/types';
import { asAgent, thread } from './results.js';
import { KOLAB } from './tokens.js';
import { answersUri, inboxUri } from './uris.js';

const address = z.string().describe('A Konjir address, e.g. kj:checkout@3#R1 or kj:checkout#R1~q({"exact":"30 seconds"}): the short form, a node in your kolab. kj:<kolab>/<node>… names the kolab too (kj:shop/checkout@3#R1). Omit @version to use the latest committed version.');
const node = z.string().describe('A node in your kolab, by name (checkout), or <kolab>/<node>.');
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
const readNode = z.object({
  node: z.string().describe('A node by name: one in your kolab (checkout), or <kolab>/<node> in any kolab you can read.'),
  version: z.number().int().optional(),
});
const lineage = z.object({
  node,
  direction: z.enum(['upstream', 'downstream']).describe('Required. upstream = what this node relies on; downstream = what relies on it.'),
});
const listStale = z.object({ all_layers: z.boolean().optional(), node: node.optional() });
const listQueries = z.object({
  mine: z.boolean().optional().describe('Questions and notes you raised, open and answered'),
  all_layers: z.boolean().optional(),
  state: z.enum(QUERY_STATES).optional(),
  kind: z.enum(QUERY_KINDS).optional(),
  node: node.optional().describe('Only those raised on this node of your kolab'),
});
const createNode = z.object({ kind: z.enum(KINDS), title: z.string(), id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional().describe('Readable stable name, unique in your kolab, e.g. checkout: its address is kj:checkout, or kj:<kolab>/checkout from anywhere. Defaults to a ULID.') });
const draft = z.object({
  node,
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
const submit = z.object({ node, version: z.number().int() });
const review = z.object({
  node,
  version: z.number().int(),
  verdict: z.enum(REVIEW_VERDICTS).describe('approve commits the version (one approval is enough); request_changes returns it to its author as a draft'),
  note: z.string().optional().describe('What you checked, or what must change. Required with request_changes.'),
  findings: z.array(z.object({
    kind: z.enum(FINDING_KINDS).describe('contradiction: two elements that cannot both hold, or an element that makes what it links to impossible (blocks the commit). layer_leak: implementation in a functional spec, or a binding that changes behavior (commits, and raises a question to the layer that owns the answer).'),
    elements: z.array(z.string()).min(1).describe('The element IDs involved, from this version'),
    explanation: z.string().describe('One or two sentences the author can act on'),
  })).optional(),
});
const abandon = z.object({ node, version: z.number().int() });
const listReviews = z.object({});
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
    return asAgent(context, async (s) => (await this.kolab.listNodes(kind, await this.kolab.sessionKolab(s)))
      .map(({ name, kind: k, layer, title, latest, drafts, in_review }) => ({ id: name, kind: k, layer, title, latest, drafts, in_review })));
  }

  @McpTool({
    name: 'konjir_resolve',
    description: 'Resolve an address to its current content: kj:<node>… in your kolab, or kj:<kolab>/<node>… in any kolab you can read. Use this instead of caching spec text. Status is ok, fuzzy or orphan. For a quoted span: ok means the exact words, with the prefix or suffix you quoted still around them (or no prefix or suffix was quoted). fuzzy means the span changed: either its wording was edited, or the exact words now appear only without their quoted context, such as a copy in another statement. Both kinds of fuzzy mark whatever links to the span (fuzzy_reanchor). orphan means it is gone.',
    schema: resolve,
    annotations: { readOnlyHint: true },
  })
  resolve({ address: a }: z.infer<typeof resolve>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const r = await this.kolab.resolve(a, { session: s });
      const v = r.versionId ? await this.kolab.version(r.versionId) : undefined;
      return { address: a, status: r.status, version: v?.seq ?? null, content: 'content' in r ? r.content : null };
    });
  }

  @McpTool({
    name: 'konjir_read_node',
    description: 'Read every element of a node version, with who wrote it, each with its address and the questions and notes raised on it (open and answered, from any version). Defaults to the latest committed version. The node is one of your kolab\'s, or <kolab>/<node> in any kolab you can read.',
    schema: readNode,
    annotations: { readOnlyHint: true },
  })
  readNode({ node, version }: z.infer<typeof readNode>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const kolab = this.kolab;
      // As kj_agent: row-level security bounds the read as well as Kolab (0008). Only who wrote
      // the version comes from Kolab's login, since kj_agent reads no actors.
      const { node: n, version: row, from: here, elements: els, queries } = await kolab.readNode(s, node, version);
      const threads = new Map<string | null, ReturnType<typeof thread>[]>();
      for (const q of queries) {
        const el = parseAddress(q.address).element ?? null;
        (threads.get(el) ?? threads.set(el, []).get(el)!).push(thread(q));
      }
      const at = (element?: string) => formatAddress({ kolab: n.kolab_id, node: n.name, version: row.seq, element }, { from: here });
      return {
        node: n.kolab_id === here ? n.name : `${n.kolab_id}/${n.name}`, version: row.seq, state: row.state, versionId: row.id, author: await kolab.author(row.id),
        ...(threads.get(null) ? { questions: threads.get(null) } : {}),
        elements: els.map((e) => ({
          address: at(e.element_id), id: e.element_id, parent: e.parent_element_id, text: e.text,
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
      const n = await this.kolab.nodeIn(s, node, 'walking lineage');
      const v = await this.kolab.latestCommitted(n.id);
      if (!v) throw new Error(`${n.name} has no committed version`);
      return { node: n.name, version: v.seq, direction, edges: await this.kolab.lineage(v.id, direction) };
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
      const id = node === undefined ? undefined : (await this.kolab.nodeIn(s, node, 'listing marks')).id;
      return { marks: await this.kolab.describeMarks({ layer: all_layers ? undefined : me.layer, node: id, kolab: me.kolab }) };
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
      const id = node === undefined ? undefined : (await this.kolab.nodeIn(s, node, 'listing questions')).id;
      if (mine) return { queries: await this.kolab.listQueries({ raisedBy: me.actor, state, kind, node: id, kolab: me.kolab }) };
      return { queries: await this.kolab.listQueries({ layer: all_layers ? undefined : me.layer, state: state ?? 'open', kind, node: id, kolab: me.kolab }) };
    });
  }

  // ---- write ---------------------------------------------------------------

  @McpTool({
    name: 'konjir_create_node',
    description: 'Create a node in your kolab. Its kind fixes its layer: functional_spec and prototype are functional; the rest are technical. Its name (id) is unique in your kolab; other kolabs may use the same one.',
    schema: createNode,
    annotations: { readOnlyHint: false, idempotentHint: false },
  })
  createNode({ kind, title, id }: z.infer<typeof createNode>, context?: McpToolContext) {
    return asAgent(context, async (s) => ({ node: (await this.kolab.node(await this.kolab.createNode(s, kind, title, id))).name }));
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
      const n = await kolab.nodeIn(s, a.node, 'drafting');
      const parent = a.parent ? (await kolab.versionIn(s, a.parent, { what: 'a variant (a fork)' })).id : undefined;
      const id = await kolab.draft(s, n.id, { elements: a.elements, deltas: a.deltas, parent });
      const v = await kolab.version(id);
      const linked: string[] = [];
      for (const l of a.links ?? []) {
        const el = l.source_element ?? l.element!;
        await linkOne(kolab, s, { kind: l.kind ?? 'dependency', source: `kj:${n.name}@${v.seq}#${el}`, target: l.target });
        linked.push(`${el} -> ${l.target}`);
      }
      return { node: n.name, version: v.seq, versionId: id, state: v.state, linked, next: `konjir_submit_for_review node=${n.name} version=${v.seq}` };
    });
  }

  @McpTool({
    name: 'konjir_submit_for_review',
    description: 'Submit a draft. Kolab runs its structural checks; if they fail, the draft stays drafted, with the reason. If they pass, the version goes into review, with a review request in the inbox of each other actor who holds Write on its layer, and commits once one approves (konjir_review). If no one else holds Write on the layer, the checks alone commit it, and it is recorded as unreviewed; a plan or work-package version always commits on the checks alone. The result names the version that committed or waits (a stale draft may be folded into a rebase). Resubmit a draft that came back with changes requested the same way; resubmitting a version still in review asks whoever can review it now, and commits it unreviewed if no one can.',
    schema: submit,
  })
  submitForReview({ node, version }: z.infer<typeof submit>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const kolab = this.kolab;
      const draft = await kolab.versionIn(s, { ...parseNodeRef(node), version }, { allowDraft: true, what: 'submitting' });
      return this.outcome(s, await kolab.node(draft.node_id), await kolab.submit(s, draft.id), version);
    });
  }

  @McpTool({
    name: 'konjir_review',
    description: 'Record your verdict on a version in review that you did not write, on your own layer: approve, or request_changes with a note and findings. Review requests for you are in your inbox (konjir_list_reviews). Read the version first with konjir_read_node. Report a contradiction (two elements that cannot both hold, or a binding element that conflicts with a requirement it links to: stricter, looser or different) only with request_changes. A layer_leak is content in the wrong layer that conflicts with nothing (implementation in a spec, or behavior a binding adds that its linked requirements don\'t mention); it can come with approve: the version commits and a question goes to the layer that owns the answer. Anything that conflicts is a contradiction. Send compound requirements back to be split. The konjir_reviewer_instructions prompt has the full checklist.',
    schema: review,
  })
  review(a: z.infer<typeof review>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      if (a.verdict === 'request_changes' && !a.note?.trim()) throw new Error('say what must change: request_changes needs a note');
      const v = await this.kolab.versionIn(s, { ...parseNodeRef(a.node), version: a.version }, { allowDraft: true, what: 'reviewing' });
      const r = await this.kolab.recordReview(s, v.id, { verdict: a.verdict, note: a.note, findings: a.findings });
      if (a.verdict === 'request_changes') {
        return { verdict: a.verdict, state: 'drafted', review: r.note ?? null, next: 'Returned to its author as a draft; nothing more to do.' };
      }
      return { verdict: a.verdict, ...(await this.outcome(s, await this.kolab.node(v.node_id), r)) };
    });
  }

  @McpTool({
    name: 'konjir_abandon',
    description: 'Abandon a draft or a version in review that you wrote: it is rejected, and its review requests are withdrawn. Refused, saying why, if the version was already committed or rejected.',
    schema: abandon,
  })
  abandon({ node, version }: z.infer<typeof abandon>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const v = await this.kolab.versionIn(s, { ...parseNodeRef(node), version }, { allowDraft: true, what: 'abandoning' });
      const state = await this.kolab.abandon(s, v.id);
      return { abandoned: `kj:${(await this.kolab.node(v.node_id)).name}@${version}`, state };
    });
  }

  @McpTool({
    name: 'konjir_list_reviews',
    description: 'Review requests waiting for you, each with its subject and how to review it; and your own submissions, with the verdicts they got.',
    schema: listReviews,
    annotations: { readOnlyHint: true },
  })
  listReviews(_: z.infer<typeof listReviews>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      const kolab = await this.kolab.sessionKolab(s);
      return { for_you: await this.kolab.reviewRequests({ reviewer: me.actor, kolab }), yours: await this.kolab.submissions(me.actor, { kolab }) };
    });
  }

  /** What a submission or an approval came to, and what to do next. */
  private async outcome(session: string, n: { id: string; name: string }, r: GateResult, submitted?: number) {
    const kolab = this.kolab;
    const node = n.name;
    const v = await kolab.version(r.version);
    const at = `kj:${node}@${v.seq}`;
    return {
      ok: r.ok, review: r.note ?? null, committed: r.ok ? at : null, stale: r.stale ?? false,
      in_review: r.in_review ? at : null, ...(r.reviewers ? { reviewers: r.reviewers } : {}), unreviewed: r.unreviewed ?? false,
      ...(r.cascade ? { cascade: r.cascade } : {}),
      stale_after_commit: r.ok ? await kolab.describeMarks({ node: n.id, kolab: await kolab.sessionKolab(session) }) : [],
      next: r.ok ? `Committed${r.unreviewed ? ', unreviewed: no one else holds Write on this layer' : ''}.${r.cascade ? ' Its cascade (marks downstream, variants rebased) is queued behind an earlier one of this node and runs once that one is done.' : ''} Others can now link to it; check konjir_list_stale.`
        : r.in_review ? `In review: ${r.reviewers?.length ? `${r.reviewers.join(', ')} each have a review request in their inbox, and ` : ''}one approval commits it. Carry on; the verdict comes back in your answers (konjir_list_reviews).`
        : r.stale ? `Stale: someone else committed to ${node} after this was drafted. Nothing was wrong with the draft. Re-read the node with konjir_read_node and redraft on its current version.`
        : `Not committed: the checks found what the review names. The draft stays yours, drafted: draft a new version that fixes it (and konjir_abandon node=${node} version=${submitted ?? v.seq}), or resubmit it if the finding was wrong.`,
    };
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
      return {
        ok: r.verdict.ok, note: r.verdict.note ?? null, in_review: r.verdict.in_review ?? false,
        ...(r.verdict.in_review ? { next: 'The resolution waits in review; the mark settles, and precedent is set, when it commits.' } : {}),
      };
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
  // Both ends in the session's kolab: a link across kolabs (LNK8) waits on a binding decision.
  return kolab.link(session, {
    kind: a.kind,
    source: (await kolab.versionIn(session, src, { allowDraft: true, what: 'linking' })).id, sourceElement: a.source_element ?? src.element,
    target: (await kolab.versionIn(session, tgt, { what: 'linking' })).id, targetElement: tgt.element, selector: tgt.selector,
  });
}
