/**
 * Phase 0's first spike (docs/plans/konnect-mobile.md): the MCP client the CLI uses, on Hermes,
 * with `expo/fetch` as its fetch. As one person it calls a tool (konjir_whoami), opens a
 * `subscriptions/listen` stream on their answers resource, and waits for
 * `notifications/resources/updated` when another person sends them a message, then re-reads the
 * resource as konnect does. Every step is logged with how long it took.
 *
 * It runs only against a Kolab on this machine (scripts/local-kolab.mts), with its throwaway tokens.
 * libs/konnect-client (phase 1, another PR) replaces it.
 */
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { fetch as expoFetch } from 'expo/fetch';

export interface SpikeTokens { url: string; listener: { actor: string; token: string }; sender: { actor: string; token: string } }

/** `expo/fetch`, whose response body streams on iOS and Android, as the transport's fetch. */
const streamingFetch: FetchLike = (input, init) => expoFetch(String(input), init as Parameters<typeof expoFetch>[1]) as unknown as ReturnType<FetchLike>;

const within = <T>(ms: number, what: string, p: Promise<T>) => Promise.race([
  p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms)),
]);

async function connect(url: string, token: string) {
  // 'auto' negotiates 2026-07-28 with Kolab, which subscriptions/listen needs (as the channel bridge does).
  const client = new Client({ name: 'konnect-mobile-spike', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: streamingFetch }));
  return client;
}

export async function runMcpSpike(t: SpikeTokens, log: (line: string) => void): Promise<boolean> {
  const started = Date.now();
  const step = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const r = await f();
    log(`ok ${what} (${Date.now() - t0} ms)`);
    return r;
  };
  log(`runtime: ${typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object' ? 'Hermes' : 'not Hermes'}; Kolab at ${t.url}`);
  const listener = await step('initialize as the listener', () => connect(t.url, t.listener.token));
  try {
    const me = await step('tools/call konjir_whoami', () => listener.callTool({ name: 'konjir_whoami', arguments: {} }));
    const who = me.structuredContent as { actor: string; kolab: string; subscribe: string[] };
    log(`   whoami: ${who.actor} in ${who.kolab}, watching ${who.subscribe.join(', ')}`);

    let heard: (uri: string) => void = () => undefined;
    const updated = new Promise<string>((resolve) => { heard = resolve; });
    listener.setNotificationHandler('notifications/resources/updated', (n) => heard(n.params.uri));
    const subscription = await step('subscriptions/listen', () => listener.listen({ resourceSubscriptions: who.subscribe }));
    try {
      const before = await step('resources/read (baseline)', () => listener.readResource({ uri: who.subscribe[0]! }, { cacheMode: 'bypass' }));
      log(`   baseline: ${JSON.stringify(before.contents[0]).length} characters`);

      const sender = await step('initialize as the sender', () => connect(t.url, t.sender.token));
      const words = `spike ${new Date().toISOString()}`;
      const sentAt = Date.now();
      try {
        const sent = await step(`tools/call konjir_send_message to ${t.listener.actor}`, () => sender.callTool({ name: 'konjir_send_message', arguments: { to: t.listener.actor, message: words } }));
        if (sent.isError) throw new Error(`send refused: ${JSON.stringify(sent.content)}`);
      } finally {
        await sender.close();
      }
      const uri = await within(15_000, 'notifications/resources/updated', updated);
      log(`ok notifications/resources/updated for ${uri}, ${Date.now() - sentAt} ms after the send`);
      const after = await step('resources/read (after the update)', () => listener.readResource({ uri }, { cacheMode: 'bypass' }));
      const body = JSON.stringify(after.contents[0]);
      log(`   the answers resource ${body.includes(t.sender.actor) ? 'now names the sender' : 'does not name the sender'} (${body.length} characters)`);
      const read = await step('tools/call konjir_read_messages', () => listener.callTool({ name: 'konjir_read_messages', arguments: { from: t.sender.actor } }));
      const messages = (read.structuredContent as { messages?: { message: string }[] } | undefined)?.messages ?? [];
      const got = messages.some((m) => m.message === words);
      log(`${got ? 'ok' : 'FAILED'} the message read back as sent`);
      log(`spike ${got ? 'passed' : 'failed'} in ${Date.now() - started} ms`);
      return got;
    } finally {
      await subscription.close().catch(() => undefined);
    }
  } finally {
    await listener.close();
  }
}
