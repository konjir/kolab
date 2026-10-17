import { AccessError, GateError, RoleError, TenancyError } from '@konjir/engine';
import type { Query } from '@konjir/types';
import type { McpToolContext } from '@onivoro/server-mcp';

/** Questions and notes in the shape read_node shows them beside an element. */
export const thread = (q: Query) => ({
  id: q.id, kind: q.kind, state: q.state, on: q.address, question: q.question, raised_by: q.raised_by, from: q.from,
  ...(q.state === 'answered' ? { answer: q.answer, answered_by: q.answered_by } : {}),
});

export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

export function fail(e: unknown) {
  const err = e as Error;
  const hint =
    err instanceof RoleError ? ' Your session role cannot write this layer. Ask the owning layer with konjir_ask instead.'
    : err instanceof GateError ? ' The review gate or lineage rules refused this. Read the message and adjust; do not retry unchanged.'
    : err instanceof AccessError ? ' Your access to this kolab does not allow it. Access is granted by an admin of the kolab; do not retry unchanged.'
    : err instanceof TenancyError ? ' Read the message and adjust the request.'
    : '';
  return { content: [{ type: 'text' as const, text: `${err.name ?? 'Error'}: ${err.message}.${hint}` }], isError: true };
}

/** The agent session a request carries, if its token is an agent token (see KonjirAuth). */
export const sessionOf = (authInfo: { clientId: string; scopes: string[] } | undefined) =>
  authInfo?.scopes.includes('agent') ? authInfo.clientId : undefined;

/** Run a tool for an agent session, mapping Kolab errors to actionable tool errors. */
export async function asAgent(context: McpToolContext | undefined, fn: (session: string) => Promise<unknown>) {
  const session = sessionOf(context?.authInfo);
  if (!session) return fail(new RoleError('this tool needs an agent session token, not the admin token'));
  try { return ok(await fn(session)); } catch (e) { return fail(e); }
}
