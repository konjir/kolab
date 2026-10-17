/**
 * konjir: the same verbs as the MCP server, for a shell or a harness without MCP.
 * It is an MCP client of Kolab, so there is exactly one backend.
 *
 *   konjir serve [--port 7420] [--data .konjir] [--admin-token T]
 *                [--database-url postgres://…]
 *   konjir tools
 *   konjir instructions
 *   konjir resolve <address>
 *   konjir read <node> [version]
 *   konjir stale [all]
 *   konjir queries [all]
 *   konjir watch [--once]                -> print your inbox now and each time Kolab pushes a change
 *   konjir <verb> [key=value ...]        -> calls konjir_<verb>; values are JSON if they parse
 *   konjir <verb> --json '{"key": ...}'
 *
 * Connection: KONJIR_URL (default http://127.0.0.1:7420/mcp) and KONJIR_TOKEN,
 * or --url / --token.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
import type { Reviewer } from '@konjir/types';

// The server, with the Bedrock SDK and the database, is imported only by the
// commands that need it, so the client verbs start without loading it. The published
// konjir (the npm package and the single-file binaries) is the client alone: it leaves
// @konjir/server out, so serve is only for a Kolab checkout.
// Only @konjir/server itself being absent means that; any other failure to load it (a stale
// dist/, a missing dependency of the server's, a syntax error) is rethrown as it is.
class ClientOnly extends Error {}
const server = () => import('@konjir/server').catch((e: unknown) => {
  const err = e as { code?: unknown; message?: unknown };
  if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^Cannot find (package|module) '@konjir\/server'/.test(String(err.message))) {
    throw new ClientOnly('this konjir is the client only, so it has no serve. Run `bin/konjir serve` from a Kolab checkout (github.com/konjir/kolab), or point KONJIR_URL at a running Kolab.');
  }
  throw e;
});

// The published builds (scripts/package.mjs) define this as the package's version.
declare const KONJIR_VERSION: string | undefined;

/** The tool name for a verb: `read_node` and `konjir_read_node` both mean konjir_read_node. */
const toolName = (verb: string) => (verb.startsWith('konjir_') ? verb : `konjir_${verb}`);

export async function connect(url: string, token: string): Promise<Client> {
  // 'auto' talks 2026-07-28 to a Kolab server that offers it (needed for subscriptions/listen) and 2025 to an older one.
  const client = new Client({ name: 'konjir-cli', version: '0.6.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

/**
 * Subscribe to this session's inboxes (its layer's queue and its own answers)
 * over subscriptions/listen. `onUpdate` gets the URI and fresh contents each
 * time Kolab signals a change.
 */
export async function watch(client: Client, onUpdate: (uri: string, body: unknown) => void | Promise<void>) {
  const me = await call(client, 'whoami') as { subscribe: string[] };
  const read = async (uri: string) => {
    const r = await client.readResource({ uri });
    const c = r.contents[0];
    return c && 'text' in c ? JSON.parse(c.text) : null;
  };
  client.setNotificationHandler('notifications/resources/updated', async (n) => {
    await onUpdate(n.params.uri, await read(n.params.uri));
  });
  return { uris: me.subscribe, read, subscription: await client.listen({ resourceSubscriptions: me.subscribe }) };
}

/**
 * Why Kolab refused a listen stream in-band (JSON-RPC -32003, "Listen stream refused"), or
 * undefined for any other error. 'session_ended' means the token was revoked, as a 401 does;
 * any other reason ('gate_failed', 'gate_timeout', 'closed') is worth retrying.
 */
export function listenRefusal(e: unknown): string | undefined {
  const err = e as { code?: unknown; data?: { reason?: unknown } } | undefined;
  if (err?.code !== -32003) return undefined;
  return typeof err.data?.reason === 'string' ? err.data.reason : 'refused';
}

/** Call a tool and return its structured result, or throw with the tool's error text. */
export async function call(client: Client, verb: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name: toolName(verb), arguments: args });
  const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  if (r.isError) throw new Error(text);
  return r.structuredContent ?? text;
}

const usage = (defaultReviewModel: string | undefined) => `konjir — Kolab from a shell. Same verbs as the MCP server.

  konjir instructions          the operating rules and precedent (read this first)
  konjir tools                 every verb, one line each
  konjir help <verb>           a verb's description and parameters
  konjir <verb> key=value ...  call a verb; values parse as JSON when they can,
                               e.g. elements='[{"id":"R1","text":"..."}]'
  konjir <verb> --json '{...}' the same, with all arguments as one JSON object

Shortcuts: konjir resolve <address> · konjir read <node> [version] · konjir stale [all] · konjir queries [all]
Push:      konjir watch prints your inbox, then a JSON line each time it changes (questions, notes,
           answers, marks). konjir watch --once waits for the next change, prints it and exits.
Addresses: kj:<node>[@<version>][#<element>][~q({"exact":"words"})]
Connection: KONJIR_URL (default http://127.0.0.1:7420/mcp) and KONJIR_TOKEN, or --url / --token.
Version:   konjir --version
${defaultReviewModel === undefined ? `Server: this konjir is the client only. Kolab runs from a checkout of github.com/konjir/kolab.` : `Server: konjir serve [--port 7420] [--data .konjir | --database-url postgres://…] [--admin-token T] [--review structural|bedrock] [--public-host kolab.example.com]
        KONJIR_REVIEW=bedrock uses KONJIR_REVIEW_MODEL (default ${defaultReviewModel}) with the
        server's own AWS credentials (AWS_REGION, AWS_PROFILE or the default AWS chain).`}`;

function parseKv(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') { Object.assign(out, JSON.parse(argv[++i])); continue; }
    const eq = argv[i].indexOf('=');
    if (eq < 1) throw new Error(`expected key=value, got "${argv[i]}"`);
    const k = argv[i].slice(0, eq), v = argv[i].slice(eq + 1);
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return out;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

export async function main(argv: string[]) {
  const url = flag(argv, 'url') ?? process.env.KONJIR_URL ?? 'http://127.0.0.1:7420/mcp';
  const token = flag(argv, 'token') ?? process.env.KONJIR_TOKEN;
  const [cmd, ...rest] = argv;

  if (cmd === '--version') {
    console.log(typeof KONJIR_VERSION === 'string' ? KONJIR_VERSION : 'development (run from source)'); return;
  }

  if (!cmd || ((cmd === 'help' || cmd === '--help') && !rest[0])) {
    // Without the server (the published client), help leaves out serve.
    const model = await server().then((s) => s.DEFAULT_REVIEW_MODEL, (e: unknown) => { if (e instanceof ClientOnly) return undefined; throw e; });
    console.log(usage(model)); return;
  }

  if (cmd === 'serve') {
    const { DEFAULT_REVIEW_MODEL, bedrockReviewer, startServer } = await server();
    const port = Number(flag(rest, 'port') ?? 7420);
    const dataDir = flag(rest, 'data') ?? '.konjir';
    const adminToken = flag(rest, 'admin-token') ?? process.env.KONJIR_ADMIN_TOKEN ?? randomBytes(18).toString('base64url');
    const reviewMode = flag(rest, 'review') ?? process.env.KONJIR_REVIEW ?? 'structural';
    let reviewer: Reviewer | undefined;
    if (reviewMode === 'bedrock') {
      const model = process.env.KONJIR_REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL;
      const spent = { input: 0, output: 0, calls: 0, cached: 0 };
      reviewer = bedrockReviewer({
        model,
        onUsage: (u) => {
          if (u.cached) spent.cached++; else { spent.calls++; spent.input += u.inputTokens; spent.output += u.outputTokens; }
          console.error(`review ${u.cached ? '(cache hit)' : `${u.inputTokens} in / ${u.outputTokens} out`} · totals: ${spent.calls} calls, ${spent.cached} cache hits, ${spent.input} in, ${spent.output} out`);
        },
      });
      console.log(`review: ${model} on Amazon Bedrock (${process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'region from AWS config'}), using this server's AWS credentials`);
    } else if (reviewMode !== 'structural') {
      throw new Error(`unknown review mode "${reviewMode}"; use structural or bedrock`);
    } else {
      console.log('review: structural only (set KONJIR_REVIEW=bedrock for semantic review)');
    }
    const publicHost = flag(rest, 'public-host') ?? process.env.KONJIR_PUBLIC_HOST;
    const databaseUrl = flag(rest, 'database-url') ?? process.env.KONJIR_DATABASE_URL;
    const s = await startServer({ port, dataDir, databaseUrl, adminToken, reviewer, publicHost });
    console.log(`Kolab listening on ${s.url}`);
    console.log(`data: ${databaseUrl ? withoutPassword(databaseUrl) : dataDir}`);
    if (!process.env.KONJIR_ADMIN_TOKEN && !rest.includes('--quiet')) console.log(`admin token: ${adminToken}`);
    const stop = async () => { await s.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }

  if (!token) throw new Error('set KONJIR_TOKEN (an agent session token, or the admin token for admin_* verbs)');
  let client: Client;
  try {
    client = await connect(url, token);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(msg + String((e as { cause?: unknown }).cause ?? ''))) {
      throw new Error(`cannot reach Kolab at ${url}. Nothing is listening there: Kolab isn't running, or KONJIR_URL is wrong. Start it with \`konjir serve\`, or ask whoever runs it. Your work is safe; Kolab stores everything.`);
    }
    if (/401|invalid Konjir token|Unauthorized/i.test(msg)) {
      throw new Error(`the Kolab server at ${url} refused your token. It may have been revoked or mistyped; ask for a new session token.`);
    }
    throw e;
  }
  if (cmd === 'watch') {
    const once = rest.includes('--once');
    let finished = false;
    const done = new Promise<void>((resolve, reject) => {
      const finish = () => { finished = true; resolve(); };
      void watch(client, (uri, body) => {
        console.log(JSON.stringify({ updated: uri, ...(body as object) }));
        if (once) finish();
      }).then(async (w) => {
        if (!once) for (const uri of w.uris) console.log(JSON.stringify({ inbox: uri, ...(await w.read(uri)) }));
        void w.subscription.closed.then((how) => {
          if (!finished && how === 'remote') console.error('Kolab closed the subscription; run konjir watch again');
          finish();
        });
      }, (e: unknown) => {
        const reason = listenRefusal(e);
        if (reason === 'session_ended') reject(new Error(`the Kolab server at ${url} refused your token. It may have been revoked or mistyped; ask for a new session token.`));
        else if (reason) reject(new Error(`Kolab couldn't open your subscription just now (${reason}); run konjir watch again`));
        else reject(e);
      });
    });
    try {
      await done;
    } finally {
      await client.close();
    }
    return;
  }
  try {
    let result: unknown;
    // Shortcuts take a bare positional argument; with key=value or --json they
    // fall through to the generic form, so every verb accepts every form.
    const generic = rest.some((a) => a === '--json' || a.includes('='));
    switch (generic && ['resolve', 'read', 'stale', 'queries'].includes(cmd) ? '' : cmd) {
      case 'tools':
        result = (await client.listTools()).tools.map((t) => `${t.name.replace(/^konjir_/, '')}  — ${t.description}`).join('\n'); break;
      case 'help': {
        const name = toolName(rest[0]);
        const tool = (await client.listTools()).tools.find((t) => t.name === name);
        if (!tool) throw new Error(`no verb ${rest[0]}; run konjir tools`);
        const schema = tool.inputSchema as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[] };
        const params = Object.entries(schema.properties ?? {}).map(([k, p]) =>
          `  ${k}${schema.required?.includes(k) ? '' : ' (optional)'}: ${p.enum ? p.enum.join(' | ') : p.type ?? 'json'}${p.description ? ` — ${p.description}` : ''}`);
        result = [`konjir ${rest[0].replace(/^konjir_/, '')} key=value ...`, '', tool.description, '', params.length ? params.join('\n') : '  (no parameters)'].join('\n');
        break;
      }
      case 'instructions': {
        const p = await client.getPrompt({ name: 'konjir_operating_instructions' });
        result = p.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n'); break;
      }
      case 'resolve': result = await call(client, 'resolve', { address: rest[0] }); break;
      case 'read': result = await call(client, 'read_node', { node: rest[0], ...(rest[1] ? { version: Number(rest[1]) } : {}) }); break;
      case 'stale': result = await call(client, 'list_stale', { all_layers: rest[0] === 'all' }); break;
      case 'queries': result = await call(client, 'list_queries', { all_layers: rest[0] === 'all' }); break;
      default: {
        const verb = { stale: 'list_stale', queries: 'list_queries', read: 'read_node' }[cmd] ?? cmd;
        result = await call(client, verb, parseKv(rest));
      }
    }
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

/** A database URL fit to print: the password is left out. */
function withoutPassword(url: string) {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
