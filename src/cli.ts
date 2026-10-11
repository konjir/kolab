#!/usr/bin/env node
/**
 * konjir: the same verbs as the MCP server, for a shell or a harness without MCP.
 * It is an MCP client of the hub, so there is exactly one backend.
 *
 *   konjir serve [--port 7420] [--data .konjir] [--admin-token T]
 *   konjir tools
 *   konjir instructions
 *   konjir resolve <address>
 *   konjir read <node> [version]
 *   konjir stale [all]
 *   konjir queries [all]
 *   konjir <verb> [key=value ...]        -> calls konjir_<verb>; values are JSON if they parse
 *   konjir <verb> --json '{"key": ...}'
 *
 * Connection: KONJIR_URL (default http://127.0.0.1:7420/mcp) and KONJIR_TOKEN,
 * or --url / --token.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
import { startServer } from './server.js';
import { DEFAULT_REVIEW_MODEL, bedrockReviewer } from './review.js';
import type { Reviewer } from './hub.js';

export async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'konjir-cli', version: '0.2.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

/** Call a tool and return its structured result, or throw with the tool's error text. */
export async function call(client: Client, verb: string, args: Record<string, unknown> = {}) {
  const name = verb.startsWith('konjir_') ? verb : `konjir_${verb}`;
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  if (r.isError) throw new Error(text);
  return r.structuredContent ?? text;
}

const USAGE = `konjir — the Konjir hub from a shell. Same verbs as the MCP server.

  konjir instructions          the operating rules and precedent (read this first)
  konjir tools                 every verb, one line each
  konjir help <verb>           a verb's description and parameters
  konjir <verb> key=value ...  call a verb; values parse as JSON when they can,
                               e.g. elements='[{"id":"R1","text":"..."}]'
  konjir <verb> --json '{...}' the same, with all arguments as one JSON object

Shortcuts: konjir resolve <address> · konjir read <node> [version] · konjir stale [all] · konjir queries [all]
Addresses: kj:<node>[@<version>][#<element>][~q({"exact":"words"})]
Connection: KONJIR_URL (default http://127.0.0.1:7420/mcp) and KONJIR_TOKEN, or --url / --token.
Server: konjir serve [--port 7420] [--data .konjir] [--admin-token T] [--review structural|bedrock] [--public-host hub.example.com]
        KONJIR_REVIEW=bedrock uses KONJIR_REVIEW_MODEL (default ${DEFAULT_REVIEW_MODEL}) with the
        server's own AWS credentials (AWS_REGION, AWS_PROFILE or the default AWS chain).`;

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

async function main(argv: string[]) {
  const url = flag(argv, 'url') ?? process.env.KONJIR_URL ?? 'http://127.0.0.1:7420/mcp';
  const token = flag(argv, 'token') ?? process.env.KONJIR_TOKEN;
  const [cmd, ...rest] = argv;

  if (!cmd || ((cmd === 'help' || cmd === '--help') && !rest[0])) {
    console.log(USAGE); return;
  }

  if (cmd === 'serve') {
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
    const s = await startServer({ port, dataDir, adminToken, reviewer, publicHost });
    console.log(`konjir hub listening on ${s.url}`);
    console.log(`data: ${dataDir}`);
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
      throw new Error(`cannot reach the Konjir hub at ${url}. Nothing is listening there: the hub isn't running, or KONJIR_URL is wrong. Start it with \`konjir serve\`, or ask whoever runs it. Your work is safe; the hub stores everything.`);
    }
    if (/401|invalid Konjir token|Unauthorized/i.test(msg)) {
      throw new Error(`the hub at ${url} refused your token. It may have been revoked or mistyped; ask for a new session token.`);
    }
    throw e;
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
        const name = rest[0].startsWith('konjir_') ? rest[0] : `konjir_${rest[0]}`;
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/konjir')) {
  main(process.argv.slice(2)).catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
