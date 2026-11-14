/**
 * konjir: the same verbs as the MCP server, for a shell or a harness without MCP.
 * It is an MCP client of Kolab, so there is exactly one backend.
 *
 *   konjir serve [--port 7420] [--data .konjir] [--admin-token T|off] [--public-host H]
 *                [--database-url postgres://…] [--no-migrate] [--no-worker] [--quiet]
 *                (KONJIR_STUB_IDENTITY=<login>: a local Kolab signs everyone in as <login>, no GitHub)
 *   konjir tools
 *   konjir instructions [reviewer]
 *   konjir resolve <address>
 *   konjir read <node> [version]
 *   konjir stale [all]
 *   konjir queries [all]
 *   konjir watch [--once]                -> print your inbox now and each time Kolab pushes a change
 *   konjir login [--kolab K] [--role R] [--agent A] -> sign in with the browser (OAuth, D55); later commands use it
 *   konjir logout [--forget]
 *   konjir connect opencode|claude --kolab K [--agent label[:role]]… [--global] [--force] [--force-path] [--dry-run] [--no-auth] [--http]
 *                                        -> one browser page sets up the kolab and your agents; one MCP entry per agent
 *                                           in the harness's config (W3.7, D59); for Claude Code, the Konjir channel
 *                                           bridge (W3.8, D61), each agent signed in, or with --http its HTTP entry
 *   konjir claude <label> [claude's arguments…]
 *                                        -> one agent's Claude Code session: its konjir-<label> entry and channel alone,
 *                                           and a system prompt naming it (W9.1, API24)
 *   konjir repo register [--binding B] [--url U] [--root SHA] [-C dir]
 *                                        -> registers this checkout's repository, as a person with Maintain (W5.2a, D98)
 *   konjir work deliver [<work>] [--submit] [--pr URL] [--test URL|summary]… [--check ADDRESS=passed|failed]… [--note T] [--since REV] [--repo URL] [--dry-run] [-C dir]
 *   konjir work deliver <work> --release URL [--commit REV] [--title T] [--repo URL] [--dry-run] [-C dir]
 *                                        -> records the commits carrying the package's Konjir-Work trailer (W5.2a, D98)
 *   konjir work [--jobs 4] [--once] [--machine M] [--allow-all] [--harness CMD] [--repo URL] [-C dir]
 *                                        -> sets this machine to work: takes jobs from Kolab and runs one headless
 *                                           Claude Code per job, in its own worktree (W5.4b, D103)
 *   konjir status [--json]               -> the kolab's queue, its live jobs and your room under the caps (W5.4b)
 *   konjir import <file.json> [--dry-run] [--update]
 *                                        -> imports from one file what the role signed in may write, as that person,
 *                                           never an agent or a job: run it as product and as engineer (W6.3)
 *   konjir <verb> [key=value ...]        -> calls konjir_<verb>; values are JSON if they parse
 *   konjir <verb> --json '{"key": ...}'
 *
 * Connection: KONJIR_URL and KONJIR_TOKEN, or --url / --token; or, with no token, the sign-in
 * `konjir login` keeps for that URL (W3.4). With no URL, the project's .konjir.json (API26), else,
 * with no token either, the one sign-in it keeps, when it keeps exactly one (D106), else this build's
 * default: the hosted Kolab for the published konjir, the local one for a checkout (API25).
 */
import { Client, StreamableHTTPClientTransport, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as osConstants } from 'node:os';
// The roles a session works in (@konjir/types' ROLES), written out: the published client bundles nothing of Kolab's.
const ROLES = ['product', 'engineer'];
import { StoredLogin, credentialsPath, keptSignIns, login, logout, safeUrl, setup } from './login.js';
import { deliverWork, gitIn, registerRepository, releaseDelivered } from './deliver.js';
import { ToolRefusal, formatStatus, runWork, workStatus } from './work.js';
import { guardHook } from './guard.js';
import { HARNESSES, connectHarness, mcpUrl, parseAgents, terminalIO, type Harness } from './connect.js';
import { gitIgnored, startClaude } from './claude.js';
import { toolsListing, verbHelp } from './verbs.js';
import { importKolab } from './import.js';
import { findProject } from './project.js';

export { StoredLogin, agentCredentials, agentCredentialsPath, credentialsPath, keptSignIns, login, logout, setup } from './login.js';
export { canonicalRemote, checkoutRepository, deliverWork, gitIn, readCheckout, registerRepository, releaseDelivered, taggedCommits, type Git } from './deliver.js';
export { ALLOWED_TOOLS, Redactor, TOKEN_KINDS, ToolRefusal, deniedTools, feedOnce, formatStatus, guardSettings, harnessCommand, harnessEnv, heartbeatEvery, jobNote, konjirCommand, leaseLeft, markerText, runWork, workStatus, removeKonjirShim, sweepJobs, thisMachine, writeKonjirShim, type JobReport, type Machine, type TakenJob } from './work.js';
export { guardHook, lineDenial, simpleCommands } from './guard.js';
export { PROJECT_FILE, findProject, projectText, readProject, type Project } from './project.js';
export { connectHarness, mergeClaude, mergeOpencode, parseAgents, setupScopeOf, unifiedDiff, writeAtomically, type ConnectIO } from './connect.js';

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
  // A 403 insufficient_scope is Kolab refusing an admin verb to a session that isn't an admin's own:
  // signing in again for a wider scope never helps (W2.22), so the client throws it
  // (InsufficientScopeError, said plainly by call) and keeps the sign-in.
  await client.connect(new StreamableHTTPClientTransport(new URL(url), typeof auth === 'string'
    ? { requestInit: { headers: { Authorization: `Bearer ${auth}` } }, onInsufficientScope: 'throw' }
    : { authProvider: auth, ...(auth instanceof StoredLogin ? { fetch: auth.fetch } : {}), onInsufficientScope: 'throw' }));
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

/** The refusal for a session that isn't a Konjir admin's own (an agent's, a hand-issued one, or another person's sign-in) calling an admin verb, said plainly. */
const adminOnly = (verb: string) =>
  `${toolName(verb)} is an admin verb: only a Konjir admin's own session or the break-glass token may call it, and this session is neither. If you are a Konjir admin, sign in as yourself with GitHub; if not, ask one.`;

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
  konjir tools                 every verb with its parameters (name=<type>, [optional]) and what it does
  konjir help <verb>           a verb's description and parameters
  konjir <verb> key=value ...  call a verb; values parse as JSON when they can,
                               e.g. elements='[{"id":"R1","text":"..."}]'
  konjir <verb> --json '{...}' the same, with all arguments as one JSON object

Shortcuts: konjir resolve <address> · konjir read <node> [version] · konjir stale [all] · konjir queries [all]
Build:     the loop for an engineer (konjir instructions has it step by step): konjir pull_work, then konjir read_work
           work=kj:<binding>#<id> for its done-when, what it serves and its trailer; build and test it in a checkout of
           its repository; git commit --trailer "Konjir-Work: kj:<kolab>/<binding>#<id>"; push and open a pull request if
           you can; konjir work deliver <work> --submit. Another engineer checks the evidence, tries to break it and runs konjir review
           work=<work> verdict=approve (or request_changes note=…). Ask about an unclear element (konjir ask), open a case
           file when the spec can't be met as written (konjir open_case), never patch around it. A Done package at risk:
           konjir clear_mark mark=… if the work holds, else konjir reopen_work work=… note=….
Git:       konjir work deliver [<work>] [--submit] [--pr <url>] [--test <url|summary>]… [--note <text>] [--since <rev>]
           [--repo <url>] [--dry-run] [-C <dir>], in a checkout: finds the commits whose trailer is the package's
           (Konjir-Work: kj:<kolab>/<binding>#<id>, from pull_work or read_work), checks the checkout is the registered
           repository (its root commit and a remote), and records them as evidence; --submit submits the package.
           Run again, it records only what is new. Kolab itself never reads git. --check kj:<kolab>/<spec>#<id>=passed
           (or =failed), repeated, lists the acceptance checks the one --test ran; each must resolve to a committed spec
           element, and a failed one is a finding on the package's review that stays on its record (REV9).
           konjir work deliver <work> --release <run URL> [--commit <rev>] [--title <text>], after the package's approval
           and then the deploy, in a checkout of its registered repository: records that the run, a GitHub Actions run
           of that repository (<repository URL>/actions/runs/<id>), released the commit (HEAD by default, sent as its
           full 40-hex sha); a package with release: true, approved, is then Done. Only someone with Write on the
           technical layer other than the package's assignee records it, from an engineer session outside any job.
           konjir repo register [--binding <binding>] [--url <url>] [--root <sha>] [-C <dir>], in a checkout, as a
           person with Maintain or Admin (never an agent): registers its repository, pinned by its root commit.
Import:    konjir import <file.json> [--dry-run] [--update], signed in as yourself (never an agent or a job): imports
           from one file what your role may write, into the kolab you are signed in to. Two passes, in either order:
           konjir login --kolab <k> --role product, for the spec and the rulings on it; then --role engineer, for the
           binding, its work packages, the rulings on it and the repository (README.md, "Importing a kolab", gives the
           file's shape). Kolab checks the whole file first; run again, it changes nothing that is there and equal,
           reports what differs, and completes what waited. --dry-run writes nothing and says what it would do.
Work:      konjir work [--jobs <n>] [--once] [--machine <label>] [--allow-all] [--harness <cmd>] [--repo <url>] [-C <dir>],
           signed in as yourself, in a checkout of the kolab's registered repository: sets this machine to work. It takes
           jobs from Kolab (a package returned with changes requested, a review, a ready work package, then a question,
           note or mark on the technical layer, or a spec element nothing serves yet), up to --jobs at once (4; the
           kolab's policy caps you, 4 by default, and the kolab, 8), each done by one of your pool agents in its
           own git worktree at the default branch's head (under ~/.konjir/jobs), by Claude Code run headless on your
           own model account, with Kolab as its one MCP server and only edits, git, npm, npx, gh and konjir allowed
           (--allow-all: every permission). A job never
           merges or deploys: a hook (konjir work guard) denies a push that deletes (:branch, --delete), forces,
           mirrors or reaches the default branch, merging, gh api and terraform, quoted, wrapped or nested.
           Only a build job's commands get its token, as KONJIR_TOKEN for konjir work deliver; Claude Code reads
           it from a FIFO read once, so a review's tests find it nowhere. It renews each job's lease, ends the
           job when its harness exits, keeps a worktree with work not pushed, and waits while nothing is ready;
           Ctrl-C (or SIGTERM, SIGHUP) stops every job and gives back what it held, and a second Ctrl-C kills
           them at once. Starting, it sweeps what a killed runner left (W7.12).
           --once takes one job, whatever --jobs says, waits for it to end and exits; with nothing to
           take, it says why and exits. --machine names this machine (its hostname); --harness (or KONJIR_HARNESS)
           runs another command in Claude Code's place, split on spaces (no quoting). macOS and Linux only, not
           Windows yet.
           konjir status [--json]: the kolab's queue by kind, its live jobs (person, machine, agent, item, since) and
           your room under the caps.
Pages:     every list (and a long read) returns a page and next; while next isn't null, call it again with
           cursor=<next>, e.g. konjir list_queries cursor=… (limit=<n> sets the page, at most 200)
Push:      konjir watch prints your inbox, then a JSON line each time it changes (questions, notes,
           answers, marks, review requests and verdicts). konjir watch --once waits for the next change,
           prints it and exits.
Addresses: kj:[<kolab>/]<node>[@<version>][#<element>][~q({"exact":"words"})]; kj:<node> is a node in your kolab
Sign in:   konjir login [--kolab <name>] [--role product|engineer] [--agent <label|agent>] signs in with your browser
           (GitHub, through Kolab): you choose who this CLI works as (an agent of yours, by default; --agent
           preselects one, by its label as konjir connect takes it, <you>-<label>, or its full name, and
           refuses a sign-in as anyone else), the kolab and the role.
           Every later command uses that sign-in, renewing it by itself. konjir logout revokes it; --forget drops
           it here without contacting Kolab.
Harnesses: konjir connect opencode|claude --kolab <k> [--agent <label>[:<role>]]… [--global] [--force] [--force-path]
           [--dry-run] [--no-auth] [--http] connects a harness to a kolab, one agent per entry (by default product and engineer).
           It prints the plan (the entries, your agents <you>-<label>, the change to opencode.json or .mcp.json, or with
           --global your own settings) and opens your browser once, at Kolab's setup page: sign in, check the kolab and
           agents it names, and Allow. Kolab makes the kolab if no kolab has that name (private, yours) and each agent
           that is new, and grants each in the kolab in its role, never more than you hold. --dry-run prints the plan
           and stops. --force replaces konjir-<label> entries already there; --force-path writes a config file that
           links outside the project. For Claude Code each entry is the Konjir channel (from this checkout): Kolab's
           tools and the inbox pushed into the session, each agent already signed in; it ends with one konjir claude
           command per agent. --http writes Claude Code's plain HTTP entry instead, with no channel; OpenCode's and
           --http's entries each sign in by themselves, on a page locked to their agent. Run it again: the same kolab
           and agents, signed in afresh.
           konjir claude <label> [claude's arguments…] starts one agent's Claude Code session: only its konjir-<label>
           entry and channel (written alone to .claude/konjir-<label>.json), and a system prompt naming the agent, its
           role and kolab. Everything after the label goes to claude.
Connection: KONJIR_URL (default ${defaultUrl()}) and KONJIR_TOKEN, or --url / --token; with no
           token, the sign-in konjir login keeps for that URL. In a project konjir connect set up, or a folder
           below it, its .konjir.json names the kolab and Kolab's URL (no token): login, repo register, work,
           status and the verbs take them, and refuse a session in another kolab; --kolab, --url or KONJIR_URL
           override it. A token goes only to a URL given, or the default. Else, with neither URL nor token, the
           one sign-in konjir keeps, when it keeps exactly one (konjir login and connect still take the default).
Version:   konjir --version
${canServe ? `Server: konjir serve [--port 7420] [--data .konjir | --database-url postgres://…] [--admin-token T|off] [--public-host kolab.example.com]
        [--no-migrate] [--no-worker] [--quiet]
        Kolab runs structural checks only and makes no model calls; reviewing agents review.
        --no-migrate applies no migration (a database that needs one is refused) and --no-worker runs no
        outbox jobs, so a restored database can be checked without changing it (deploy/RECOVERY.md). --quiet
        doesn't print the admin token a local Kolab makes when none is given. KONJIR_KOLABS_PER_PERSON caps how many
        kolabs of their own a person may make.
        The admin token (or KONJIR_ADMIN_TOKEN) is a break-glass only: Konjir's admins are people who sign in as
        themselves with GitHub, and run the admin verbs from that session (W2.22, D111). off disables it.
        Sign-in with GitHub (D55): KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET, a GitHub OAuth app's,
        whose callback is <origin>/oauth/callback/github. For local development and browser tests only,
        KONJIR_STUB_IDENTITY=<login> signs anyone who opens Kolab's sign-in in as <login>, with no GitHub and no
        check; refused with a public host or beside GitHub's settings. KONJIR_WEB_TOKEN_SIGN_IN=on keeps pasting a token in the
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

/** What `konjir work`'s flags ask for. It takes them out of `args`, leaving only what it doesn't know. */
export function workOptions(args: string[]) {
  const on = (name: string) => { const i = args.indexOf(`--${name}`); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const jobs = flag(args, 'jobs');
  return { once: on('once'), allowAll: on('allow-all'), machine: flag(args, 'machine'), harness: flag(args, 'harness'), repo: flag(args, 'repo'),
    ...(jobs !== undefined ? { jobs: Number(jobs) } : {}) };
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

/** A login KONJIR_STUB_IDENTITY may name: GitHub's shape, letters, digits and '-'. */
const STUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * How `konjir serve` signs people in (D55): with GitHub when KONJIR_GITHUB_CLIENT_ID and
 * KONJIR_GITHUB_CLIENT_SECRET are both set (one alone is refused); a pasted token in the web page
 * when KONJIR_WEB_TOKEN_SIGN_IN is on, or by default without GitHub; hand-issued session tokens
 * unless KONJIR_HAND_ISSUED_TOKENS is off. Never prints a secret.
 *
 * KONJIR_STUB_IDENTITY=<login>, for local development and browser tests only: the identity
 * provider is the stub tests use, which signs whoever opens Kolab's sign-in in as <login>, with no
 * check at all and no GitHub. So it is refused with a public host (`publicHost`: every deployed
 * Kolab has one, behind its TLS proxy) and beside GitHub's settings, and its Kolab binds 127.0.0.1,
 * which `konjir serve` names when it starts the server.
 */
export function signInSettings(env: Record<string, string | undefined>, opts: { publicHost?: string } = {}) {
  const id = env.KONJIR_GITHUB_CLIENT_ID?.trim();
  const secret = env.KONJIR_GITHUB_CLIENT_SECRET?.trim();
  if (!!id !== !!secret) throw new Error('set both KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET for sign-in with GitHub, or neither');
  const github = !!id && !!secret;
  const stub = env.KONJIR_STUB_IDENTITY?.trim() || undefined;
  if (stub) {
    if (opts.publicHost) throw new Error('KONJIR_STUB_IDENTITY signs anyone who opens Kolab\'s sign-in in, with no check: it is only for a local Kolab, never one with a public host (--public-host or KONJIR_PUBLIC_HOST). Unset it');
    if (github) throw new Error('KONJIR_STUB_IDENTITY is for a local Kolab without GitHub: unset it, or KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET');
    if (!STUB_LOGIN.test(stub)) throw new Error('KONJIR_STUB_IDENTITY is the login everyone signs in as: letters, digits and \'-\', as a GitHub login');
  }
  const webTokenSignIn = onOff(env, 'KONJIR_WEB_TOKEN_SIGN_IN') ?? !github;
  const handIssuedTokens = onOff(env, 'KONJIR_HAND_ISSUED_TOKENS') ?? true;
  return {
    github, stub, webTokenSignIn, handIssuedTokens,
    describe: [stub ? `the stub identity provider (KONJIR_STUB_IDENTITY): anyone who opens Kolab's sign-in is signed in as ${stub}, with no check; local development only`
      : github ? 'GitHub' : 'no identity provider (set KONJIR_GITHUB_CLIENT_ID and KONJIR_GITHUB_CLIENT_SECRET)',
      webTokenSignIn ? 'a pasted token in the web page' : '', handIssuedTokens ? 'hand-issued session tokens' : ''].filter(Boolean).join('; '),
    async identity(load: () => Promise<{ GitHubIdentity: new (c: { clientId: string; clientSecret: string }) => unknown; StubIdentity: new () => { as?: { subject: string; login: string } } }>) {
      if (stub) {
        const { StubIdentity } = await load();
        const idp = new StubIdentity();
        idp.as = { subject: `stub-${stub.toLowerCase()}`, login: stub };
        return { identity: idp as never };
      }
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

/** The local Kolab, `konjir serve`'s: the default of a checkout, which can serve (API25). */
export const LOCAL_URL = 'http://127.0.0.1:7420/mcp';
/** The hosted Kolab: the default of the published package and the binaries (API25). */
export const HOSTED_URL = 'https://kolab.konjir.com/mcp';

// The published builds (scripts/package.mjs) define this as HOSTED_URL; a checkout leaves it undefined.
declare const KONJIR_DEFAULT_URL: string | undefined;

/**
 * Where a command talks to when no URL is given (`--url`, KONJIR_URL, a project's .konjir.json): the
 * Kolab this build names (API25). Read when it is called, so a test can stand in for a published build.
 */
export const defaultUrl = (): string => (typeof KONJIR_DEFAULT_URL === 'string' && KONJIR_DEFAULT_URL ? KONJIR_DEFAULT_URL : LOCAL_URL);

/**
 * The Kolab a command talks to (D106, API26): the URL given (`--url`, else KONJIR_URL), else the
 * project's (its .konjir.json, which serve, --version and bare help never take), else, with no
 * token and outside a job (KONJIR_JOB), the one sign-in konjir keeps, when it keeps exactly one, for
 * a verb, konjir work or konjir logout (`implicit`: konjir says so on stderr); else this build's
 * default. konjir login and connect sign in afresh, and serve serves, so they never take a kept
 * sign-in, nor --version or bare help, which talk to no Kolab.
 */
export function connectionUrl(o: { given?: string; project?: string; token?: string; cmd?: string; rest?: string[]; job?: string; kept: () => string[] }): { url: string; implicit: boolean } {
  if (o.given !== undefined) return { url: o.given, implicit: false };
  const local = !o.cmd || o.cmd === '--version' || ((o.cmd === 'help' || o.cmd === '--help') && !o.rest?.[0]);
  if (o.project !== undefined && !local && o.cmd !== 'serve') return { url: o.project, implicit: false };
  if (o.token || o.job?.trim() || local || ['serve', 'login', 'connect'].includes(o.cmd!)) return { url: defaultUrl(), implicit: false };
  const kept = o.kept();
  return kept.length === 1 ? { url: kept[0], implicit: true } : { url: defaultUrl(), implicit: false };
}

/** `konjir <argv…>`. `io.open` sends konjir login's browser to Kolab: for tests. */
export async function main(argv: string[], io: { open?: (u: URL) => void | Promise<void> } = {}) {
  // One agent's Claude Code session (W9.1, API24). It talks to no Kolab, and everything after the
  // label is claude's, --url and --token included, so it is taken before konjir reads its own flags.
  if (argv[0] === 'claude') {
    if (process.env.KONJIR_JOB?.trim()) throw new Error('konjir claude doesn\'t run inside a Konjir job (KONJIR_JOB is set): a job is its own session already');
    const [label, ...args] = argv.slice(1);
    // Ctrl-C is claude's to handle, and a SIGTERM or SIGHUP sent to konjir is passed on to it:
    // konjir waits for it to exit, rather than leaving it behind on the terminal.
    let child: ReturnType<typeof spawn> | undefined;
    let early: NodeJS.Signals | undefined;
    const pass = (sig: NodeJS.Signals) => () => { if (sig !== 'SIGINT') { if (child) child.kill(sig); else early = sig; } };
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => [sig, pass(sig)] as const);
    for (const [sig, h] of handlers) process.on(sig, h);
    try {
      process.exitCode = await startClaude(label, args, { cwd: process.cwd(), env: process.env }, {
        warn: (l) => console.error(l), ignored: gitIgnored,
        run: (cmd, a, o) => new Promise((resolve) => {
          // One that came before claude started ends konjir instead.
          if (early) { resolve(128 + (osConstants.signals[early] ?? 0)); return; }
          child = spawn(cmd, a, { cwd: o.cwd, stdio: 'inherit' });
          child.on('error', () => resolve(-1));
          child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : -1)));
        }),
      });
    } finally { for (const [sig, h] of handlers) process.off(sig, h); }
    return;
  }

  // A job's guard hook (W6.4): Claude Code runs it before each shell command, inside the job, with
  // its PreToolUse input on stdin. It talks to no Kolab and needs no session.
  if (argv[0] === 'work' && argv[1] === 'guard') {
    const branch = flag(argv.slice(2), 'branch');
    if (!branch) throw new Error('konjir work guard --branch <the default branch>: a job\'s Claude Code runs it as a hook, with the command to check on stdin');
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    const r = guardHook(input, branch);
    if (r.message) console.error(r.message);
    process.exitCode = r.code;
    return;
  }
  const given = flag(argv, 'url') ?? process.env.KONJIR_URL;
  const token = sessionToken(flag(argv, 'token'));
  // --kolab names the kolab for any command, as login and connect take it, over the project's.
  const kolabFlag = flag(argv, 'kolab');
  const [cmd, ...rest] = argv;
  const job = process.env.KONJIR_JOB?.trim();
  // The project's .konjir.json (API26), for what isn't given. A job takes everything from its
  // environment, so it reads none; nor does a command that talks to no Kolab, or serve.
  const local = !cmd || cmd === '--version' || ((cmd === 'help' || cmd === '--help') && !rest[0]) || cmd === 'serve';
  const project = job || local || (given !== undefined && kolabFlag !== undefined) ? undefined : findProject(process.cwd());
  const { url, implicit } = connectionUrl({ given, project: project?.url, token, cmd, rest, job, kept: keptSignIns });
  // A token goes only where it was told to go, or to this build's own default: never to a URL a
  // project's file names, which a cloned repository could aim anywhere.
  if (token && !['login', 'logout', 'connect'].includes(cmd) && given === undefined && project?.url !== undefined && project.url !== defaultUrl()) {
    throw new Error(`a token is given (KONJIR_TOKEN or --token), but not Kolab's URL, and ${project.path} names ${safeUrl(project.url)}: konjir sends a token only to a URL you give it, so set KONJIR_URL or pass --url`);
  }
  const kolab = kolabFlag ?? project?.kolab;
  if (implicit) console.error(`konjir: using ${safeUrl(url)} (the one sign-in kept)`);
  // Inside a Konjir job (W5.4b) konjir works as the job's agent, with KONJIR_TOKEN, and never with a
  // sign-in kept on this machine: the person's is theirs, not the job's.
  if (job && cmd && cmd !== '--version' && !((cmd === 'help' || cmd === '--help') && !rest[0])) {
    if (['login', 'logout', 'connect', 'serve', 'import'].includes(cmd) || (cmd === 'work' && rest[0] !== 'deliver')) {
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
    const sign = signInSettings(process.env, { publicHost });
    // The published konjir CLI, pinned (W3.7): the web page shows `npx <spec>` only when this is set.
    const cliNpmSpec = process.env.KONJIR_CLI_NPM_SPEC?.trim() || undefined;
    // A restore's smoke check (W2.24) opens the restored database without changing it: no
    // migration (a database that needs one is refused) and no outbox worker.
    const migrate = !rest.includes('--no-migrate');
    const worker = !rest.includes('--no-worker');
    // The stub signs anyone in: its Kolab binds 127.0.0.1, named here, before it listens.
    const s = await startServer({ ...(sign.stub ? { host: '127.0.0.1' } : {}), port, dataDir, databaseUrl, adminToken, publicHost, kolabsPerPerson, handIssuedTokenDays, ...(await sign.identity(server)), webTokenSignIn: sign.webTokenSignIn, handIssuedTokens: sign.handIssuedTokens, cliNpmSpec, migrate, worker });
    if (!migrate) log.warn('migrations: checked, none applied (--no-migrate); a release with a new migration refuses to start');
    if (!worker) log.warn('outbox: no worker (--no-worker); no after_commit, settle or rebase job is claimed or run');
    if (sign.stub) log.warn(`sign-in: ${sign.describe}`, { event: 'stub_identity' });
    else log.info(`sign-in: ${sign.describe}`);
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
    if (!HARNESSES.includes(harness as Harness)) throw new Error(`konjir connect ${HARNESSES.join('|')} --kolab <k> [--agent <label>[:<role>]]… [--global] [--force] [--force-path] [--dry-run] [--no-auth] [--http] [--url <kolab>]`);
    const agents: string[] = [];
    for (let a = flag(rest, 'agent'); a !== undefined; a = flag(rest, 'agent')) agents.push(a);
    const on = (name: string) => { const i = rest.indexOf(`--${name}`); if (i >= 0) rest.splice(i, 1); return i >= 0; };
    // --yes is kept, and does nothing: konjir connect asks nothing in the terminal now (one page, in the browser).
    on('yes');
    const opts = { global: on('global'), force: on('force'), forcePath: on('force-path'), dryRun: on('dry-run'), auth: !on('no-auth'), http: on('http') };
    if (rest.length) throw new Error(`konjir connect: unknown ${rest.join(' ')}`);
    // It sets up as the person, in the browser: a token given (KONJIR_TOKEN or --token) isn't used for it.
    if (token) console.error('konjir connect signs you in in your browser, at Kolab\'s setup page: KONJIR_TOKEN and --token aren\'t used for it.');
    const mcp = mcpUrl(url);
    await connectHarness({ harness: harness as Harness, url: mcp, kolab, agents: parseAgents(agents), cwd: process.cwd(), env: process.env, ...opts },
      terminalIO((r) => setup(r.url, { scope: r.scope, mint: r.mint, clientName: r.clientName, opening: r.opening, log: (l) => console.log(l) }).catch((e: unknown) => { throw unreachable(e, r.url) ?? e; })));
    return;
  }

  if (cmd === 'login') {
    const role = flag(rest, 'role');
    const agent = flag(rest, 'agent');
    if (role !== undefined && !ROLES.includes(role)) throw new Error(`--role is one of ${ROLES.join(', ')}`);
    if (kolab !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(kolab)) throw new Error('--kolab names a kolab: lowercase letters, digits and -');
    if (agent !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent)) throw new Error('--agent names an agent of yours, by its label as konjir connect takes it (product, for <you>-product) or its full name: lowercase letters, digits and -');
    const scope = ['konjir', kolab && `kolab:${kolab}`, role && `role:${role}`, agent && `agent:${agent}`].filter(Boolean).join(' ');
    const me = await loginAs(url, scope, agent, { open: io.open });
    console.log(`Signed in to ${url} as ${me.actor}${me.kind === 'agent' ? ` (an agent of ${me.owner}'s)` : ''}, in kolab ${me.kolab} as ${me.role}.`);
    console.log(`Kept in ${credentialsPath()}. konjir uses it with KONJIR_URL or --url set to ${safeUrl(url)}, or with neither while it is the only sign-in kept there. Start with: konjir instructions`);
    return;
  }
  if (cmd === 'logout') {
    const r = await logout(url, { forget: rest.includes('--forget') });
    const others = r.had ? [] : keptSignIns().filter((u) => u !== url);
    console.log(!r.had ? `No sign-in kept for ${safeUrl(url)}.${others.length ? ` konjir keeps ${others.length === 1 ? 'one' : 'sign-ins'} for ${others.map(safeUrl).join(', ')}: run konjir logout --url <url> for ${others.length === 1 ? 'it' : 'each'}.` : ''}`
      : r.revoked ? `Signed out of ${url}: the sign-in is revoked and forgotten.`
        : `Forgotten, but not revoked at ${url}${r.why ? ` (${r.why})` : ''}: it lapses within 30 days unused, or an admin can end it.`);
    return;
  }

  const stored = token ? undefined : new StoredLogin(url);
  if (!token && !stored!.signedIn) {
    // Several sign-ins kept, none for this URL: named, so the person can choose one.
    const others = keptSignIns().filter((u) => u !== url);
    // It names the URL, and where it came from, before anything is sent anywhere.
    const whence = given !== undefined ? '' : project?.url !== undefined ? `, which ${project.path} names` : ', the default';
    throw new Error(`set KONJIR_TOKEN (an agent session token, or the admin token for admin_* verbs), or run konjir login to sign in with your browser. konjir keeps no sign-in for ${safeUrl(url)}${whence}${others.length
      ? `, but keeps ${others.length === 1 ? 'one' : 'sign-ins'} for ${others.map(safeUrl).join(', ')}: set KONJIR_URL, or pass --url, to ${others.length === 1 ? 'it' : 'one of them'}` : ''}`);
  }
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
  // The kolab named (--kolab, or the project's): a session works in one kolab, so one signed in to
  // another is refused before anything runs, rather than act there (API26).
  if (kolab !== undefined) {
    let me: { kolab?: unknown };
    try { me = await call(client, 'whoami') as { kolab?: unknown }; } catch (e) { stored?.releaseLock(); await client.close(); throw e; }
    if (typeof me.kolab === 'string' && me.kolab !== kolab) {
      stored?.releaseLock();
      await client.close();
      const named = kolabFlag !== undefined ? '--kolab' : project!.path;
      throw new Error(`${named} names kolab ${kolab}, but this session works in kolab ${me.kolab}${token ? '' : `: run konjir login${kolabFlag !== undefined ? ` --kolab ${kolab}` : ''} to sign in to ${kolab}`}${kolabFlag === undefined ? `, or pass --kolab ${me.kolab}` : ''}`);
    }
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
      const opts = workOptions(args);
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
  // The verb's own form takes file=… or --json; anything else, a path with '=' in it too, is a file to read.
  if (cmd === 'import' && !rest.some((a) => a === '--json' || a.startsWith('file='))) {
    try {
      const r = await importKolab((verb, a) => call(client, verb, a), rest, { log: (l) => console.error(l) });
      console.log(JSON.stringify(r.report, null, 2));
      process.exitCode = r.exitCode;
    } finally {
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
        const run = flag(args, 'release');
        if (run !== undefined) {
          // After the deploy: the package's release, not its work's evidence (PLN16, W7.7).
          const opts = { run, commit: flag(args, 'commit'), title: flag(args, 'title'), repo: flag(args, 'repo'), dryRun: on('dry-run') };
          const work = args[0] !== undefined && !args[0].startsWith('-') ? args.shift() : undefined;
          if (args.length) throw new Error(`konjir work deliver <work> --release <run URL> [--commit <rev>] [--title <text>] [--repo <url>] [--dry-run] [-C <dir>]: unknown ${args.join(' ')}`);
          console.log(JSON.stringify(await releaseDelivered(callIt, git, { work, ...opts }), null, 2));
          return;
        }
        const tests: string[] = [];
        for (let t = flag(args, 'test'); t !== undefined; t = flag(args, 'test')) tests.push(t);
        const checks: string[] = [];
        for (let c = flag(args, 'check'); c !== undefined; c = flag(args, 'check')) checks.push(c);
        const opts = { submit: on('submit'), dryRun: on('dry-run'), pr: flag(args, 'pr'), note: flag(args, 'note'), since: flag(args, 'since'), repo: flag(args, 'repo'), tests, checks };
        const work = args[0] !== undefined && !args[0].startsWith('-') ? args.shift() : undefined;
        if (args.length) throw new Error(`konjir work deliver [<work>] [--submit] [--pr <url>] [--test <url|summary>]… [--check <spec address>=passed|failed]… [--note <text>] [--since <rev>] [--repo <url>] [--dry-run] [-C <dir>]: unknown ${args.join(' ')}`);
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
        result = toolsListing((await client.listTools()).tools); break;
      case 'help': {
        const name = toolName(rest[0]);
        const tool = (await client.listTools()).tools.find((t) => t.name === name);
        // An agent session doesn't see the admin verbs (toolVisibility 'authorized').
        if (!tool) throw new Error(`no verb ${rest[0]}${name.startsWith('konjir_admin_') ? ' for this token: the admin verbs are for a Konjir admin\'s own session or the break-glass token' : ''}; run konjir tools`);
        result = verbHelp(tool);
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

/** How many more times `konjir login --agent` asks again for the same agent, at once, after a sign-in that came back as anyone else and was revoked (D97). */
export const ASK_AGAIN = 2;

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
    // --agent takes a label, as konjir connect does (<you>-<label>), or an agent's full name (API26).
    if (agent === undefined || me.actor === agent || (me.kind === 'agent' && me.owner && me.actor === `${me.owner}-${agent}`)) return me;
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
