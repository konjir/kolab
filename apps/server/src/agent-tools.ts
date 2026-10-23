import { Inject, Injectable } from '@nestjs/common';
import { McpTool, type McpToolContext } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { Kolab, LimitError, cursorFor, keyOf } from '@konjir/engine';
import { formatAddress, parseAddress, parseNodeRef } from '@konjir/address';
import {
  CASE_FILE_STATES, DELTA_KINDS, EDGE_KINDS, FINDING_KINDS, KINDS, MAX_ASKS_PER_HOUR, MAX_DRAFTS_PER_HOUR, MAX_ORG_ASKS_PER_HOUR, MAX_ORG_DRAFTS_PER_HOUR, MAX_ELEMENT_TEXT, MAX_ELEMENTS, MAX_TEXT, MAX_VERSION_BYTES, OVERRIDE_RESOLUTIONS,
  POSITION_VERDICTS, QUERY_KINDS, QUERY_STATES, READ_NODE_PAGE, REVIEW_VERDICTS, RULING_EFFECTS, THREADS_PER_ELEMENT, type EdgeKind, type GateResult,
  nobodyCanReview,
} from '@konjir/types';
import { linkRef, toLinkRef } from './link-refs.js';
import { PAGED, paging } from './paging.js';
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

const listNodes = z.object({ kind: z.enum(KINDS).optional(), ...paging });
const resolve = z.object({ address });
const readNode = z.object({
  node: z.string().describe('A node by name: one in your kolab (checkout), or <kolab>/<node> in any kolab you can read.'),
  version: z.number().int().optional(),
  cursor: z.string().optional().describe(`A version holds at most ${MAX_ELEMENTS} elements, read ${READ_NODE_PAGE} at a time: pass the next a read returned for the elements after them. Omit it for the first.`),
});
const lineage = z.object({
  node,
  direction: z.enum(['upstream', 'downstream']).describe('Required. upstream = what this node relies on; downstream = what relies on it.'),
  ...paging,
});
const listStale = z.object({ all_layers: z.boolean().optional(), node: node.optional(), ...paging });
const listQueries = z.object({
  mine: z.boolean().optional().describe('Questions and notes you raised, open and answered'),
  all_layers: z.boolean().optional(),
  state: z.enum(QUERY_STATES).optional(),
  kind: z.enum(QUERY_KINDS).optional(),
  node: node.optional().describe('Only those raised on this node of your kolab'),
  ...paging,
});
const createNode = z.object({ kind: z.enum(KINDS), title: z.string(), id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional().describe('Readable stable name, unique in your kolab, e.g. checkout: its address is kj:checkout, or kj:<kolab>/checkout from anywhere. Defaults to a ULID.') });
const draft = z.object({
  node,
  elements: z.array(elementInput).optional(),
  deltas: z.array(deltaInput).optional(),
  parent: address.optional().describe('For a new variant: the parent spec version to inherit from, e.g. kj:storefront@2, or kj:<kolab>/<node>@2 to fork a committed version of another kolab you can read.'),
  links: z.array(z.object({
    source_element: z.string().optional().describe('Your element in this draft (same name as on konjir_link)'),
    element: z.string().optional().describe('Alias for source_element'),
    target: address.describe('What it relies on (committed): in your kolab, or kj:<kolab>/<node>… in another kolab you can read'),
    kind: z.enum(EDGE_KINDS).optional().describe('Defaults to dependency'),
  })).optional().describe('Links to declare from this draft\'s elements, in the same call: [{"source_element":"b1","target":"kj:spec#R1"}]. Links on earlier versions carry forward automatically.'),
  unlink: z.array(linkRef).optional().describe('Links of the version this draft is built on that it drops, so its commit doesn\'t carry them forward: [{"source_element":"b1","target":"kj:spec#R1"}] or [{"link":"<id>"}]. Removing a link settles its open mark when the version commits; it is reviewed with the rest of the draft.'),
});
const unlink = z.object({
  node,
  version: z.number().int().describe('Your draft of the node: the removal is part of it, reviewed with it'),
  links: z.array(linkRef).min(1).describe('The links to remove: [{"link":"<id>"}], or [{"source_element":"b1","target":"kj:spec#R1"}]'),
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
const listReviews = z.object({ ...paging });
const link = z.object({
  kind: z.enum(EDGE_KINDS).describe('dependency = relies on; derivation = generated from; equivalence = must stay in sync'),
  source: address.describe('Your element, e.g. kj:checkout-pg@2#b1 (drafts allowed).'),
  source_element: z.string().optional().describe('Alternative to putting #element in source.'),
  target: address.describe('What it relies on; must be committed and resolve exactly. e.g. kj:checkout@3#R1, or kj:<kolab>/<node>… in another kolab you can read (the link rests on your Read there, and is marked access_lost if that goes), or a span: kj:checkout#R1~q({"exact":"30 seconds","prefix":"Checkout completes within","suffix":"of payment confirming"}). For a span, quote only the few words you rely on (at most 1,000 characters), and give several whole words either side as prefix and suffix, not one word: they must still surround the quote in the target.'),
});
const clearMark = z.object({ mark: z.string() });
const resolveOverride = z.object({ mark: z.string(), resolution: z.enum(OVERRIDE_RESOLUTIONS), text: z.string().optional() });
const ask = z.object({ address, question: z.string().describe(`At most ${MAX_TEXT} characters`), from });
const annotate = z.object({ address, note: z.string().describe(`At most ${MAX_TEXT} characters`), from: address.optional().describe('Your own element the note is about') });
const answerQuery = z.object({ query: z.string(), answer: z.string().describe(`At most ${MAX_TEXT} characters`) });
const evidence = z.array(z.string()).min(1).describe('What backs the claim: kj: addresses (each must resolve), and anything else as text, such as a commit, a file and line, or a test run. At least one.');
const openCase = z.object({
  address: address.describe('The element in dispute, e.g. kj:checkout#R1, on a committed version in your kolab'),
  question: z.string().describe('What the two sides disagree on, in one sentence'),
  claim: z.string().describe('Your position'),
  seeks: z.enum(RULING_EFFECTS).describe('The side your position takes: keep_intent (the element stands as written) or change_intent (it must change). The other side takes the opposite.'),
  evidence,
});
const addPosition = z.object({ case: z.string().describe('The case file\'s id'), claim: z.string().describe('Your position: the other side, which seeks the opposite of the opener\'s'), evidence });
const rule = z.object({
  case: z.string().optional().describe('The case file to rule on. Omit it, and give address, to rule directly.'),
  address: address.optional().describe('For a ruling with no case file behind it: the element or node it rules on, e.g. kj:checkout#R1'),
  text: z.string().describe('The ruling, as agents will be served it as precedent'),
  effect: z.enum(RULING_EFFECTS).optional().describe('Required for a direct ruling. change_intent: the intent changes, and the element is marked until it is amended. keep_intent: the intent stands; find another way to meet it as written. On a case file it is the side of the position you sustain, and may be left out.'),
  verdicts: z.record(z.string(), z.enum(POSITION_VERDICTS)).optional().describe('With case: each position\'s verdict, by position id, sustaining exactly one: {"<position>":"sustained","<position>":"overruled"}'),
  replaces: z.string().optional().describe('What this ruling overrules, in words, if anything'),
});
const listCases = z.object({
  state: z.enum(CASE_FILE_STATES).optional().describe('Default: open ones'),
  mine: z.boolean().optional().describe('Case files you opened or hold a position on, open and ruled'),
  all_layers: z.boolean().optional(),
  node: node.optional().describe('Only those about this node of your kolab'),
  ...paging,
});
const readCase = z.object({ case: z.string() });
const listRulings = z.object({ node: node.optional().describe('Only rulings on this node of your kolab'), ...paging });
const createAgent = z.object({ label: z.string().describe('The agent\'s label: up to 24 lowercase letters, digits and \'-\'. The agent is named <you>-<label>, e.g. ann-product.') });

/** The verbs an agent session uses. Role and gate rules are enforced by Kolab, not here: this layer only translates. */
@Injectable()
export class AgentTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  // ---- read ----------------------------------------------------------------

  @McpTool({
    name: 'konjir_whoami',
    description: 'Show the actor, role and layer your session token carries (an agent also names the account that owns it), the kolab it works in and your access there, and the resources to subscribe to for pushed updates: your layer\'s inbox and your answers, both in that kolab. A session can subscribe only to its own kolab\'s. session is the session\'s key, the sha256 of its token: Kolab never shows the token again after it is issued.',
    annotations: { readOnlyHint: true },
  })
  whoami(_: unknown, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      // A Konjir admin's own session says so, and whether it is raised to run the admin verbs (W2.22).
      const scopes = context?.authInfo?.scopes ?? [];
      // No hint how to raise it: only its person's browser can (Lee's ruling of 2026-10-23).
      const admin = scopes.includes('konjir-admin') ? { konjir_admin: { raised: scopes.includes('admin') } } : {};
      return { ...me, ...admin, subscribe: [inboxUri(me.kolab, me.layer), answersUri(me.kolab, me.actor)] };
    });
  }

  @McpTool({
    name: 'konjir_list_nodes',
    description: `List the specs, bindings, WBS, work packages and implementations in your kolab, with their latest committed version number. rebase_pending says a variant\'s rebase onto its parent\'s newer version is queued: Kolab rebases variants after their parent commits, in the background. rebase_dead says it kept failing and Kolab stopped trying: the variant has a rebase_failed mark, and its next commit or its parent\'s tries again. By kind, then name.${PAGED}`,
    schema: listNodes,
    annotations: { readOnlyHint: true },
  })
  listNodes({ kind, cursor, limit }: z.infer<typeof listNodes>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const { items, next } = await this.kolab.nodesPage(await this.kolab.sessionKolab(s), kind, { cursor, limit });
      return {
        nodes: items.map(({ name, kind: k, layer, title, latest, drafts, in_review, rebase_pending, rebase_dead }) => ({
          id: name, kind: k, layer, title, latest, drafts, in_review, ...(rebase_pending ? { rebase_pending } : {}), ...(rebase_dead ? { rebase_dead } : {}),
        })),
        next,
      };
    });
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
    description: `Read the elements of a node version, with who wrote it and who made the node, each with its address, the questions and notes raised on it (open and answered, from any version: the newest ${THREADS_PER_ELEMENT}, with more_questions counting the rest), the rulings on it, which are precedent, and its open case files. Defaults to the latest committed version. The node is one of your kolab\'s, or <kolab>/<node> in any kolab you can read. For a variant of your kolab whose parent committed a newer version, rebase says its rebase is queued: Kolab rebases it in the background, and a new version of it appears once that is done. A version holds at most ${MAX_ELEMENTS} elements; a read returns ${READ_NODE_PAGE} of them at a time, in order, and next is null once it has returned the last. While next isn't null, read again with cursor=next for the rest.`,
    schema: readNode,
    annotations: { readOnlyHint: true },
  })
  readNode({ node, version, cursor }: z.infer<typeof readNode>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const kolab = this.kolab;
      // As kj_agent: row-level security bounds the read as well as Kolab (0008). Only who wrote
      // the version comes from Kolab's login, since kj_agent reads no actors.
      // A page of its elements (W2.21): a version never changes, so where a page starts is a count.
      // The cursor names the version it pages, checked once the version is known.
      let start = 0;
      if (cursor) {
        const parsed = (() => { try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown; } catch { return undefined; } })();
        const n = Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && parsed[0].startsWith('read_node:') ? parsed[1] : undefined;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new LimitError('invalid cursor: that isn\'t one this read gave. Pass the next it returned, unchanged, or leave cursor out to start again');
        start = n;
      }
      // Only the page's questions, the newest THREADS_PER_ELEMENT on each of its elements, read in SQL.
      const read = await kolab.readNode(s, node, version, { threads: { per: THREADS_PER_ELEMENT, from: start, count: READ_NODE_PAGE } });
      const { node: n, version: row, from: here, elements: all, queries, query_counts: counts, removes, rulings, cases, rebase } = read;
      keyOf(`read_node:${row.id}`, cursor, ['int']);
      const els = all.slice(start, start + READ_NODE_PAGE);
      const next = start + READ_NODE_PAGE < all.length ? cursorFor(`read_node:${row.id}`, [start + READ_NODE_PAGE]) : null;
      const threads = new Map<string | null, ReturnType<typeof thread>[]>();
      for (const q of queries) {
        const el = parseAddress(q.address).element ?? null;
        (threads.get(el) ?? threads.set(el, []).get(el)!).push(thread(q));
      }
      const shown = (el: string | null) => {
        const t = threads.get(el);
        if (!t) return {};
        const more = (counts?.get(el ?? '') ?? t.length) - t.length;
        return { questions: t, ...(more > 0 ? { more_questions: more } : {}) };
      };
      // Precedent and open case files beside the element they concern, from any version (CASE4).
      const by = <T extends { on: string }>(xs: T[]) => {
        const m = new Map<string | null, T[]>();
        for (const x of xs) { const el = parseAddress(x.on).element ?? null; (m.get(el) ?? m.set(el, []).get(el)!).push(x); }
        return m;
      };
      const ruled = by(rulings);
      const open = by(cases.map(({ case: id, on, question, positions, next }) => ({ case: id, on, question, positions: positions.length, next })));
      const at = (element?: string) => formatAddress({ kolab: n.kolab_id, node: n.name, version: row.seq, element }, { from: here });
      return {
        node: n.kolab_id === here ? n.name : `${n.kolab_id}/${n.name}`, version: row.seq, state: row.state, versionId: row.id, author: await kolab.author(row.id),
        // Who made the node (W2.20), for a reader in its own kolab only (D49, D58); null for one
        // made before Kolab recorded it.
        ...('createdBy' in read ? { node_created_by: read.createdBy ?? null } : {}),
        ...(removes.length ? { removes_links: removes } : {}),
        ...(rebase ? { rebase: { ...rebase, ...(rebase.after ? { after: formatAddress(parseAddress(rebase.after), { from: here }) } : {}) } } : {}),
        ...(start === 0 ? shown(null) : {}),
        ...(start === 0 && ruled.get(null) ? { rulings: ruled.get(null) } : {}),
        element_count: all.length,
        ...(all.length > READ_NODE_PAGE ? { elements_from: start + 1, elements_to: start + els.length } : {}),
        elements: els.map((e) => ({
          address: at(e.element_id), id: e.element_id, parent: e.parent_element_id, text: e.text,
          ...shown(e.element_id),
          ...(ruled.get(e.element_id) ? { rulings: ruled.get(e.element_id) } : {}),
          ...(open.get(e.element_id) ? { open_cases: open.get(e.element_id) } : {}),
        })),
        next,
      };
    });
  }

  @McpTool({
    name: 'konjir_lineage',
    description: `Walk lineage from a node version: upstream = what it depends on; downstream = what depends on it. By link id.${PAGED}`,
    schema: lineage,
    annotations: { readOnlyHint: true },
  })
  lineage({ node, direction, cursor, limit }: z.infer<typeof lineage>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const n = await this.kolab.nodeIn(s, node, 'walking lineage');
      const v = await this.kolab.latestCommitted(n.id);
      if (!v) throw new Error(`${n.name} has no committed version`);
      const { items, next } = await this.kolab.lineagePage(v.id, direction, { cursor, limit });
      return { node: n.name, version: v.seq, direction, edges: items, next };
    });
  }

  @McpTool({
    name: 'konjir_list_stale',
    description: `List open dirty marks: what is dirty, why, and the next step. Defaults to your own layer. Oldest first.${PAGED}`,
    schema: listStale,
    annotations: { readOnlyHint: true },
  })
  listStale({ all_layers, node, cursor, limit }: z.infer<typeof listStale>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      const id = node === undefined ? undefined : (await this.kolab.nodeIn(s, node, 'listing marks')).id;
      const { items, next } = await this.kolab.marksPage(s, { layer: all_layers ? undefined : me.layer, node: id }, { cursor, limit });
      return { marks: items, next };
    });
  }

  @McpTool({
    name: 'konjir_list_queries',
    description: `List questions and notes. Default: open ones your layer owns the answer to. mine=true: the ones you raised, with their answers. Oldest first.${PAGED}`,
    schema: listQueries,
    annotations: { readOnlyHint: true },
  })
  listQueries({ mine, all_layers, state, kind, node, cursor, limit }: z.infer<typeof listQueries>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      const id = node === undefined ? undefined : (await this.kolab.nodeIn(s, node, 'listing questions')).id;
      const filter = mine ? { raisedBy: me.actor, state, kind, node: id } : { layer: all_layers ? undefined : me.layer, state: state ?? 'open', kind, node: id };
      const { items, next } = await this.kolab.queriesPage(s, filter, { cursor, limit });
      return { queries: items, next };
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
    description: `Draft a new version. To change a few elements, send only deltas: [{"kind":"override","element":"R2","text":"new text"}], plus add/remove; everything else carries over, so you never need to copy the whole node. Or send the full element list and Kolab computes the delta. A draft is not truth until konjir_submit_for_review commits it. A version holds at most ${MAX_ELEMENTS} elements and ${MAX_VERSION_BYTES / 1024} KiB of text, each element at most ${MAX_ELEMENT_TEXT} characters; a larger draft is refused, saying which limit it hit. You and your owner's other agents (or, for a person, you and your agents) draft at most ${MAX_DRAFTS_PER_HOUR} versions an hour between you; an organization's agents share ${MAX_ORG_DRAFTS_PER_HOUR}. A draft counts when it is made, whoever submits it and whatever becomes of it: put several changes in one draft.`,
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
      // A variant's parent may be another kolab's committed version, one this session reads: a fork (KON9).
      const parent = a.parent ? (await kolab.versionIn(s, a.parent, { what: 'a variant (a fork)', across: true })).id : undefined;
      const id = await kolab.draft(s, n.id, { elements: a.elements, deltas: a.deltas, parent, unlink: a.unlink?.map(toLinkRef) });
      const v = await kolab.version(id);
      const linked: string[] = [];
      for (const l of a.links ?? []) {
        const el = l.source_element ?? l.element!;
        await linkOne(kolab, s, { kind: l.kind ?? 'dependency', source: `kj:${n.name}@${v.seq}#${el}`, target: l.target });
        linked.push(`${el} -> ${l.target}`);
      }
      const unlinked = a.unlink?.length ? { unlinked: await kolab.removedLinks({ session: s }, v) } : {};
      return { node: n.name, version: v.seq, versionId: id, state: v.state, linked, ...unlinked, next: `konjir_submit_for_review node=${n.name} version=${v.seq}` };
    });
  }

  @McpTool({
    name: 'konjir_submit_for_review',
    description: 'Submit a draft. Kolab runs its structural checks; if they fail, the draft stays drafted, with the reason. If they pass, the version goes into review, and commits once another actor who holds Write on its layer approves (konjir_review). The review request reaches only those who can review that layer in the role they work in: a person, or an agent signed in with the role that writes the layer (or not signed in there); reviewers lists them, and if it is empty, review says who to bring in. If no one else holds Write on the layer, the checks alone commit it, and it is recorded as unreviewed; a plan or work-package version always commits on the checks alone. The result names the version that committed or waits (a stale draft may be folded into a rebase). Resubmit a draft that came back with changes requested the same way; resubmitting a version still in review asks whoever can review it now, and commits it unreviewed if no one else holds Write on its layer any more.',
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
    description: 'Record your verdict on a version in review that you did not write, on your own layer: approve, or request_changes with a note and findings. Review requests for you are in your inbox (konjir_list_reviews). Read the version first with konjir_read_node. Report a contradiction (two elements that cannot both hold, or a binding element that conflicts with a requirement it links to: stricter, looser or different) only with request_changes. A layer_leak is content in the wrong layer that conflicts with nothing (implementation in a spec, or behavior a binding adds that its linked requirements don\'t mention); it can come with approve: the version commits and a question goes to the layer that owns the answer. Anything that conflicts is a contradiction. Send compound requirements back to be split. konjir_instructions which=reviewer has the full checklist.',
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
    description: `Review requests waiting for you, oldest first, each with its subject and how to review it; and your own submissions, newest first, with the verdicts they got. Paged: each list returns at most limit items (50 by default, at most 200), and next pages both: while next isn't null, call again with cursor=next for the rest of whichever isn't done.`,
    schema: listReviews,
    annotations: { readOnlyHint: true },
  })
  listReviews({ cursor, limit }: z.infer<typeof listReviews>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      const kolab = await this.kolab.sessionKolab(s);
      // One cursor for both lists: each one's own cursor, or done once it has returned its last.
      const [f, y] = (keyOf('list_reviews', cursor, ['text', 'text']) ?? [null, null]) as [string | null, string | null];
      const forYou = f === 'done' ? { items: [], next: null } : await this.kolab.reviewRequestsPage({ reviewer: me.actor, kolab }, { cursor: f, limit });
      const yours = y === 'done' ? { items: [], next: null } : await this.kolab.submissionsPage(me.actor, { kolab }, { cursor: y, limit });
      const next = forYou.next || yours.next ? cursorFor('list_reviews', [forYou.next ?? 'done', yours.next ?? 'done']) : null;
      return { for_you: forYou.items, yours: yours.items, next };
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
      ...(r.rebases ? { rebases_queued: r.rebases } : {}),
      ...(r.ok ? await (async () => {
        const marks = await kolab.marksPage(session, { node: n.id });
        return { stale_after_commit: marks.items, ...(marks.next ? { stale_after_commit_more: `More marks than these: konjir_list_stale node=${node} all_layers=true lists them all.` } : {}) };
      })() : { stale_after_commit: [] }),
      next: r.ok ? `Committed${r.unreviewed ? ', unreviewed: no one else holds Write on this layer' : ''}.${r.cascade ? ' Its cascade (marks downstream, variants rebased) is queued behind an earlier one of this node and runs once that one is done.' : ''}${r.rebases ? ` ${r.rebases === 1 ? 'One variant\'s rebase is' : `${r.rebases} variants' rebases are`} queued: Kolab rebases them in the background, level by level, and any override they conflict with comes back as a mark and a question.` : ''} Others can now link to it; check konjir_list_stale.`
        : r.in_review ? (r.reviewers?.length
          ? `In review: ${r.reviewers.join(', ')} ${r.reviewers.length > 1 ? 'each have' : 'has'} a review request in their inbox, and one approval commits it. Carry on; the verdict comes back in your answers (konjir_list_reviews).`
          : `In review. ${nobodyCanReview(v.layer)} The verdict comes back in your answers (konjir_list_reviews).`)
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
    name: 'konjir_unlink',
    description: 'Remove links in a draft of yours, so its commit doesn\'t carry them forward: a link you no longer rely on, or an orphaned one whose target is gone (re-point it by linking the replacement, then remove the old one). Name each by its id (konjir_lineage, konjir_list_stale) or by its source element and target. The removal is part of the draft: it is reviewed with it, and the links and their open marks settle only when it commits. A link the draft declared itself goes at once. Linking the same link again in the draft takes the removal back.',
    schema: unlink,
  })
  unlink(a: z.infer<typeof unlink>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const v = await this.kolab.versionIn(s, { ...parseNodeRef(a.node), version: a.version }, { allowDraft: true, what: 'removing links' });
      const removed = await this.kolab.unlink(s, v.id, a.links.map(toLinkRef));
      const name = (await this.kolab.node(v.node_id)).name;
      return { node: name, version: a.version, unlinked: removed, next: `konjir_submit_for_review node=${name} version=${a.version}` };
    });
  }

  @McpTool({
    name: 'konjir_clear_mark',
    description: 'Clear a dirty mark on your layer after checking that your work still holds against the new upstream. Re-pins the dependency and clears what it caused. A link into another kolab can be cleared only by someone who reads that kolab, who then holds the link; clearing an access_lost mark is how someone who reads it takes the link or fork over.',
    schema: clearMark,
  })
  clearMark({ mark }: z.infer<typeof clearMark>, context?: McpToolContext) {
    return asAgent(context, async (s) => { await this.kolab.clear(s, mark); return { cleared: mark }; });
  }

  @McpTool({
    name: 'konjir_resolve_override',
    description: 'Resolve a stale or orphaned override in a variant spec: reaffirm (keep yours), adopt_parent (take the parent text), or amend (new text). Becomes precedent for the same situation elsewhere. The resolution is a new version, so it counts as one of your drafts in the hour.',
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
    description: `Ask a question about an address. It routes to the layer that owns the answer: ask a functional spec about intent, a binding about implementation choices. The address may name a committed version or one in review (kj:checkout@2#R4), never a draft; without @version it names the latest committed version. A question about a version in review stays on it when it commits; if it is abandoned or returned to its author instead, the question moves to the latest committed version if the element is there, or is withdrawn, saying why. Quote the words you mean with ~q(...). Set from to the element you wrote pending the answer. You and your owner's other agents (or, for a person, you and your agents) raise at most ${MAX_ASKS_PER_HOUR} questions and notes an hour between you; an organization's agents share ${MAX_ORG_ASKS_PER_HOUR}: put several points in one question.`,
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

  // ---- case files and rulings (CASE1–CASE7) ----------------------------------

  @McpTool({
    name: 'konjir_open_case',
    description: 'Open a case file: a disagreement about one element that you and the other side could not settle between yourselves, such as a requirement that code reality says can\'t be met as written. Give the question in dispute and your position: a claim, its evidence, and the side it takes (seeks keep_intent or change_intent). Only those with Write on a layer of the kolab may. It waits in the inbox of the element\'s layer for the other side\'s position (konjir_add_position) and then a person\'s ruling (konjir_rule), and blocks nothing meanwhile. Ask first (konjir_ask): most questions need an answer, not a ruling. Never patch the behavior instead.',
    schema: openCase,
  })
  openCase(a: z.infer<typeof openCase>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const id = await this.kolab.openCase(s, a.address, { question: a.question, claim: a.claim, evidence: a.evidence, seeks: a.seeks });
      return (await this.kolab.casesFor(s, { id }))[0];
    });
  }

  @McpTool({
    name: 'konjir_add_position',
    description: 'Take the other side of an open case file: your claim and its evidence, seeking the opposite of the opener. A case file holds two positions, one per side; the opener\'s own person and their agents can\'t take the other side, and you need Write on a layer of the kolab. Once it has both, a person rules on it.',
    schema: addPosition,
  })
  addPosition(a: z.infer<typeof addPosition>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const position = await this.kolab.addPosition(s, a.case, { claim: a.claim, evidence: a.evidence });
      return { position, ...(await this.kolab.casesFor(s, { id: a.case }))[0] };
    });
  }

  @McpTool({
    name: 'konjir_rule',
    description: 'Rule, as a person (never an agent), from a session in the role that writes the element\'s layer, holding Write on it. With case: rule on that case file, sustaining exactly one of its two positions and overruling the other; the ruling\'s effect is the side the sustained one seeks. You may not rule on one you or your agent holds a position on. With address and no case: rule directly, with no case file behind it. A direct ruling says whether it changes the intent or keeps it and asks for another way, and supersedes any case file still open on its element. A ruling that changes the intent marks the element, with a question to its layer, until a version amends it. A ruling records its author and date, never changes, and is served to every agent in the kolab as precedent; a later ruling says what it replaces.',
    schema: rule,
  })
  rule(a: z.infer<typeof rule>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const id = await this.kolab.rule(s, a);
      const [ruling] = (await this.kolab.rulingsFor(s, a.case ? { cases: [a.case] } : {})).filter((r) => r.ruling === id);
      return {
        ...ruling,
        next: ruling.effect === 'change_intent'
          ? `The intent changes: ${ruling.on} is marked, with a question to its layer, until a version amends it to say what the ruling says; the cascade then reaches everything that depends on it.`
          : `The intent stands: whoever couldn't meet ${ruling.on} as written finds another way.`,
      };
    });
  }

  @McpTool({
    name: 'konjir_list_cases',
    description: `List case files in your kolab, each with its positions, its ruling once given, and the next step. Default: open ones on your layer. mine=true: those you opened or hold a position on. Newest opened first.${PAGED}`,
    schema: listCases,
    annotations: { readOnlyHint: true },
  })
  listCases({ state, mine, all_layers, node, cursor, limit }: z.infer<typeof listCases>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const me = await this.kolab.sessionInfo(s);
      const id = node === undefined ? undefined : (await this.kolab.nodeIn(s, node, 'listing case files')).id;
      const filter = mine ? { actor: me.actor, state, node: id } : { layer: all_layers ? undefined : me.layer, state: state ?? 'open', node: id };
      const { items, next } = await this.kolab.casesPage(s, filter, { cursor, limit });
      return { cases: items, next };
    });
  }

  @McpTool({
    name: 'konjir_read_case',
    description: 'Read one case file of your kolab: the element in dispute, the question, each position with its evidence and verdict, and its ruling once given.',
    schema: readCase,
    annotations: { readOnlyHint: true },
  })
  readCase({ case: id }: z.infer<typeof readCase>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const [c] = await this.kolab.casesFor(s, { id });
      if (!c) throw new Error(`no case file ${id} in kolab ${await this.kolab.sessionKolab(s)}`);
      return c;
    });
  }

  @McpTool({
    name: 'konjir_list_rulings',
    description: `List the rulings in your kolab, newest first: precedent, so a settled question is not argued again. Each names what it rules on, its text, whether it changed the intent, what it replaces, who ruled and when.${PAGED}`,
    schema: listRulings,
    annotations: { readOnlyHint: true },
  })
  listRulings({ node, cursor, limit }: z.infer<typeof listRulings>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const id = node === undefined ? undefined : (await this.kolab.nodeIn(s, node, 'listing rulings')).id;
      const { items, next } = await this.kolab.rulingsPage(s, { node: id }, { cursor, limit });
      return { rulings: items, next };
    });
  }

  // ---- a person's own agents (D59) -----------------------------------------------

  @McpTool({
    name: 'konjir_create_agent',
    description: 'For a person\'s own session only: make, or find again, an agent of yours, <you>-<label>, for a harness to sign in as (konjir connect calls this). An agent of yours already called that is reused. A person has at most 10 live agents (konjir_archive_agent frees a place), and makes at most 3 in 10 minutes. A name that isn\'t free to you is refused, whoever holds it. It grants nothing: the agent reaches a kolab once you choose it on Kolab\'s sign-in page there, with no more access than you hold, at most Write. An agent\'s session and the admin token are refused.',
    schema: createAgent,
  })
  createAgent({ label }: z.infer<typeof createAgent>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.createOwnAgent(s, label));
  }

  @McpTool({
    name: 'konjir_archive_agent',
    description: 'For a person\'s own session only: archive an agent of yours, <you>-<label>. Its sessions end, and it no longer counts toward the 10 live agents a person may have. Its name stays its own; an admin may unarchive it. An agent\'s session and the admin token are refused.',
    schema: createAgent,
    annotations: { destructiveHint: true },
  })
  archiveAgent({ label }: z.infer<typeof createAgent>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.archiveOwnAgent(s, label));
  }
}

async function linkOne(kolab: Kolab, session: string,
  a: { kind: EdgeKind; source: string; source_element?: string; target: string }) {
  const src = parseAddress(a.source);
  const tgt = parseAddress(a.target);
  if (src.element && a.source_element && src.element !== a.source_element) {
    throw new Error(`source names element ${src.element} but source_element is ${a.source_element}; give one`);
  }
  // The source is in the session's kolab; the target may be another kolab's committed version, one
  // this session reads now: the link rests on its actor's Read there (LNK8).
  return kolab.link(session, {
    kind: a.kind,
    source: (await kolab.versionIn(session, src, { allowDraft: true, what: 'linking' })).id, sourceElement: a.source_element ?? src.element,
    target: (await kolab.versionIn(session, tgt, { what: 'linking', across: true })).id, targetElement: tgt.element, selector: tgt.selector,
  });
}
