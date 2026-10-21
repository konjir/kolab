/**
 * Kolab's tools, resources and prompts, served to Claude Code by the channel bridge (W3.8, D61):
 * exactly what Kolab lists (names, descriptions, input and output schemas, annotations), and each
 * call forwarded to Kolab as it came, on the bridge's one connection and sign-in. The bridge adds
 * nothing of its own to these lists.
 *
 * What comes back is Kolab's, unchanged, except in errors: a token in an error from Kolab or the
 * transport is masked (the bridge's own masking), the rest of Kolab's text kept. A call that may
 * have reached Kolab and got no answer is never sent again; the session is told it may or may not
 * have run.
 */
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { NotConnected, type KolabBridge, type ListKind } from './bridge.js';

/** A request as the pass-through reads it, and the cancellation Claude Code sends with it. */
type Incoming = { params: Record<string, unknown> };
type Ctx = { mcpReq: { signal: AbortSignal } };

/**
 * The low-level server the stdio module makes (an McpServer's `server`), as far as the pass-through
 * uses it. Structural: the module's SDK types are its CommonJS build's.
 */
export interface LowServer {
  registerCapabilities(capabilities: Record<string, unknown>): void;
  setRequestHandler(method: string, handler: (request: Incoming, ctx: Ctx) => unknown): void;
  projectCallToolResult(result: never, outputSchema: Record<string, unknown> | undefined): unknown;
}

/** The bridge, once it has its sign-in; until then, why there's none, or a promise of it. */
export interface BridgeHolder {
  bridge?: KolabBridge;
  /** Resolves once `bridge` is set (or never, if the bridge can't start). */
  ready: Promise<KolabBridge>;
  /** Masks every token the bridge knows of, and anything shaped like a Kolab secret. */
  redact(text: string): string;
}

/** How long Claude Code's first list waits for the bridge to sign in and connect, before an empty list (then list_changed). */
const FIRST_LIST_WAIT_MS = 10_000;

const NOTIFY: Record<ListKind, string> = {
  tools: 'notifications/tools/list_changed',
  prompts: 'notifications/prompts/list_changed',
  resources: 'notifications/resources/list_changed',
  resourceTemplates: 'notifications/resources/list_changed',
};
export const listChangedNotification = (kind: ListKind) => NOTIFY[kind];

/** The capabilities passing Kolab through needs: its lists, which can change. Resources are read, not subscribed: the channel pushes their changes. */
export const PASSTHROUGH_CAPABILITIES = {
  tools: { listChanged: true },
  prompts: { listChanged: true },
  resources: { listChanged: true },
};

/** Waits up to `ms` for the bridge; undefined if it isn't there by then. */
async function bridgeWithin(holder: BridgeHolder, ms: number) {
  if (holder.bridge) return holder.bridge;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); timer.unref(); });
  try { return await Promise.race([holder.ready, late]); } finally { clearTimeout(timer); }
}

/** An error's message with no token in it. */
const masked = (holder: BridgeHolder, e: unknown) => holder.redact(String((e as Error)?.message ?? e));

/** A JSON-RPC error Kolab answered with (a number code), as opposed to the SDK's own errors (string codes). */
const fromKolab = (e: unknown): e is { code: number; message: string; data?: unknown } => typeof (e as { code?: unknown })?.code === 'number';

/** Kolab's JSON-RPC error, passed on with its code and its text, any token masked. */
function kolabError(holder: BridgeHolder, e: { code: number; message: string; data?: unknown }) {
  const data = e.data === undefined ? undefined : JSON.parse(holder.redact(JSON.stringify(e.data))) as unknown;
  return new ProtocolError(e.code, holder.redact(e.message), data);
}

const timedOut = (e: unknown) => (e as { code?: unknown })?.code === 'REQUEST_TIMEOUT';

/** A tool's result as an error the model reads. */
const toolError = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/**
 * Registers the pass-through on a server the stdio module made, for whichever protocol era Claude
 * Code negotiated: the SDK encodes each result for that era.
 */
export function servePassthrough(server: { server: unknown }, holder: BridgeHolder) {
  const low = server.server as LowServer;
  low.registerCapabilities(PASSTHROUGH_CAPABILITIES);

  const list = async (kind: ListKind) => {
    const bridge = await bridgeWithin(holder, FIRST_LIST_WAIT_MS);
    return bridge ? bridge.list(kind, FIRST_LIST_WAIT_MS) : [];
  };
  // Kolab's lists, whole and unchanged: no paging of the bridge's own.
  low.setRequestHandler('tools/list', async () => ({ tools: await list('tools') }));
  low.setRequestHandler('prompts/list', async () => ({ prompts: await list('prompts') }));
  low.setRequestHandler('resources/list', async () => ({ resources: await list('resources') }));
  low.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: await list('resourceTemplates') }));

  low.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args } = request.params as { name: string; arguments?: unknown };
    const bridge = await bridgeWithin(holder, FIRST_LIST_WAIT_MS);
    if (!bridge) return toolError(`The Konjir channel couldn't call ${name}: it hasn't signed in to Kolab yet. Nothing was sent; try again once it has.`);
    let result: Record<string, unknown>;
    try {
      result = await bridge.forward('tools/call', { name, ...(args !== undefined ? { arguments: args } : {}) }, ctx.mcpReq.signal);
    } catch (e) {
      if (e instanceof NotConnected) return toolError(`The Konjir channel couldn't call ${name}: ${holder.redact(e.message)}. Nothing was sent to Kolab.`);
      if (fromKolab(e)) throw kolabError(holder, e);
      if (timedOut(e)) return toolError(`Kolab didn't answer ${name} in time. The call was sent once and may or may not have run: check (with a read) before calling it again.`);
      return toolError(`The Konjir channel couldn't complete ${name}: ${masked(holder, e)}. If it reached Kolab it may have run: check before calling it again.`);
    }
    // Kolab's result as it came; in an error, any token masked.
    if (result.isError && Array.isArray(result.content)) {
      result = { ...result, content: result.content.map((c: { type?: string; text?: string }) => (c?.type === 'text' && typeof c.text === 'string' ? { ...c, text: holder.redact(c.text) } : c)) };
    }
    return low.projectCallToolResult(result as never, bridge.tool(name)?.outputSchema);
  });

  const passed = (method: 'resources/read' | 'prompts/get') => async (request: Incoming, ctx: Ctx) => {
    const bridge = await bridgeWithin(holder, FIRST_LIST_WAIT_MS);
    if (!bridge) throw new ProtocolError(ProtocolErrorCode.InternalError, 'The Konjir channel hasn\'t signed in to Kolab yet');
    const { _meta: _, ...params } = request.params;
    try {
      return await bridge.forward(method, params, ctx.mcpReq.signal);
    } catch (e) {
      if (fromKolab(e)) throw kolabError(holder, e);
      throw new ProtocolError(ProtocolErrorCode.InternalError, `The Konjir channel couldn't pass ${method} to Kolab: ${masked(holder, e)}`);
    }
  };
  low.setRequestHandler('resources/read', passed('resources/read'));
  low.setRequestHandler('prompts/get', passed('prompts/get'));
}
