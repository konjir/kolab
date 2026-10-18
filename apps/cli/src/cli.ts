/**
 * konjir: the same verbs as the MCP server, for a shell or a harness without MCP.
 * It is an MCP client of Kolab, so there is exactly one backend.
 *
 *   konjir serve [--port 7420] [--data .konjir] [--admin-token T]
 *                [--database-url postgres://…]
 *   konjir tools
 *   konjir instructions [reviewer]
 *   konjir resolve <address>
 *   konjir read <node> [version]
 *   konjir stale [all]
 *   konjir queries [all]
 *   konjir watch [--once]                -> print your inbox now and each time Kolab pushes a change
 *   konjir login [--kolab K] [--role R]  -> sign in with the browser (OAuth, D55); later commands use it
 *   konjir logout [--forget]
 *   konjir <verb> [key=value ...]        -> calls konjir_<verb>; values are JSON if they parse
 *   konjir <verb> --json '{"key": ...}'
 *
 * Connection: KONJIR_URL (default http://127.0.0.1:7420/mcp) and KONJIR_TOKEN, or --url / --token;
 * or, with no token, the sign-in `konjir login` keeps for that URL (W3.4).
 */
import { Client, StreamableHTTPClientTransport, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { randomBytes } from 'node:crypto';
// The roles a session works in (@konjir/types' ROLES), written out: the published client bundles nothing of Kolab's.
const ROLES = ['product', 'engineer'];
import { StoredLogin, credentialsPath, login, logout } from './login.js';

export { StoredLogin, credentialsPath, login, logout } from './login.js';

// The server, with NestJS and the database, is imported only by the
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

/**
 * Connects to Kolab with a bearer token, or with a sign-in (an OAuth client provider, such as the one
 * `konjir login` keeps), whose access token the MCP client refreshes by itself as it expires.
 */
export async function connect(url: string, auth: string | OAuthClientProvider): Promise<Client> {
  // 'auto' talks 2026-07-28 to a Kolab server that offers it (needed for subscriptions/listen) and 2025 to an older one.
  const client = new Client({ name: 'konjir-cli', version: '0.6.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), typeof auth === 'string'
    ? { requestInit: { headers: { Authorization: `Bearer ${auth}` } } }
    : { authProvider: auth, ...(auth instanceof StoredLogin ? { fetch: auth.fetch } : {}) }));
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
 * 'not_subscribable' that the stream asked for a resource outside its session's kolab, or
 * another actor's answers (D50), so ask konjir_whoami for the resources again; any other reason
 * ('gate_failed', 'gate_timeout', 'closed') is worth retrying.
 */
export function listenRefusal(e: unknown): string | undefined {
  const err = e as { code?: unknown; data?: { reason?: unknown } } | undefined;
  if (err?.code !== -32003) return undefined;
  return typeof err.data?.reason === 'string' ? err.data.reason : 'refused';
}

/**
 * Whether Kolab refused a call for the token's scope: HTTP 403 insufficient_scope, which the MCP
 * client raises as its InsufficientScopeError. Kolab requires a scope only of the admin verbs.
 */
const insufficientScope = (e: unknown) =>
  (e as { constructor?: { mcpBrand?: unknown } } | undefined)?.constructor?.mcpBrand === 'mcp.InsufficientScopeError';

/** The refusal for an agent session calling an admin verb, said plainly. */
const adminOnly = (verb: string) =>
  `${toolName(verb)} is an admin verb: only the admin token may call it, and this token is an agent session's. Ask whoever runs Kolab.`;

/** Call a tool and return its structured result, or throw with the tool's error text. */
export async function call(client: Client, verb: string, args: Record<string, unknown> = {}) {
  let r: Awaited<ReturnType<Client['callTool']>>;
  try {
    r = await client.callTool({ name: toolName(verb), arguments: args });
  } catch (e) {
    if (insufficientScope(e)) throw new Error(adminOnly(verb));
    throw e;
  }
  const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  if (r.isError) throw new Error(text);
  return r.structuredContent ?? text;
}

const usage = (canServe: boolean) => `konjir — Kolab from a shell. Same verbs as the MCP server.

  konjir instructions          the operating rules and precedent (read this first)
  konjir instructions reviewer how to review a version that waits for you
  konjir tools                 every verb, one line each
  konjir help <verb>           a verb's description and parameters
  konjir <verb> key=value ...  call a verb; values parse as JSON when they can,
                               e.g. elements='[{"id":"R1","text":"..."}]'
  konjir <verb> --json '{...}' the same, with all arguments as one JSON object

Shortcuts: konjir resolve <address> · konjir read <node> [version] · konjir stale [all] · konjir queries [all]
Push:      konjir watch prints your inbox, then a JSON line each time it changes (questions, notes,
           answers, marks, review requests and verdicts). konjir watch --once waits for the next change,
           prints it and exits.
Addresses: kj:[<kolab>/]<node>[@<version>][#<element>][~q({"exact":"words"})]; kj:<node> is a node in your kolab
Sign in:   konjir login [--kolab <name>] [--role product|engineer] signs in with your browser (GitHub, through
           Kolab): you choose who this CLI works as (an agent of yours, by default), the kolab and the role.
           Every later command uses that sign-in, renewing it by itself. konjir logout revokes it.
Connection: KONJIR_URL (default http://127.0.0.1:7420/mcp) and KONJIR_TOKEN, or --url / --token; with no
           token, the sign-in konjir login keeps for that URL.
Version:   konjir --version
${canServe ? `Server: konjir serve [--port 7420] [--data .konjir | --database-url postgres://…] [--admin-token T] [--public-host kolab.example.com]
        Kolab runs structural checks only and makes no model calls; reviewing agents review.
        Sign-in with GitHub (D55): KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET, a GitHub OAuth app's,
        whose callback is <origin>/oauth/callback/github. KONJIR_WEB_TOKEN_SIGN_IN=on keeps pasting a token in the
        web page (on by default without GitHub); KONJIR_HAND_ISSUED_TOKENS=off turns admin-issued session tokens off.` : `Server: this konjir is the client only. Kolab runs from a checkout of github.com/konjir/kolab.`}`;

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

/**
 * The review settings W1.7 retired (REV5). Kolab has no model reviewer, so a setting that asks for
 * one is refused, rather than leave the operator believing a gate runs that doesn't. The test
 * server's boot script still writes KONJIR_REVIEW=structural with KONJIR_REVIEW_MODEL beside it,
 * which asks for nothing and passes silently; a model named on its own is ignored, and said so.
 */
export function retiredReviewSettings(env: Record<string, string | undefined>, reviewFlag?: string): { refuse?: string; warn?: string } {
  const mode = reviewFlag ?? env.KONJIR_REVIEW;
  if (mode !== undefined && mode !== 'structural') {
    return { refuse: `review mode "${mode}" (${reviewFlag !== undefined ? '--review' : 'KONJIR_REVIEW'}) is no longer supported (W1.7): Kolab has no model reviewer. Its checks are structural, and agents review through konjir_review. Unset it, or set it to structural.` };
  }
  if (env.KONJIR_REVIEW_MODEL !== undefined && mode === undefined) {
    return { warn: `ignoring KONJIR_REVIEW_MODEL=${env.KONJIR_REVIEW_MODEL}: Kolab has no model reviewer any more (W1.7), so it calls no model. Unset it.` };
  }
  return {};
}

/** An on/off setting: on, off, or unset (undefined). Anything else is refused. */
function onOff(env: Record<string, string | undefined>, name: string): boolean | undefined {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return undefined;
  if (['on', '1', 'true', 'yes'].includes(v)) return true;
  if (['off', '0', 'false', 'no'].includes(v)) return false;
  throw new Error(`${name} is on or off`);
}

/**
 * How `konjir serve` signs people in (D55): with GitHub when KONJIR_GITHUB_CLIENT_ID and
 * KONJIR_GITHUB_CLIENT_SECRET are both set (one alone is refused); a pasted token in the web page
 * when KONJIR_WEB_TOKEN_SIGN_IN is on, or by default without GitHub; hand-issued session tokens
 * unless KONJIR_HAND_ISSUED_TOKENS is off. Never prints a secret.
 */
export function signInSettings(env: Record<string, string | undefined>) {
  const id = env.KONJIR_GITHUB_CLIENT_ID?.trim();
  const secret = env.KONJIR_GITHUB_CLIENT_SECRET?.trim();
  if (!!id !== !!secret) throw new Error('set both KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET for sign-in with GitHub, or neither');
  const github = !!id && !!secret;
  const webTokenSignIn = onOff(env, 'KONJIR_WEB_TOKEN_SIGN_IN') ?? !github;
  const handIssuedTokens = onOff(env, 'KONJIR_HAND_ISSUED_TOKENS') ?? true;
  return {
    github, webTokenSignIn, handIssuedTokens,
    describe: [github ? 'GitHub' : 'no identity provider (set KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET)',
      webTokenSignIn ? 'a pasted token in the web page' : '', handIssuedTokens ? 'hand-issued session tokens' : ''].filter(Boolean).join('; '),
    async identity(load: () => Promise<{ GitHubIdentity: new (c: { clientId: string; clientSecret: string }) => unknown }>) {
      if (!github) return {};
      const { GitHubIdentity } = await load();
      return { identity: new GitHubIdentity({ clientId: id!, clientSecret: secret! }) as never };
    },
  };
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
    const canServe = await server().then(() => true, (e: unknown) => { if (e instanceof ClientOnly) return false; throw e; });
    console.log(usage(canServe)); return;
  }

  if (cmd === 'serve') {
    const { startServer } = await server();
    const port = Number(flag(rest, 'port') ?? 7420);
    const dataDir = flag(rest, 'data') ?? '.konjir';
    const adminToken = flag(rest, 'admin-token') ?? process.env.KONJIR_ADMIN_TOKEN ?? randomBytes(18).toString('base64url');
    // Kolab makes no model calls (REV5): its checks are structural, and reviewing agents review.
    const retired = retiredReviewSettings(process.env, flag(rest, 'review'));
    if (retired.refuse) throw new Error(retired.refuse);
    if (retired.warn) console.error(`warning: ${retired.warn}`);
    console.log('review: Kolab\'s structural checks, then reviewing agents (konjir_review); Kolab makes no model calls');
    const publicHost = flag(rest, 'public-host') ?? process.env.KONJIR_PUBLIC_HOST;
    const databaseUrl = flag(rest, 'database-url') ?? process.env.KONJIR_DATABASE_URL;
    // How many kolabs a person may own when they make their own in the web interface (D54).
    const perPerson = process.env.KONJIR_KOLABS_PER_PERSON;
    const kolabsPerPerson = perPerson === undefined || perPerson === '' ? undefined : Number(perPerson);
    if (kolabsPerPerson !== undefined && !(Number.isInteger(kolabsPerPerson) && kolabsPerPerson >= 0)) throw new Error('KONJIR_KOLABS_PER_PERSON is a whole number');
    const sign = signInSettings(process.env);
    const s = await startServer({ port, dataDir, databaseUrl, adminToken, publicHost, kolabsPerPerson, ...(await sign.identity(server)), webTokenSignIn: sign.webTokenSignIn, handIssuedTokens: sign.handIssuedTokens });
    console.log(`sign-in: ${sign.describe}`);
    console.log(`Kolab listening on ${s.url}`);
    console.log(`data: ${databaseUrl ? withoutPassword(databaseUrl) : dataDir}`);
    if (!process.env.KONJIR_ADMIN_TOKEN && !rest.includes('--quiet')) console.log(`admin token: ${adminToken}`);
    const stop = async () => { await s.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'login') {
    const kolab = flag(rest, 'kolab');
    const role = flag(rest, 'role');
    if (role !== undefined && !ROLES.includes(role)) throw new Error(`--role is one of ${ROLES.join(', ')}`);
    if (kolab !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(kolab)) throw new Error('--kolab names a kolab: lowercase letters, digits and -');
    const scope = ['konjir', kolab && `kolab:${kolab}`, role && `role:${role}`].filter(Boolean).join(' ');
    let me;
    try {
      me = await login(url, { scope });
    } catch (e) {
      throw unreachable(e, url) ?? e;
    }
    console.log(`Signed in to ${url} as ${me.actor}${me.kind === 'agent' ? ` (an agent of ${me.owner}'s)` : ''}, in kolab ${me.kolab} as ${me.role}.`);
    console.log(`Kept in ${credentialsPath()}; every konjir command now uses it. Start with: konjir instructions`);
    return;
  }
  if (cmd === 'logout') {
    const r = await logout(url, { forget: rest.includes('--forget') });
    console.log(!r.had ? `No sign-in kept for ${url}.`
      : r.revoked ? `Signed out of ${url}: the sign-in is revoked and forgotten.`
        : `Forgotten, but not revoked at ${url}: it lapses within 30 days unused, or an admin can end it.`);
    return;
  }

  const stored = token ? undefined : new StoredLogin(url);
  if (!token && !stored!.signedIn) throw new Error('set KONJIR_TOKEN (an agent session token, or the admin token for admin_* verbs), or run konjir login to sign in with your browser');
  let client: Client;
  try {
    client = await connect(url, token ?? stored!);
  } catch (e) {
    // An error that escaped the SDK's sign-in flow mid-refresh must not leave other konjir waiting on the lock.
    stored?.releaseLock();
    const msg = String((e as Error).message ?? e);
    const far = unreachable(e, url);
    if (far) throw far;
    if (stored && /401|invalid Konjir token|Unauthorized|run konjir login/i.test(msg)) {
      throw new Error(`your sign-in to ${url} has ended or was revoked: run konjir login`);
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
      // Listening again backs off when streams keep closing at once: 1 s, doubling to 30 s, reset by a stream that lasted a minute.
      let retries = 0;
      let opened = Date.now();
      const subscribe = (first: boolean) => void watch(client, (uri, body) => {
        console.log(JSON.stringify({ updated: uri, ...(body as object) }));
        if (once) finish();
      }).then(async (w) => {
        opened = Date.now();
        if (!once && first) for (const uri of w.uris) console.log(JSON.stringify({ inbox: uri, ...(await w.read(uri)) }));
        void w.subscription.closed.then((how) => {
          // A stream lives as long as its access token (D55): with a sign-in, listen again, which refreshes it.
          if (!finished && how === 'remote' && stored) {
            retries = Date.now() - opened > 60_000 ? 0 : retries + 1;
            setTimeout(() => { if (!finished) subscribe(false); }, retries ? Math.min(30_000, 1000 * 2 ** (retries - 1)) : 0);
            return;
          }
          if (!finished && how === 'remote') console.error('Kolab closed the subscription; run konjir watch again');
          finish();
        });
      }, (e: unknown) => {
        stored?.releaseLock();
        const reason = listenRefusal(e);
        if (reason === 'session_ended') {
          reject(new Error(stored ? `your sign-in to ${url} has ended or was revoked: run konjir login`
            : `the Kolab server at ${url} refused your token. It may have been revoked or mistyped; ask for a new session token.`));
        }
        else if (reason === 'not_subscribable') reject(new Error('Kolab refused to subscribe you to those resources: a session can subscribe only to its own kolab\'s inboxes and its own answers there. Run konjir watch again, which asks konjir_whoami for them afresh'));
        else if (reason) reject(new Error(`Kolab couldn't open your subscription just now (${reason}); run konjir watch again`));
        else reject(e);
      });
      subscribe(true);
    });
    try {
      await done;
    } finally {
      stored?.releaseLock();
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
        // An agent session doesn't see the admin verbs (toolVisibility 'authorized').
        if (!tool) throw new Error(`no verb ${rest[0]}${name.startsWith('konjir_admin_') ? ' for this token: the admin verbs are for the admin token only' : ''}; run konjir tools`);
        const schema = tool.inputSchema as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[] };
        const params = Object.entries(schema.properties ?? {}).map(([k, p]) =>
          `  ${k}${schema.required?.includes(k) ? '' : ' (optional)'}: ${p.enum ? p.enum.join(' | ') : p.type ?? 'json'}${p.description ? ` — ${p.description}` : ''}`);
        result = [`konjir ${rest[0].replace(/^konjir_/, '')} key=value ...`, '', tool.description, '', params.length ? params.join('\n') : '  (no parameters)'].join('\n');
        break;
      }
      case 'instructions': {
        if (rest[0] !== undefined && rest[0] !== 'reviewer') throw new Error(`konjir instructions [reviewer]: no instructions "${rest[0]}"`);
        const p = await client.getPrompt({ name: rest[0] === 'reviewer' ? 'konjir_reviewer_instructions' : 'konjir_operating_instructions' });
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
    stored?.releaseLock();
    await client.close();
  }
}

/** The error for a Kolab that isn't there, or undefined for any other failure. */
function unreachable(e: unknown, url: string): Error | undefined {
  const msg = String((e as Error).message ?? e);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(msg + String((e as { cause?: unknown }).cause ?? ''))) {
    return new Error(`cannot reach Kolab at ${url}. Nothing is listening there: Kolab isn't running, or KONJIR_URL is wrong. Start it with \`konjir serve\`, or ask whoever runs it. Your work is safe; Kolab stores everything.`);
  }
  return undefined;
}

/** A database URL fit to print: the password is left out. */
function withoutPassword(url: string) {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
