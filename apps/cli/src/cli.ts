/**
 * konjir: the same verbs as the MCP server, for a shell or a harness without MCP.
 * It is an MCP client of Kolab, so there is exactly one backend.
 *
 *   konjir serve [--port 7420] [--data .konjir] [--admin-token T]
 *                [--database-url postgres://…] [--no-migrate] [--no-worker]
 *   konjir tools
 *   konjir instructions [reviewer]
 *   konjir resolve <address>
 *   konjir read <node> [version]
 *   konjir stale [all]
 *   konjir queries [all]
 *   konjir watch [--once]                -> print your inbox now and each time Kolab pushes a change
 *   konjir login [--kolab K] [--role R] [--agent A] -> sign in with the browser (OAuth, D55); later commands use it
 *   konjir logout [--forget]
 *   konjir connect opencode|claude [--kolab K] [--agent label[:role]]… [--global] [--force] [--yes] [--no-auth] [--http]
 *                                        -> one MCP entry per agent of yours in the harness's config (W3.7, D59);
 *                                           for Claude Code, the Konjir channel bridge (W3.8, D61), or with --http its HTTP entry
 *   konjir repo register [--binding B] [--url U] [--root SHA] [-C dir]
 *                                        -> registers this checkout's repository, as a person with Maintain (W5.2a, D98)
 *   konjir work deliver [<work>] [--submit] [--pr URL] [--test URL|summary]… [--note T] [--since REV] [--repo URL] [--dry-run] [-C dir]
 *                                        -> records the commits carrying the package's Konjir-Work trailer (W5.2a, D98)
 *   konjir work [--jobs 4] [--once] [--machine M] [--allow-all] [--harness CMD] [--repo URL] [-C dir]
 *                                        -> sets this machine to work: takes jobs from Kolab and runs one headless
 *                                           Claude Code per job, in its own worktree (W5.4b, D103)
 *   konjir status [--json]               -> the kolab's queue, its live jobs and your room under the caps (W5.4b)
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
import { MemoryLogin, StoredLogin, credentialsPath, ephemeralLogin, login, logout } from './login.js';
import { deliverWork, gitIn, registerRepository } from './deliver.js';
import { ToolRefusal, formatStatus, runWork, workStatus } from './work.js';
import { ASK_AGAIN, CHANNEL_CLIENT_NAME, HARNESSES, WrongAgentError, connectHarness, entryScope, mcpUrl, parseAgents, terminalIO, type Entry, type Harness, type PersonSession } from './connect.js';

export { StoredLogin, agentCredentials, agentCredentialsPath, credentialsPath, login, logout } from './login.js';
export { canonicalRemote, checkoutRepository, deliverWork, gitIn, readCheckout, registerRepository, taggedCommits, type Git } from './deliver.js';
export { ALLOWED_TOOLS, Redactor, ToolRefusal, deniedTools, formatStatus, harnessCommand, harnessEnv, heartbeatEvery, leaseLeft, runWork, workStatus, type JobReport, type TakenJob } from './work.js';
export { ASK_AGAIN, WrongAgentError, connectHarness, mergeClaude, mergeOpencode, parseAgents, unifiedDiff, writeAtomically, type ConnectIO } from './connect.js';

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
  // An error the SDK reports only here lets go of a leaked hold, never of a refresh still in flight
  // (that would let another konjir refresh with the same token, and undo the compare-and-swap).
  if (auth instanceof StoredLogin) client.onerror = () => auth.releaseIdleLock();
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
  // One notification at a time, in the order they came: each is read only after the one before it
  // was read and handed on, so a read started early can't finish late and leave an older inbox as
  // the last one shown. One that fails is still reported to the client, and the next goes on.
  let queue: Promise<void> = Promise.resolve();
  client.setNotificationHandler('notifications/resources/updated', (n) => {
    const turn = queue.then(async () => { await onUpdate(n.params.uri, await read(n.params.uri)); });
    queue = turn.catch(() => undefined);
    return turn;
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
  `${toolName(verb)} is an admin verb: only a Konjir admin's own session, raised in their browser (konjir admin_elevate), or the break-glass token may call it, and this session isn't raised. Ask a Konjir admin.`;

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
  // A refusal is Kolab's own answer, told apart from a call that never reached it (konjir work's heartbeat, M1).
  if (r.isError) throw new ToolRefusal(text);
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
Build:     the loop for an engineer (konjir instructions has it step by step): konjir pull_work, then konjir read_work
           work=kj:<binding>#<id> for its done-when, what it serves and its trailer; build and test it in a checkout of
           its repository; git commit --trailer "Konjir-Work: kj:<kolab>/<binding>#<id>"; push and open a pull request if
           you can; konjir work deliver <work> --submit. Another engineer checks the evidence and runs konjir review
           work=<work> verdict=approve (or request_changes note=…). Ask about an unclear element (konjir ask), open a case
           file when the spec can't be met as written (konjir open_case), never patch around it. A Done package at risk:
           konjir clear_mark mark=… if the work holds, else konjir reopen_work work=… note=….
Git:      konjir work deliver [<work>] [--submit] [--pr <url>] [--test <url|summary>]… [--note <text>] [--since <rev>]
           [--repo <url>] [--dry-run] [-C <dir>], in a checkout: finds the commits whose trailer is the package's
           (Konjir-Work: kj:<kolab>/<binding>#<id>, from pull_work or read_work), checks the checkout is the registered
           repository (its root commit and a remote), and records them as evidence; --submit submits the package.
           Run again, it records only what is new. Kolab itself never reads git.
           konjir repo register [--binding <binding>] [--url <url>] [--root <sha>] [-C <dir>], in a checkout, as a
           person with Maintain or Admin (never an agent): registers its repository, pinned by its root commit.
Work:      konjir work [--jobs <n>] [--once] [--machine <label>] [--allow-all] [--harness <cmd>] [--repo <url>] [-C <dir>],
           signed in as yourself, in a checkout of the kolab's registered repository: sets this machine to work. It takes
           jobs from Kolab (a review, then a ready work package), up to --jobs at once (4; Kolab caps you at 4 and the
           kolab at 8), each done by one of your pool agents in its own git worktree at the default branch's head
           (under ~/.konjir/jobs), by Claude Code run headless on your own model account, with Kolab as its one MCP
           server and only edits, git, npm, npx, gh and konjir allowed (--allow-all: every permission). A job never
           merges or deploys. It renews each job's lease, ends the job when its harness exits, keeps a worktree with
           work not pushed, and waits while nothing is ready; Ctrl-C (or SIGTERM, SIGHUP) stops every job and gives
           back what it held, and a second Ctrl-C kills them at once. --once takes one round and exits. --machine
           names this machine (its hostname); --harness (or KONJIR_HARNESS) runs another command in Claude Code's
           place, split on spaces (no quoting). macOS and Linux only, not Windows yet.
           konjir status [--json]: the kolab's queue by kind, its live jobs (person, machine, agent, item, since) and
           your room under the caps.
Pages:     every list (and a long read) returns a page and next; while next isn't null, call it again with
           cursor=<next>, e.g. konjir list_queries cursor=… (limit=<n> sets the page, at most 200)
Push:      konjir watch prints your inbox, then a JSON line each time it changes (questions, notes,
           answers, marks, review requests and verdicts). konjir watch --once waits for the next change,
           prints it and exits.
Addresses: kj:[<kolab>/]<node>[@<version>][#<element>][~q({"exact":"words"})]; kj:<node> is a node in your kolab
Sign in:   konjir login [--kolab <name>] [--role product|engineer] [--agent <agent>] signs in with your browser
           (GitHub, through Kolab): you choose who this CLI works as (an agent of yours, by default; --agent
           preselects one, and refuses a sign-in as anyone else), the kolab and the role.
           Every later command uses that sign-in, renewing it by itself. konjir logout revokes it.
Harnesses: konjir connect opencode|claude [--kolab <k>] [--agent <label>[:<role>]]… [--global] [--force] [--yes]
           [--no-auth] [--http] connects a harness to a kolab, one agent per entry (by default product and engineer):
           it makes or reuses your agents <you>-<label> (signed in as yourself for a moment, in memory only, then
           revoked: on Kolab's page, choose Yourself by hand), shows the change to opencode.json or .mcp.json (with --global, your own settings) and asks
           first, then signs each entry in as its agent. --force replaces konjir-<label> entries already there;
           --force-path writes a config file that links outside the project. For Claude Code each entry is the
           Konjir channel (from this checkout): Kolab's tools and the inbox pushed into the session, on one sign-in;
           --http writes Claude Code's plain HTTP entry instead, with no channel.
Connection: KONJIR_URL (default http://127.0.0.1:7420/mcp) and KONJIR_TOKEN, or --url / --token; with no
           token, the sign-in konjir login keeps for that URL.
Version:   konjir --version
${canServe ? `Server: konjir serve [--port 7420] [--data .konjir | --database-url postgres://…] [--admin-token T|off] [--public-host kolab.example.com]
        Kolab runs structural checks only and makes no model calls; reviewing agents review.
        --no-migrate applies no migration (a database that needs one is refused) and --no-worker runs no
        outbox jobs, so a restored database can be checked without changing it (deploy/RECOVERY.md).
        The admin token (or KONJIR_ADMIN_TOKEN) is a break-glass only: Konjir's admins are people who sign in, run
        konjir admin_elevate and confirm the raise in their browser (W2.22). off disables it.
        Sign-in with GitHub (D55): KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET, a GitHub OAuth app's,
        whose callback is <origin>/oauth/callback/github. KONJIR_WEB_TOKEN_SIGN_IN=on keeps pasting a token in the
        web page (on by default without GitHub); KONJIR_HAND_ISSUED_TOKENS=off turns admin-issued session tokens off;
        they last KONJIR_HAND_ISSUED_TOKEN_DAYS (30 by default).
        KONJIR_CLI_NPM_SPEC=konjir@<version> (an exact version, once published) lets the web page show npx <spec>.` : `Server: this konjir is the client only. Kolab runs from a checkout of github.com/konjir/kolab.`}`;

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

/** The shortest break-glass admin token a Kolab behind a public host starts with (W2.22): rotate-admin-token writes 44 characters. */
export const BREAK_GLASS_MIN_LENGTH = 32;

/**
 * The break-glass admin token `konjir serve` runs with (W2.22, D69), from --admin-token or
 * KONJIR_ADMIN_TOKEN: null when it says `off`, in any case and with any surrounding whitespace,
 * so a hand-written `Off` disables it rather than becoming a guessable token. Undefined when none
 * was given. Refused if it holds whitespace, and, behind a public host, if it is shorter than
 * BREAK_GLASS_MIN_LENGTH; a local Kolab (tests, the demo) may use a short one.
 */
export function breakGlassToken(given: string | undefined, opts: { publicHost?: string } = {}): string | null | undefined {
  if (given === undefined) return undefined;
  if (given.trim().toLowerCase() === 'off') return null;
  if (!given.trim()) throw new Error('KONJIR_ADMIN_TOKEN is empty: set a break-glass token, or off to disable it');
  if (/\s/.test(given)) throw new Error('KONJIR_ADMIN_TOKEN holds whitespace: write the token alone, or off to disable it');
  if (opts.publicHost && given.length < BREAK_GLASS_MIN_LENGTH) {
    throw new Error(`KONJIR_ADMIN_TOKEN is too short for a Kolab on a public host: at least ${BREAK_GLASS_MIN_LENGTH} characters (deploy/konjir-ops.sh rotate-admin-token writes one), or off to disable it`);
  }
  return given;
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

/**
 * The session token the CLI is given: --token, else KONJIR_TOKEN. An empty or blank one is unset,
 * so the sign-in konjir login keeps is used: `konjir connect claude` writes KONJIR_TOKEN as "" in
 * .mcp.json, and those settings copied into a shell must not send an empty bearer token. A flag
 * beats the environment: a blank --token means no token, even with KONJIR_TOKEN exported.
 */
export function sessionToken(given: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  return given !== undefined ? given.trim() || undefined : env.KONJIR_TOKEN?.trim() || undefined;
}

export async function main(argv: string[]) {
  const url = flag(argv, 'url') ?? process.env.KONJIR_URL ?? 'http://127.0.0.1:7420/mcp';
  const token = sessionToken(flag(argv, 'token'));
  const [cmd, ...rest] = argv;
  // Inside a Konjir job (W5.4b) konjir works as the job's agent, with KONJIR_TOKEN, and never with a
  // sign-in kept on this machine: the person's is theirs, not the job's.
  if (process.env.KONJIR_JOB?.trim() && cmd && cmd !== '--version' && !((cmd === 'help' || cmd === '--help') && !rest[0])) {
    if (['login', 'logout', 'connect', 'serve'].includes(cmd) || (cmd === 'work' && rest[0] !== 'deliver')) {
      throw new Error(`konjir ${cmd} doesn't run inside a Konjir job (KONJIR_JOB is set): a job works as its agent, with the token it was given`);
    }
    if (!token) throw new Error('this is a Konjir job (KONJIR_JOB is set), which works as its agent with KONJIR_TOKEN, never with a sign-in kept on this machine, and KONJIR_TOKEN is unset or empty');
  }

  if (cmd === '--version') {
    console.log(typeof KONJIR_VERSION === 'string' ? KONJIR_VERSION : 'development (run from source)'); return;
  }

  if (!cmd || ((cmd === 'help' || cmd === '--help') && !rest[0])) {
    // Without the server (the published client), help leaves out serve.
    const canServe = await server().then(() => true, (e: unknown) => { if (e instanceof ClientOnly) return false; throw e; });
    console.log(usage(canServe)); return;
  }

  if (cmd === 'serve') {
    // Kolab's own lines are JSON, one object per line (P11, D68), from the server's logger: the
    // CLI bundle never inlines the server's code (D63), so it reaches it through the server it loads.
    const { startServer, log } = await server();
    const port = Number(flag(rest, 'port') ?? 7420);
    const dataDir = flag(rest, 'data') ?? '.konjir';
    // The break-glass admin token (W2.22, D69): `off` disables it, leaving Konjir's admins, people
    // who sign in, alone; unset, a local Kolab makes one and prints it.
    const givenToken = flag(rest, 'admin-token') ?? process.env.KONJIR_ADMIN_TOKEN;
    const publicHost = flag(rest, 'public-host') ?? process.env.KONJIR_PUBLIC_HOST;
    const adminToken = breakGlassToken(givenToken, { publicHost }) ?? (givenToken === undefined ? randomBytes(18).toString('base64url') : null);
    // Kolab makes no model calls (REV5): its checks are structural, and reviewing agents review.
    const retired = retiredReviewSettings(process.env, flag(rest, 'review'));
    if (retired.refuse) throw new Error(retired.refuse);
    if (retired.warn) log.warn(retired.warn);
    log.info('review: Kolab\'s structural checks, then reviewing agents (konjir_review); Kolab makes no model calls');
    const databaseUrl = flag(rest, 'database-url') ?? process.env.KONJIR_DATABASE_URL;
    // How many kolabs a person may own when they make their own in the web interface (D54).
    const perPerson = process.env.KONJIR_KOLABS_PER_PERSON;
    const kolabsPerPerson = perPerson === undefined || perPerson === '' ? undefined : Number(perPerson);
    if (kolabsPerPerson !== undefined && !(Number.isInteger(kolabsPerPerson) && kolabsPerPerson >= 0)) throw new Error('KONJIR_KOLABS_PER_PERSON is a whole number');
    // How long a hand-issued session token lasts (W2.22): 30 days unless this says otherwise.
    const days = process.env.KONJIR_HAND_ISSUED_TOKEN_DAYS;
    const handIssuedTokenDays = days === undefined || days === '' ? undefined : Number(days);
    if (handIssuedTokenDays !== undefined && !(handIssuedTokenDays > 0 && handIssuedTokenDays <= 365)) throw new Error('KONJIR_HAND_ISSUED_TOKEN_DAYS is a number of days, more than 0 and at most 365');
    const sign = signInSettings(process.env);
    // The published konjir CLI, pinned (W3.7): the web page shows `npx <spec>` only when this is set.
    const cliNpmSpec = process.env.KONJIR_CLI_NPM_SPEC?.trim() || undefined;
    // A restore's smoke check (W2.24) opens the restored database without changing it: no
    // migration (a database that needs one is refused) and no outbox worker.
    const migrate = !rest.includes('--no-migrate');
    const worker = !rest.includes('--no-worker');
    const s = await startServer({ port, dataDir, databaseUrl, adminToken, publicHost, kolabsPerPerson, handIssuedTokenDays, ...(await sign.identity(server)), webTokenSignIn: sign.webTokenSignIn, handIssuedTokens: sign.handIssuedTokens, cliNpmSpec, migrate, worker });
    if (!migrate) log.warn('migrations: checked, none applied (--no-migrate); a release with a new migration refuses to start');
    if (!worker) log.warn('outbox: no worker (--no-worker); no after_commit, settle or rebase job is claimed or run');
    log.info(`sign-in: ${sign.describe}`);
    log.info(`Kolab listening on ${s.url}`, { event: 'listening', url: s.url });
    log.info(`data: ${databaseUrl ? withoutPassword(databaseUrl) : dataDir}`);
    // Not a log line: the generated admin token, shown once to whoever started a local Kolab by
    // hand. A deployed Kolab is given its token (KONJIR_ADMIN_TOKEN) and runs with --quiet.
    if (!givenToken && !rest.includes('--quiet')) console.log(`admin token: ${adminToken}`);
    if (!adminToken) log.warn('the break-glass admin token is disabled: only Konjir admins, signed in as themselves, run the admin verbs', { event: 'break_glass_disabled' });
    const stop = async () => { await s.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'connect') {
    const harness = rest.shift();
    if (!HARNESSES.includes(harness as Harness)) throw new Error(`konjir connect ${HARNESSES.join('|')} [--kolab <k>] [--agent <label>[:<role>]]… [--global] [--force] [--force-path] [--yes] [--no-auth] [--http] [--url <kolab>]`);
    const kolab = flag(rest, 'kolab');
    const agents: string[] = [];
    for (let a = flag(rest, 'agent'); a !== undefined; a = flag(rest, 'agent')) agents.push(a);
    const on = (name: string) => { const i = rest.indexOf(`--${name}`); if (i >= 0) rest.splice(i, 1); return i >= 0; };
    const opts = { global: on('global'), force: on('force'), forcePath: on('force-path'), yes: on('yes'), auth: !on('no-auth'), http: on('http') };
    if (rest.length) throw new Error(`konjir connect: unknown ${rest.join(' ')}`);
    const mcp = mcpUrl(url);
    await connectHarness({ harness: harness as Harness, url: mcp, kolab, agents: parseAgents(agents), cwd: process.cwd(), env: process.env, ...opts },
      terminalIO(() => personSession(mcp, token, { kolab }), (e, credentials, step) => signInAgent(e, credentials, step ? { step } : {})));
    return;
  }

  if (cmd === 'login') {
    const kolab = flag(rest, 'kolab');
    const role = flag(rest, 'role');
    const agent = flag(rest, 'agent');
    if (role !== undefined && !ROLES.includes(role)) throw new Error(`--role is one of ${ROLES.join(', ')}`);
    if (kolab !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(kolab)) throw new Error('--kolab names a kolab: lowercase letters, digits and -');
    if (agent !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent)) throw new Error('--agent names an agent of yours, such as ann-product: lowercase letters, digits and -');
    const scope = ['konjir', kolab && `kolab:${kolab}`, role && `role:${role}`, agent && `agent:${agent}`].filter(Boolean).join(' ');
    const me = await loginAs(url, scope, agent);
    console.log(`Signed in to ${url} as ${me.actor}${me.kind === 'agent' ? ` (an agent of ${me.owner}'s)` : ''}, in kolab ${me.kolab} as ${me.role}.`);
    console.log(`Kept in ${credentialsPath()}; every konjir command now uses it. Start with: konjir instructions`);
    return;
  }
  if (cmd === 'logout') {
    const r = await logout(url, { forget: rest.includes('--forget') });
    console.log(!r.had ? `No sign-in kept for ${url}.`
      : r.revoked ? `Signed out of ${url}: the sign-in is revoked and forgotten.`
        : `Forgotten, but not revoked at ${url}${r.why ? ` (${r.why})` : ''}: it lapses within 30 days unused, or an admin can end it.`);
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
          stored?.releaseIdleLock();   // never a refresh another request still has in flight
          // A stream lives as long as its access token (D55), and Kolab closes it gracefully once that
          // expires or rotates: with a sign-in, listen again on any close but our own, which refreshes it
          // (or finds the sign-in ended, and says so).
          if (!finished && how !== 'local' && stored) {
            retries = Date.now() - opened > 60_000 ? 0 : retries + 1;
            setTimeout(() => { if (!finished) subscribe(false); }, retries ? Math.min(30_000, 1000 * 2 ** (retries - 1)) : 0);
            return;
          }
          if (!finished && how === 'remote') console.error('Kolab closed the subscription; run konjir watch again');
          finish();
        });
      }, (e: unknown) => {
        stored?.releaseIdleLock();
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
  if (cmd === 'work' && rest[0] !== 'deliver') {
    const stop = new AbortController();
    const processes = new Set<number>();
    let signals = 0;
    const onSignal = () => {
      // The first stops every job and ends it as stopped; a second kills every harness's process
      // group at once, so none outlives konjir with its job live, and leaves.
      if (signals++) {
        for (const pid of processes) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
        process.exit(130);
      }
      console.error('konjir work: stopping every job (Ctrl-C again to kill them and leave at once)');
      stop.abort();
    };
    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    for (const sig of SIGNALS) process.on(sig, onSignal);
    let done = false;
    try {
      const args = [...rest];
      const at = args.indexOf('-C');
      const dir = at >= 0 ? args.splice(at, 2)[1] : process.cwd();
      if (dir === undefined) throw new Error('-C names a directory');
      const on = (name: string) => { const i = args.indexOf(`--${name}`); if (i >= 0) args.splice(i, 1); return i >= 0; };
      const jobs = flag(args, 'jobs');
      const opts = { once: on('once'), allowAll: on('allow-all'), machine: flag(args, 'machine'), harness: flag(args, 'harness'), repo: flag(args, 'repo'),
        ...(jobs !== undefined ? { jobs: Number(jobs) } : {}) };
      if (args.length) throw new Error(`konjir work [--jobs <n>] [--once] [--machine <label>] [--allow-all] [--harness <cmd>] [--repo <url>] [-C <dir>]: unknown ${args.join(' ')}`);
      const callIt = (verb: string, a: Record<string, unknown>) => call(client, verb, a);
      // The person's inbox changing (a review requested, say) looks for work at once, listening again
      // whenever its stream closes, after a minute if it couldn't open; polling covers the rest.
      const pushed = (wake: () => void) => {
        const subscribe = () => {
          if (done) return;
          watch(client, () => wake()).then((w) => {
            void w.subscription.closed.then(() => { stored?.releaseIdleLock(); if (!done) setTimeout(subscribe, 5_000).unref(); });
          }, () => { stored?.releaseIdleLock(); if (!done) setTimeout(subscribe, 60_000).unref(); });
        };
        subscribe();
      };
      const reports = await runWork({ call: callIt, git: gitIn(dir), signal: stop.signal, jobsDir: process.env.KONJIR_JOBS_DIR || undefined, pushed, processes }, { ...opts, url });
      console.log(JSON.stringify(reports, null, 2));
    } finally {
      done = true;
      for (const sig of SIGNALS) process.off(sig, onSignal);
      stored?.releaseLock();
      await client.close();
    }
    return;
  }
  if (cmd === 'status') {
    try {
      const json = rest.includes('--json');
      if (rest.some((a) => a !== '--json')) throw new Error(`konjir status [--json]: unknown ${rest.filter((a) => a !== '--json').join(' ')}`);
      const s = await workStatus((verb, a) => call(client, verb, a));
      console.log(json ? JSON.stringify(s, null, 2) : formatStatus(s));
    } finally {
      stored?.releaseLock();
      await client.close();
    }
    return;
  }
  if ((cmd === 'work' && rest[0] === 'deliver') || (cmd === 'repo' && rest[0] === 'register')) {
    try {
      const args = rest.slice(1);
      const at = args.indexOf('-C');
      const dir = at >= 0 ? args.splice(at, 2)[1] : process.cwd();
      if (dir === undefined) throw new Error('-C names a directory');
      const git = gitIn(dir);
      const callIt = (verb: string, a: Record<string, unknown>) => call(client, verb, a);
      let result: unknown;
      if (cmd === 'repo') {
        const opts = { binding: flag(args, 'binding'), url: flag(args, 'url'), root: flag(args, 'root') };
        if (args.length) throw new Error(`konjir repo register [--binding <binding>] [--url <url>] [--root <sha>] [-C <dir>]: unknown ${args.join(' ')}`);
        result = await registerRepository(callIt, git, opts);
      } else {
        const on = (name: string) => { const i = args.indexOf(`--${name}`); if (i >= 0) args.splice(i, 1); return i >= 0; };
        const tests: string[] = [];
        for (let t = flag(args, 'test'); t !== undefined; t = flag(args, 'test')) tests.push(t);
        const opts = { submit: on('submit'), dryRun: on('dry-run'), pr: flag(args, 'pr'), note: flag(args, 'note'), since: flag(args, 'since'), repo: flag(args, 'repo'), tests };
        const work = args[0] !== undefined && !args[0].startsWith('-') ? args.shift() : undefined;
        if (args.length) throw new Error(`konjir work deliver [<work>] [--submit] [--pr <url>] [--test <url|summary>]… [--note <text>] [--since <rev>] [--repo <url>] [--dry-run] [-C <dir>]: unknown ${args.join(' ')}`);
        result = await deliverWork(callIt, git, { work, ...opts });
      }
      console.log(JSON.stringify(result, null, 2));
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
    switch (generic && ['resolve', 'read', 'stale', 'queries', 'instructions'].includes(cmd) ? '' : cmd) {
      case 'tools':
        result = (await client.listTools()).tools.map((t) => `${t.name.replace(/^konjir_/, '')}  — ${t.description}`).join('\n'); break;
      case 'help': {
        const name = toolName(rest[0]);
        const tool = (await client.listTools()).tools.find((t) => t.name === name);
        // An agent session doesn't see the admin verbs (toolVisibility 'authorized').
        if (!tool) throw new Error(`no verb ${rest[0]}${name.startsWith('konjir_admin_') ? ' for this token: the admin verbs are for a Konjir admin\'s own session, raised in their browser (konjir admin_elevate), or the break-glass token' : ''}; run konjir tools`);
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

/**
 * The CLI signed in as the person, for `konjir connect` (D59), never kept: `token` if one is given;
 * or the sign-in `konjir login` keeps for `url`, but only if it already works as the person, and
 * then it is left as it is; otherwise a sign-in in memory alone (ephemeralLogin, preselecting the
 * kolab on Kolab's page; the person chooses Yourself there by hand, since no client may preselect
 * it, D60), revoked on close(), or at once if the person chose anyone else. A kept sign-in that works as an
 * agent stays kept, untouched. So connect never leaves an uncapped sign-in as the person on disk.
 * `open` is how the browser is sent there (tests).
 */
export async function personSession(url: string, token: string | undefined, opts: { kolab?: string; open?: (u: URL) => void | Promise<void>; path?: string; log?: (line: string) => void } = {}): Promise<PersonSession> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const open = async (auth: string | OAuthClientProvider) => {
    let client: Client;
    try { client = await connect(url, auth); } catch (e) { if (auth instanceof StoredLogin) auth.releaseIdleLock(); throw unreachable(e, url) ?? e; }
    try {
      return { client, me: await call(client, 'whoami') as PersonSession['me'] };
    } catch (e) {
      if (auth instanceof StoredLogin) auth.releaseIdleLock();
      await client.close();
      throw e;
    }
  };
  if (token) {
    const { client, me } = await open(token);
    return { me, call: (verb, args) => call(client, verb, args), close: () => client.close() };
  }
  const stored = new StoredLogin(url, { path: opts.path });
  if (stored.signedIn) {
    const s = await open(stored).catch(() => undefined);
    if (s?.me.kind === 'person') {
      return { me: s.me, call: (verb, args) => call(s.client, verb, args), close: async () => { stored.releaseIdleLock(); await s.client.close(); } };
    }
    if (s) { stored.releaseIdleLock(); await s.client.close(); }
  }
  log(`Signing you in as yourself for a moment, only to make your agents. On Kolab's page, under "Work as", choose "Yourself" by hand: it isn't chosen for you. konjir keeps none of it, and revokes it once they are made.`);
  let memory: MemoryLogin;
  try {
    memory = await ephemeralLogin(url, { scope: ['konjir', opts.kolab && `kolab:${opts.kolab}`].filter(Boolean).join(' '), open: opts.open, log });
  } catch (e) {
    throw unreachable(e, url) ?? e;
  }
  const end = async () => {
    await memory.revoke(url).then(() => log('Revoked the sign-in as you.'),
      (e: Error) => log(`warning: the sign-in as you wasn't revoked (${e.message}); konjir kept none of it, and it lapses within 30 days unused.`));
  };
  let s;
  try { s = await open(memory); } catch (e) { await end(); throw e; }
  if (s.me.kind !== 'person') {
    await s.client.close();
    await end();
    throw new Error(`on Kolab's page you chose ${s.me.actor}, not Yourself, and konjir connect makes your agents as you. Run it again, and under "Work as" choose "Yourself"`);
  }
  return { me: s.me, call: (verb, args) => call(s.client, verb, args), close: async () => { await s.client.close(); await end(); } };
}

/**
 * `konjir login`: signs in with the browser and keeps it. With `agent` (--agent), a sign-in that
 * comes back as anyone else is forgotten, never kept, and revoked; once revoked, the same agent is
 * asked for again at once, at most ASK_AGAIN times (D97). One that couldn't be revoked stops it
 * there, so no grant left standing is followed by another. The error names every try's outcome.
 * `path`, `open` and `log` are for tests.
 */
export async function loginAs(url: string, scope: string, agent: string | undefined,
  opts: { path?: string; open?: (u: URL) => void | Promise<void>; log?: (line: string) => void } = {}) {
  const log = opts.log ?? ((l: string) => console.error(l));
  const outcomes: string[] = [];
  for (let tries = 1; ; tries++) {
    let me;
    try {
      me = await login(url, { scope, path: opts.path, open: opts.open, log: opts.log });
    } catch (e) {
      throw unreachable(e, url) ?? e;
    }
    if (agent === undefined || me.actor === agent) return me;
    // --agent: a sign-in as anyone else (chosen otherwise on Kolab's page) is never kept.
    const r = await logout(url, { path: opts.path, forget: true });
    outcomes.push(`try ${tries}: ${me.actor}, ${r.revoked ? 'revoked' : 'forgotten, not revoked'}`);
    const all = `${outcomes.join('; ')}`;
    if (!r.revoked) {
      throw new Error(`you signed in as ${me.actor}, not ${agent}, and that sign-in couldn't be revoked: it is forgotten, not revoked, and lapses within 30 days unused, so konjir login doesn't ask again (${all}). Nothing is kept: run konjir login again once Kolab can be reached, and on Kolab's page check it names ${agent}`);
    }
    if (tries > ASK_AGAIN) {
      throw new Error(`you didn't sign in as ${agent} in ${tries} tries (${all}). Nothing is kept: run konjir login again, and on Kolab's page check it names ${agent}`);
    }
    log(`You signed in as ${me.actor}, not ${agent}, so that sign-in was revoked and nothing is kept. Asking again for ${agent}, try ${tries + 1} of ${ASK_AGAIN + 1}: on Kolab's page, check it names ${agent}, then Allow.`);
  }
}

/**
 * Signs a Claude Code channel entry in as its agent (W3.8), with the browser, kept in the agent's own
 * credentials file, where the bridge started with KONJIR_AGENT finds it. Its scope names the agent,
 * kolab and role, which locks Kolab's page to them; never Yourself (D60). `step` is which of
 * several entries this is, which the page says. A sign-in as anyone else is revoked, forgotten, and
 * a WrongAgentError.
 */
export async function signInAgent(e: Entry, credentials: string, opts: { open?: (u: URL) => void | Promise<void>; log?: (line: string) => void; step?: { n: number; of: number } } = {}): Promise<string> {
  const who = await login(e.url, { path: credentials, clientName: CHANNEL_CLIENT_NAME, scope: entryScope(e.kolab, e.role, e.agent), open: opts.open, log: opts.log, ...(opts.step ? { step: opts.step } : {}) });
  if (who.actor !== e.agent) {
    // Chosen otherwise on Kolab's page (another agent, or Yourself): never kept as this entry's sign-in.
    const r = await logout(e.url, { path: credentials, forget: true });
    throw new WrongAgentError(who.actor, e.agent, r.revoked, `it signed in as ${who.actor}, not ${e.agent}, so that sign-in was ${r.revoked ? 'revoked' : 'forgotten, unrevoked,'} and nothing is kept for ${e.name}`);
  }
  return who.actor;
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
