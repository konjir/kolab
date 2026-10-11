/**
 * Konjir over MCP: one hub, served as a stateless Streamable HTTP endpoint
 * (MCP 2026-07-28, with the SDK's stateless fallback for 2025-era clients).
 *
 * Identity rides the transport, not the tool arguments: every request carries
 * `Authorization: Bearer <token>`. An agent token is an open session (one
 * actor, one active role). The admin token can add actors and open sessions.
 * Role and gate rules are enforced by the hub, not here: this layer only
 * translates.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer, ResourceTemplate, createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toWebRequest } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { GateError, Hub, RoleError, type HubEvent, type Kind, type Layer, type Query, type Reviewer } from './hub.js';
import { parseAddress } from './address.js';

const KINDS = ['functional_spec', 'prototype', 'technical_binding', 'wbs', 'work_package', 'implementation'] as const;

export const INSTRUCTIONS = `Konjir holds the canonical specs, bindings and work for this project. Your session token fixes your actor and role (product writes the functional layer; engineer writes the technical layer).
Rules:
1. Fetch fresh. Resolve addresses with konjir_resolve when you need them; never copy spec text into local files, readmes or comments.
2. Address precisely. kj:<node>[@<version>][#<element>][~q({"exact":"…"})]. Link from the element you are writing to the element you rely on.
3. Never change behavior from the technical layer. If the spec can't be met as written, konjir_ask the spec, don't patch around it. Pass from=<your element> so the answer comes back to that element as a mark. To flag an interpretation or assumption that needs no answer, konjir_annotate the spec.
4. Drafts are not truth until review commits them. Nothing may link to an uncommitted version.
5. Before finishing work, run konjir_list_stale and handle every mark on your layer.
6. Your inbox is pushed. If your client supports subscriptions/listen, subscribe to the resources konjir_whoami lists and re-read one when it is updated. Otherwise, while you wait on answers, run \`konjir watch --once\` (the konjir CLI, with KONJIR_URL and KONJIR_TOKEN set) as a background command: it exits with the change as soon as your inbox has one.`;

const MORE = 'Full operating instructions and precedent: the konjir_operating_instructions MCP prompt, or run `konjir instructions` in a shell.';

type Ctx = { hub: Hub; session?: string; admin: boolean };

/** Resources an agent subscribes to. The hub signals them; their contents are read, never pushed. */
export const inboxUri = (layer: Layer) => `konjir://inbox/${layer}`;
export const answersUri = (actor: string) => `konjir://answers/${encodeURIComponent(actor)}`;
export const uriOf = (e: HubEvent) => e.inbox === 'layer' ? inboxUri(e.layer) : answersUri(e.actor);

/** Questions and notes in the shape read_node shows them beside an element. */
const thread = (q: Query) => ({
  id: q.id, kind: q.kind, state: q.state, on: q.address, question: q.question, raised_by: q.raised_by, from: q.from,
  ...(q.state === 'answered' ? { answer: q.answer, answered_by: q.answered_by } : {}),
});

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

function fail(e: unknown) {
  const err = e as Error;
  const hint =
    err instanceof RoleError ? ' Your session role cannot write this layer. Ask the owning layer with konjir_ask instead.'
    : err instanceof GateError ? ' The review gate or lineage rules refused this. Read the message and adjust; do not retry unchanged.'
    : '';
  return { content: [{ type: 'text' as const, text: `${err.name ?? 'Error'}: ${err.message}.${hint}` }], isError: true };
}

/** Wrap a handler: require an agent session, map hub errors to actionable tool errors. */
function agent<A>(ctx: Ctx, fn: (args: A, session: string) => Promise<unknown>) {
  return async (args: A) => {
    if (!ctx.session) return fail(new RoleError('this tool needs an agent session token, not the admin token'));
    try { return ok(await fn(args, ctx.session)); } catch (e) { return fail(e); }
  };
}

const address = z.string().describe('A Konjir address, e.g. kj:checkout@3#R1 or kj:checkout#R1~q({"exact":"30 seconds"}). Omit @version to use the latest committed version.');
const elementInput = z.object({
  id: z.string().optional().describe('Stable element ID. Reuse the existing ID when editing an element; omit only for a brand-new element.'),
  text: z.string(),
  parent: z.string().optional().describe('ID of the containing element (e.g. a section).'),
});
const deltaInput = z.object({
  kind: z.enum(['add', 'override', 'remove']),
  element: z.string(),
  text: z.string().optional(),
  parent: z.string().optional(),
});

export function buildServer(ctx: Ctx): McpServer {
  const { hub } = ctx;
  const server = new McpServer({ name: 'konjir', version: '0.6.0' }, {
    instructions: `${INSTRUCTIONS}\n${MORE}`,
    capabilities: { resources: { subscribe: true } },
  });

  // ---- read ----------------------------------------------------------------

  server.registerTool('konjir_whoami', {
    description: 'Show the actor, role and layer your session token carries, and the inbox resources to subscribe to for pushed updates.',
    annotations: { readOnlyHint: true },
  }, agent(ctx, async (_: unknown, s) => {
    const me = await hub.sessionInfo(s);
    return { ...me, subscribe: [inboxUri(me.layer), answersUri(me.actor)] };
  }));

  server.registerTool('konjir_list_nodes', {
    description: 'List specs, bindings, WBS, work packages and implementations, with their latest committed version number.',
    inputSchema: z.object({ kind: z.enum(KINDS).optional() }),
    annotations: { readOnlyHint: true },
  }, agent(ctx, async ({ kind }: { kind?: Kind }) => hub.listNodes(kind)));

  server.registerTool('konjir_resolve', {
    description: 'Resolve an address to its current content. Use this instead of caching spec text. Status is ok, fuzzy (wording drifted) or orphan (gone).',
    inputSchema: z.object({ address }),
    annotations: { readOnlyHint: true },
  }, agent(ctx, async ({ address: a }: { address: string }) => {
    const r = await hub.resolve(a);
    const v = r.versionId ? await hub.version(r.versionId) : undefined;
    return { address: a, status: r.status, version: v?.seq ?? null, content: 'content' in r ? r.content : null };
  }));

  server.registerTool('konjir_read_node', {
    description: 'Read every element of a node version, each with its address and the questions and notes raised on it (open and answered, from any version). Defaults to the latest committed version.',
    inputSchema: z.object({ node: z.string(), version: z.number().int().optional() }),
    annotations: { readOnlyHint: true },
  }, agent(ctx, async ({ node, version }: { node: string; version?: number }) => {
    const v = version === undefined
      ? await hub.latestCommitted(node)
      : (await hub.db.query<{ id: string }>(`select id from version where node_id = $1 and seq = $2`, [node, version])).rows[0];
    if (!v) throw new Error(`${node} has no ${version === undefined ? 'committed version' : `version ${version}`}`);
    const row = await hub.version(v.id);
    const els = await hub.elements(v.id);
    const threads = new Map<string | null, ReturnType<typeof thread>[]>();
    for (const q of await hub.listQueries({ node })) {
      const el = parseAddress(q.address).element ?? null;
      (threads.get(el) ?? threads.set(el, []).get(el)!).push(thread(q));
    }
    return {
      node, version: row.seq, state: row.state, versionId: row.id,
      ...(threads.get(null) ? { questions: threads.get(null) } : {}),
      elements: els.map((e) => ({
        address: `kj:${node}@${row.seq}#${e.element_id}`, id: e.element_id, parent: e.parent_element_id, text: e.text,
        ...(threads.get(e.element_id) ? { questions: threads.get(e.element_id) } : {}),
      })),
    };
  }));

  server.registerTool('konjir_lineage', {
    description: 'Walk lineage from a node version: upstream = what it depends on; downstream = what depends on it.',
    inputSchema: z.object({
      node: z.string(),
      direction: z.enum(['upstream', 'downstream']).describe('Required. upstream = what this node relies on; downstream = what relies on it.'),
    }),
    annotations: { readOnlyHint: true },
  }, agent(ctx, async ({ node, direction }: { node: string; direction: 'upstream' | 'downstream' }) => {
    const v = await hub.latestCommitted(node);
    if (!v) throw new Error(`${node} has no committed version`);
    return { node, version: v.seq, direction, edges: await hub.lineage(v.id, direction) };
  }));

  server.registerTool('konjir_list_stale', {
    description: 'List open dirty marks: what is dirty, why, and the next step. Defaults to your own layer.',
    inputSchema: z.object({ all_layers: z.boolean().optional(), node: z.string().optional() }),
    annotations: { readOnlyHint: true },
  }, agent(ctx, async ({ all_layers, node }: { all_layers?: boolean; node?: string }, s) => {
    const me = await hub.sessionInfo(s);
    return { marks: await hub.describeMarks({ layer: all_layers ? undefined : me.layer, node }) };
  }));

  server.registerTool('konjir_list_queries', {
    description: 'List questions and notes. Default: open ones your layer owns the answer to. mine=true: the ones you raised, with their answers.',
    inputSchema: z.object({
      mine: z.boolean().optional().describe('Questions and notes you raised, open and answered'),
      all_layers: z.boolean().optional(),
      state: z.enum(['open', 'answered']).optional(),
      kind: z.enum(['question', 'note']).optional(),
      node: z.string().optional().describe('Only those raised on this node'),
    }),
    annotations: { readOnlyHint: true },
  }, agent(ctx, async ({ mine, all_layers, state, kind, node }: { mine?: boolean; all_layers?: boolean; state?: 'open' | 'answered'; kind?: 'question' | 'note'; node?: string }, s) => {
    const me = await hub.sessionInfo(s);
    if (mine) return { queries: await hub.listQueries({ raisedBy: me.actor, state, kind, node }) };
    return { queries: await hub.listQueries({ layer: all_layers ? undefined : me.layer, state: state ?? 'open', kind, node }) };
  }));

  // ---- write ---------------------------------------------------------------

  server.registerTool('konjir_create_node', {
    description: 'Create a node. Its kind fixes its layer: functional_spec and prototype are functional; the rest are technical.',
    inputSchema: z.object({ kind: z.enum(KINDS), title: z.string(), id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional().describe('Readable stable ID, e.g. checkout. Defaults to a ULID.') }),
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, agent(ctx, async ({ kind, title, id }: { kind: Kind; title: string; id?: string }, s) => ({ node: await hub.createNode(s, kind, title, id) })));

  server.registerTool('konjir_draft', {
    description: 'Draft a new version. To change a few elements, send only deltas: [{"kind":"override","element":"R2","text":"new text"}], plus add/remove; everything else carries over, so you never need to copy the whole node. Or send the full element list and the hub computes the delta. A draft is not truth until konjir_submit_for_review commits it.',
    inputSchema: z.object({
      node: z.string(),
      elements: z.array(elementInput).optional(),
      deltas: z.array(deltaInput).optional(),
      parent: address.optional().describe('For a new variant: the parent spec version to inherit from, e.g. kj:storefront@2.'),
      links: z.array(z.object({
        source_element: z.string().optional().describe('Your element in this draft (same name as on konjir_link)'),
        element: z.string().optional().describe('Alias for source_element'),
        target: address.describe('What it relies on (committed)'),
        kind: z.enum(['dependency', 'derivation', 'equivalence']).optional().describe('Defaults to dependency'),
      })).optional().describe('Links to declare from this draft\'s elements, in the same call: [{"source_element":"b1","target":"kj:spec#R1"}]. Links on earlier versions carry forward automatically.'),
    }),
  }, agent(ctx, async (a: { node: string; elements?: z.infer<typeof elementInput>[]; deltas?: z.infer<typeof deltaInput>[]; parent?: string; links?: { source_element?: string; element?: string; target: string; kind?: 'dependency' | 'derivation' | 'equivalence' }[] }, s) => {
    for (const l of a.links ?? []) {
      if (!l.source_element && !l.element) throw new Error(`each link needs source_element (the element in your draft); missing for target ${l.target}`);
    }
    if (!a.elements === !a.deltas) throw new Error('send exactly one of elements or deltas');
    const parent = a.parent ? await versionIdOf(hub, a.parent) : undefined;
    const id = await hub.draft(s, a.node, { elements: a.elements, deltas: a.deltas, parent });
    const v = await hub.version(id);
    const linked: string[] = [];
    for (const l of a.links ?? []) {
      const el = l.source_element ?? l.element!;
      await linkOne(hub, s, { kind: l.kind ?? 'dependency', source: `kj:${a.node}@${v.seq}#${el}`, target: l.target });
      linked.push(`${el} -> ${l.target}`);
    }
    return { node: a.node, version: v.seq, versionId: id, state: v.state, linked, next: `konjir_submit_for_review node=${a.node} version=${v.seq}` };
  }));

  server.registerTool('konjir_submit_for_review', {
    description: 'Run the review gate on a draft. On pass it commits and the cascade runs; the result names the version that committed (a stale draft may be folded into a rebase).',
    inputSchema: z.object({ node: z.string(), version: z.number().int() }),
  }, agent(ctx, async ({ node, version }: { node: string; version: number }) => {
    const id = await versionIdOf(hub, `kj:${node}@${version}`, true);
    const r = await hub.review(id);
    const v = await hub.version(r.version);
    return {
      ok: r.ok, review: r.note ?? null, committed: r.ok ? `kj:${node}@${v.seq}` : null,
      stale_after_commit: r.ok ? await hub.describeMarks({ node }) : [],
      next: r.ok ? 'Committed. Others can now link to it; check konjir_list_stale.'
        : r.retryable ? `Not reviewed yet; the draft is intact. Resubmit with konjir_submit_for_review node=${node} version=${version} shortly.`
        : 'Rejected. Fix what the review names and draft again.',
    };
  }));

  server.registerTool('konjir_link', {
    description: 'Declare that one of your elements relies on an address, so you are told when it changes. Name your element either in source (kj:checkout-pg@2#b1) or in source_element; a link without a source element makes your whole version, and everything downstream of it, dirty on any change. kind: dependency (usual), derivation (generated from it), equivalence (must stay in sync). Linking two elements of the same spec is allowed.',
    inputSchema: z.object({
      kind: z.enum(['dependency', 'derivation', 'equivalence']).describe('dependency = relies on; derivation = generated from; equivalence = must stay in sync'),
      source: address.describe('Your element, e.g. kj:checkout-pg@2#b1 (drafts allowed).'),
      source_element: z.string().optional().describe('Alternative to putting #element in source.'),
      target: address.describe('What it relies on; must be committed. e.g. kj:checkout@3#R1, or a span: kj:checkout#R1~q({"exact":"30 seconds"})'),
    }),
  }, agent(ctx, async (a: { kind: 'dependency' | 'derivation' | 'equivalence'; source: string; source_element?: string; target: string }, s) => {
    return { edge: await linkOne(hub, s, a) };
  }));

  server.registerTool('konjir_clear_mark', {
    description: 'Clear a dirty mark on your layer after checking that your work still holds against the new upstream. Re-pins the dependency and clears what it caused.',
    inputSchema: z.object({ mark: z.string() }),
  }, agent(ctx, async ({ mark }: { mark: string }, s) => { await hub.clear(s, mark); return { cleared: mark }; }));

  server.registerTool('konjir_resolve_override', {
    description: 'Resolve a stale or orphaned override in a variant spec: reaffirm (keep yours), adopt_parent (take the parent text), or amend (new text). Becomes precedent for the same situation elsewhere.',
    inputSchema: z.object({ mark: z.string(), resolution: z.enum(['reaffirm', 'adopt_parent', 'amend']), text: z.string().optional() }),
  }, agent(ctx, async ({ mark, resolution, text }: { mark: string; resolution: 'reaffirm' | 'adopt_parent' | 'amend'; text?: string }, s) => {
    if (resolution === 'amend' && !text) throw new Error('amend needs text');
    const r = await hub.resolveOverride(s, mark, resolution, text);
    return { ok: r.verdict.ok, note: r.verdict.note ?? null };
  }));

  const from = address.optional().describe('Your own element that waits on this, e.g. kj:checkout-pg@1#b3 (drafts allowed). When the question is answered, that element gets a query_answered mark.');

  server.registerTool('konjir_ask', {
    description: 'Ask a question about an address. It routes to the layer that owns the answer: ask a functional spec about intent, a binding about implementation choices. Quote the words you mean with ~q(...). Set from to the element you wrote pending the answer.',
    inputSchema: z.object({ address, question: z.string(), from }),
  }, agent(ctx, async (a: { address: string; question: string; from?: string }, s) =>
    ({ query: await hub.raiseQuery(s, a.address, a.question, { from: a.from }) })));

  server.registerTool('konjir_annotate', {
    description: 'Leave a note on an address for the layer that owns it: an interpretation you are proceeding on, an assumption, a risk, or something you could not check. It blocks nothing. The owner sees it beside the element in konjir_read_node and in its konjir_list_queries, and can reply. If you need a decision before you can proceed, use konjir_ask instead.',
    inputSchema: z.object({ address, note: z.string(), from: address.optional().describe('Your own element the note is about') }),
  }, agent(ctx, async (a: { address: string; note: string; from?: string }, s) =>
    ({ note: await hub.raiseQuery(s, a.address, a.note, { kind: 'note', from: a.from }) })));

  server.registerTool('konjir_answer_query', {
    description: 'Answer an open question, or reply to a note, that your layer owns. If the answer settles or changes intent, also amend the spec element: the answer reaches only the asker, the amendment reaches everyone who depends on it.',
    inputSchema: z.object({ query: z.string(), answer: z.string() }),
  }, agent(ctx, async ({ query, answer }: { query: string; answer: string }, s) => { await hub.answerQuery(s, query, answer); return { answered: query }; }));

  // ---- inboxes (subscribe for pushed updates) ---------------------------------

  server.registerResource('konjir_inbox', new ResourceTemplate('konjir://inbox/{layer}', { list: undefined }), {
    title: 'A layer\'s work queue',
    description: 'Open questions and notes the layer owns, and open marks on its work. Subscribe to your own layer\'s inbox; it is updated whenever that queue changes.',
    mimeType: 'application/json',
  }, async (uri, vars) => {
    const layer = String(vars.layer);
    if (layer !== 'functional' && layer !== 'technical') throw new Error(`no inbox ${uri.href}`);
    if (!ctx.session) throw new RoleError('reading an inbox needs an agent session token');
    const body = {
      layer,
      queries: await hub.listQueries({ layer, state: 'open' }),
      marks: await hub.describeMarks({ layer }),
    };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  });

  server.registerResource('konjir_answers', new ResourceTemplate('konjir://answers/{actor}', { list: undefined }), {
    title: 'Answers to what you raised',
    description: 'Your questions and notes with their replies. Updated whenever one of them is answered.',
    mimeType: 'application/json',
  }, async (uri, vars) => {
    if (!ctx.session) throw new RoleError('reading answers needs an agent session token');
    const me = await hub.sessionInfo(ctx.session);
    if (decodeURIComponent(String(vars.actor)) !== me.actor) throw new RoleError('you can only read your own answers');
    const body = { actor: me.actor, queries: await hub.listQueries({ raisedBy: me.actor }) };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  });

  // ---- served instructions ---------------------------------------------------

  server.registerPrompt('konjir_operating_instructions', {
    title: 'Konjir operating instructions',
    description: 'The rules for working through Konjir, plus recent precedent so settled questions are not re-litigated.',
  }, async () => {
    const prec = (await hub.db.query<{ resolution: string; amended_text: string | null; ruled_by: string }>(
      `select resolution, amended_text, ruled_by from precedent order by id desc limit 20`)).rows;
    const answered = await hub.listQueries({ state: 'answered' });
    const text = [
      INSTRUCTIONS,
      '',
      'Working loop: konjir_whoami, then konjir_list_stale and konjir_list_queries for your layer (and konjir_list_queries mine=true for answers to your own questions); resolve what you need with konjir_resolve; draft with links, submit for review; finish by checking konjir_list_stale again.',
      'Answering questions: if the answer settles or changes intent, also amend the spec element and commit it. The answer alone reaches only the asker; the spec change reaches everyone who depends on that element, through the cascade.',
      '',
      'Writing specs (product): intent and behavior only, one testable requirement per element, readable stable IDs (e.g. R1, R2 or a feature prefix like PR1). Reuse an element\'s ID when you edit it; a new ID means a new requirement. To edit, draft with deltas (override/add/remove) rather than resending everything.',
      'Writing bindings and work (engineer): one element per implementation decision; link each element to exactly the requirement(s) it serves, with source_element set. Questions about intent go to the spec with konjir_ask; never encode a behavior change in a binding.',
      'Questions and notes: ask on the narrowest address (an element, or a quoted span with ~q). Set from to your element that waits on the answer; when it is answered that element gets a query_answered mark, which editing the element or konjir_clear_mark settles. Use konjir_annotate for an interpretation or assumption you are proceeding on, so the owner can object; it blocks nothing. Both show beside the element in konjir_read_node.',
      'Edge kinds: dependency = this element relies on that one (the usual choice); derivation = this element was generated from that one (e.g. a WBS item from a binding element); equivalence = two representations that must stay in sync (spec and prototype). All three are re-checked the same way when the target changes.',
      'Links inside one spec are allowed: they say one requirement relies on another, and the hub re-checks them when the target requirement changes.',
      '',
      `Precedent on stale overrides (${prec.length}): ` + (prec.map((p) => `${p.resolution}${p.amended_text ? ` -> "${p.amended_text}"` : ''} (ruled by ${p.ruled_by})`).join('; ') || 'none yet'),
      `Answered questions and notes (${answered.length}): ` + (answered.slice(-20).map((q) => `${q.address}: ${q.kind === 'note' ? 'note' : 'asked'} "${q.question}" -> "${q.answer}"`).join('; ') || 'none yet'),
    ].join('\n');
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
  });

  // ---- admin -----------------------------------------------------------------

  if (ctx.admin) {
    server.registerTool('konjir_admin_add_actor', {
      description: 'Admin: register an actor (a person or an agent identity).',
      inputSchema: z.object({ id: z.string(), name: z.string().optional() }),
    }, async ({ id, name }) => { try { await hub.addActor(id, name ?? id); return ok({ actor: id }); } catch (e) { return fail(e); } });

    server.registerTool('konjir_admin_open_session', {
      description: 'Admin: open a session for an actor with one active role. Returns the bearer token the agent connects with.',
      inputSchema: z.object({ actor: z.string(), role: z.enum(['product', 'engineer']) }),
    }, async ({ actor, role }) => { try { return ok({ token: await hub.openSession(actor, role), actor, role }); } catch (e) { return fail(e); } });

    server.registerTool('konjir_admin_end_session', {
      description: 'Admin: end a session, revoking its token.',
      inputSchema: z.object({ token: z.string() }),
    }, async ({ token }) => { try { await hub.endSession(token); return ok({ ended: token }); } catch (e) { return fail(e); } });
  }

  return server;
}

async function linkOne(hub: Hub, session: string,
  a: { kind: 'dependency' | 'derivation' | 'equivalence'; source: string; source_element?: string; target: string }) {
  const src = parseAddress(a.source);
  const tgt = parseAddress(a.target);
  if (src.element && a.source_element && src.element !== a.source_element) {
    throw new Error(`source names element ${src.element} but source_element is ${a.source_element}; give one`);
  }
  return hub.link(session, {
    kind: a.kind,
    source: await versionIdOf(hub, a.source, true), sourceElement: a.source_element ?? src.element,
    target: await versionIdOf(hub, a.target), targetElement: tgt.element, selector: tgt.selector,
  });
}

async function versionIdOf(hub: Hub, addr: string, allowDraft = false): Promise<string> {
  const a = parseAddress(addr);
  if (a.version === undefined) {
    const v = await hub.latestCommitted(a.node);
    if (!v) throw new Error(`${a.node} has no committed version`);
    return v.id;
  }
  const r = (await hub.db.query<{ id: string; state: string }>(`select id, state from version where node_id = $1 and seq = $2`, [a.node, a.version])).rows[0];
  if (!r) throw new Error(`${a.node} has no version ${a.version}`);
  if (!allowDraft && r.state !== 'committed') throw new GateError(`kj:${a.node}@${a.version} is ${r.state}, not committed`);
  return r.id;
}

// ---- HTTP ------------------------------------------------------------------------

export interface KonjirServer { url: string; hub: Hub; close(): Promise<void> }

export async function startServer(opts: {
  port?: number; host?: string; dataDir?: string; adminToken: string; hub?: Hub; reviewer?: Reviewer;
  /** The public hostname a TLS proxy serves this hub on (e.g. hub.konjir.com). Accepted alongside localhost. */
  publicHost?: string;
}): Promise<KonjirServer> {
  const hub = opts.hub ?? await Hub.open({ dataDir: opts.dataDir, reviewer: opts.reviewer });

  const handler = createMcpHandler(({ authInfo }) => buildServer({
    hub,
    session: authInfo?.scopes.includes('agent') ? authInfo.clientId : undefined,
    admin: authInfo?.scopes.includes('admin') ?? false,
  }));
  // Push: every open subscriptions/listen stream that subscribed to an inbox hears when it changes.
  const unsubscribe = hub.onEvent((e) => handler.notify.resourceUpdated(uriOf(e)));

  async function authenticate(header: string | undefined): Promise<AuthInfo | undefined> {
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return undefined;
    if (token === opts.adminToken) return { token, clientId: 'admin', scopes: ['admin'] };
    const s = await hub.db.query(`select 1 from session where id = $1 and ended_at is null`, [token]);
    return s.rows.length ? { token, clientId: token, scopes: ['agent'] } : undefined;
  }

  const host = opts.host ?? '127.0.0.1';
  const local = host === '127.0.0.1' || host === 'localhost';
  // DNS-rebinding guard: only our own hostnames, and no browser origin but our own.
  const allowed = ['localhost', '127.0.0.1', '[::1]', ...(opts.publicHost ? [opts.publicHost] : [])];
  const validateHost = opts.publicHost ? hostHeaderValidation(allowed) : localhostHostValidation();
  const validateOrigin = opts.publicHost ? originValidation(allowed) : localhostOriginValidation();
  const http: HttpServer = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      try { await hub.db.query('select 1'); res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); }
      catch { res.writeHead(503).end('database unavailable'); }
      return;
    }
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    if ((local || opts.publicHost) && (!validateHost(req, res) || !validateOrigin(req, res))) return;
    const authInfo = await authenticate(req.headers.authorization);
    if (!authInfo) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        .end(JSON.stringify({ error: 'missing or invalid Konjir token' }));
      return;
    }
    try {
      const response = await handler.fetch(await toWebRequest(req), { authInfo });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, host, resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    url: opts.publicHost ? `https://${opts.publicHost}/mcp` : `http://${host}:${port}/mcp`,
    hub,
    async close() {
      unsubscribe();
      await handler.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (!opts.hub) await hub.close();
    },
  };
}
