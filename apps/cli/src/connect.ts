/**
 * `konjir connect <harness>`: one command connects a harness to a kolab, with one agent per entry
 * (W3.7, D59; one page, Lee's instruction of 2026-11-01). It opens the browser once, at Kolab's
 * setup page, which names the kolab (made now if it is new) and each agent with its role (made now
 * or reused); the person signs in and allows it, and Kolab makes and grants them all. It writes one
 * MCP server entry per agent, `konjir-<label>`, into the harness's own configuration: OpenCode's
 * `opencode.json` (or `.jsonc`), merged with its comments and formatting kept, or Claude Code's
 * project `.mcp.json`. No token is written in either.
 *
 * For Claude Code, each entry is the Konjir channel bridge (W3.8, D61), Claude Code's one Konjir
 * server: Kolab's tools passed through and the channel, on its agent's own sign-in, which Kolab
 * issues at the setup and konjir keeps in that agent's credentials file (KONJIR_AGENT), so no
 * further page opens. The entry runs the bridge this konjir carries, `konjir bridge` (W9.5, API29),
 * or, from a checkout, the checkout's own. `--subagents` also writes one Claude Code subagent per
 * agent, `.claude/agents/<label>.md`, with only that agent's Konjir tools. `--http` writes Claude Code's plain HTTP entry instead, as `claude mcp add
 * --scope project --transport http` writes it, with no channel; it and OpenCode's entries each sign
 * in by themselves, on a page locked to their agent (D97).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsoncError, commentsOf, member, parseTree, tokens, valueOf, type JsonNode } from './jsonc.js';
import { agentCredentials, agentCredentialsPath, credentialsPath, keepSignIn, revokeIssued, type SetupDone } from './login.js';

export const HARNESSES = ['opencode', 'claude'] as const;
export type Harness = typeof HARNESSES[number];
const ROLES = ['product', 'engineer'] as const;
type Role = typeof ROLES[number];

/** One agent to connect: its label, which names it (`<person>-<label>`) and its entry (`konjir-<label>`), and the role it works in. */
export interface AgentSpec { label: string; role: Role }

const LABEL = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * The agents `--agent <label>[:<role>]` names, in order: by default one per role, `product` and
 * `engineer`. A label that is a role's name works in that role unless it says otherwise; any other
 * label says its role.
 */
export function parseAgents(values: string[]): AgentSpec[] {
  if (!values.length) return ROLES.map((r) => ({ label: r, role: r }));
  const out: AgentSpec[] = [];
  for (const v of values) {
    const [label, role, extra] = v.split(':');
    if (extra !== undefined || !LABEL.test(label ?? '')) throw new Error(`--agent ${v}: give <label>[:<role>], the label up to 24 lowercase letters, digits and '-'`);
    const r = (role ?? (ROLES.includes(label as Role) ? label : undefined)) as Role | undefined;
    if (!r || !ROLES.includes(r)) throw new Error(`--agent ${v}: say the agent's role, ${ROLES.map((x) => `${label}:${x}`).join(' or ')}`);
    if (out.some((a) => a.label === label)) throw new Error(`--agent ${label} is named twice`);
    out.push({ label, role: r });
  }
  return out;
}

/** The MCP URL `--url` means: a Kolab's origin alone means its /mcp. */
export function mcpUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`--url ${url}: give Kolab's https URL`);
  // Written into the harness's config: never with a user name or password in it.
  if (u.username || u.password) throw new Error('--url: give Kolab\'s URL without a user name or password in it; konjir connect writes it into your harness\'s config');
  if (u.search || u.hash) throw new Error('--url: give Kolab\'s URL without a query or fragment');
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/mcp';
  return u.toString();
}

/** The scope an entry signs in with: what Kolab's consent page preselects (D59). Never a secret. */
export const entryScope = (kolab: string, role: Role, agent: string) => `konjir kolab:${kolab} role:${role} agent:${agent}`;

/** One harness entry to write: its name, and the agent, kolab and role it signs in as. */
export interface Entry { name: string; agent: string; label: string; role: Role; kolab: string; url: string }

/** What OpenCode is given for one entry: a remote MCP server, with the scope that preselects its agent. */
export const opencodeEntry = (e: Entry) => ({ type: 'remote', url: e.url, oauth: { scope: entryScope(e.kolab, e.role, e.agent) } });
/** What Claude Code is given with --http: as `claude mcp add --transport http` writes it, with the scope in its OAuth settings. */
export const claudeEntry = (e: Entry) => ({ type: 'http', url: e.url, oauth: { scopes: entryScope(e.kolab, e.role, e.agent) } });
/** How Claude Code starts the channel bridge: a command and its arguments, as a stdio server's entry names them. */
export interface Bridge { command: string; args: string[] }

/**
 * What Claude Code is given by default (W3.8): the Konjir channel bridge, started as `bridge` says
 * (a checkout's start.sh, or the published konjir's `konjir bridge`), as `claude mcp add --scope
 * project` writes a stdio server. KONJIR_AGENT keeps the agent's sign-in apart; KONJIR_SCOPE
 * preselects it at consent. Neither is a secret.
 */
export const claudeBridgeEntry = (e: Entry, bridge: Bridge | string) => ({
  type: 'stdio', ...(typeof bridge === 'string' ? { command: bridge, args: [] } : { command: bridge.command, args: [...bridge.args] }),
  // KONJIR_TOKEN empty: a token in Claude Code's own environment, which would override the agent's sign-in, isn't passed on.
  env: { KONJIR_URL: e.url, KONJIR_TOKEN: '', KONJIR_AGENT: e.agent, KONJIR_SCOPE: entryScope(e.kolab, e.role, e.agent) },
});

/**
 * The name konjir connect registers under for Claude Code's channel, which Kolab's setup page shows,
 * and the client each agent's sign-in is issued to: the bridge's own CLIENT_NAME, as the agent's
 * own browser sign-in through the bridge would register.
 */
export const CHANNEL_CLIENT_NAME = 'konjir channel (Claude Code)';
/** The name konjir connect registers under for the other harnesses, whose entries sign in by themselves. */
export const CONNECT_CLIENT_NAME = 'konjir connect';

// The published builds (scripts/package.mjs) define this as the package's version.
declare const KONJIR_VERSION: string | undefined;

/** How this konjir runs, for publishedKonjir: `process`, and the version its build defined. Tests give others. */
export interface Running { version?: string; execPath: string; script?: string }
const running = (): Running => ({ version: typeof KONJIR_VERSION === 'string' ? KONJIR_VERSION : undefined, execPath: process.execPath, script: process.argv[1] });

/** A folder a package runner installs into for one run and clears by itself: npx's, pnpm's and yarn's dlx, bunx's. */
const RUN_ONCE = /^(_npx|dlx|dlx-.+|bunx-.+)$/;

/**
 * The published konjir this is (W9.5, API29), or undefined when it isn't one (a checkout, whose
 * build defines no version): how Claude Code starts the bridge it carries, `konjir bridge`, and how
 * a person runs it again (`self`).
 *
 *   a binary                   itself: its own path, `bridge`
 *   installed from npm         the node (or bun) running it, and konjir.mjs where it is installed, `bridge`
 *   run by npx, or a dlx       the same, on a copy of konjir.mjs that konjir keeps in its own config
 *                              folder (`keep`: made once the setup is allowed), since the runner's
 *                              cache is cleared under it. Never `npx konjir bridge`: Claude Code
 *                              starts the bridge in the project, where npx would run a konjir the
 *                              project's own node_modules held
 */
export function publishedKonjir(r: Running = running(), env: Record<string, string | undefined> = process.env): { bridge: Bridge; self: string; keep?: { from: string; to: string } } | undefined {
  if (!r.version) return undefined;
  // A binary's script is inside the executable (Bun's own file system); otherwise it is konjir.mjs, on disk.
  const script = r.script && !r.script.startsWith('/$bunfs') && !/^[A-Z]:\\~BUN\\/.test(r.script) ? r.script : undefined;
  if (!script) return { bridge: { command: r.execPath, args: ['bridge'] }, self: 'konjir' };
  let real = script;
  try { real = realpathSync(script); } catch { /* as given */ }
  if (real.split(/[\\/]/).some((part) => RUN_ONCE.test(part))) {
    const to = join(dirname(credentialsPath(env)), 'bridge', `konjir-${r.version}.mjs`);
    return { bridge: { command: r.execPath, args: [to, 'bridge'] }, self: `npx konjir@${r.version}`, keep: { from: real, to } };
  }
  return { bridge: { command: r.execPath, args: [real, 'bridge'] }, self: 'konjir' };
}

/**
 * Keeps a copy of this konjir.mjs where its entries run it from (publishedKonjir's `keep`):
 * `bridge/` beside konjir's credentials, a folder of konjir's own as `agents/` is, so 0700, and
 * refused if it is a symbolic link or someone else's. One already there with the same bytes is left.
 */
export function keepKonjir(keep: { from: string; to: string }) {
  const dir = dirname(keep.to);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} isn't a folder of konjir's (it is a symbolic link, or not a folder), so konjir won't keep its bridge there: remove it`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to someone else, so konjir won't keep its bridge there: remove it`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  const bytes = readFileSync(keep.from);
  try { if (!lstatSync(keep.to).isSymbolicLink() && readFileSync(keep.to).equals(bytes)) return; } catch { /* not there yet */ }
  const tmp = join(dir, `.${basename(keep.to)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, bytes, { mode: 0o755, flag: 'wx' });
  try { renameSync(tmp, keep.to); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

/**
 * The channel bridge's start.sh in the Kolab checkout this konjir runs from, or undefined when it
 * doesn't run from one: the published package or a binary, which run the bridge they carry
 * (publishedKonjir). Proven from this
 * module's own place, never from a path relative to wherever it was installed: this file must be
 * `<root>/apps/cli/src/connect.ts` (or `dist/connect.js`) inside `<root>`, whose package.json is the
 * kolab workspace, which is a git checkout, and whose `apps/channel-bridge` is the bridge's package.
 * `moduleUrl` is for tests.
 */
export function bridgeCommand(moduleUrl: string = import.meta.url): string | undefined {
  try {
    const self = realpathSync(fileURLToPath(moduleUrl));
    const where = dirname(self);
    if (!['src', 'dist'].includes(basename(where)) || basename(dirname(where)) !== 'cli' || basename(dirname(dirname(where))) !== 'apps') return undefined;
    const root = dirname(dirname(dirname(where)));
    const json = (path: string) => JSON.parse(readText(path) || '{}') as { name?: string; workspaces?: unknown };
    const workspace = json(join(root, 'package.json'));
    if (workspace.name !== 'kolab' || !Array.isArray(workspace.workspaces)) return undefined;
    if (!existsSync(join(root, '.git'))) return undefined;
    if (json(join(root, 'apps', 'cli', 'package.json')).name !== 'konjir') return undefined;
    if (json(join(root, 'apps', 'channel-bridge', 'package.json')).name !== '@konjir/channel-bridge') return undefined;
    const start = realpathSync(join(root, 'apps', 'channel-bridge', 'scripts', 'start.sh'));
    // Both inside this same checkout, as real paths: no link leads either elsewhere.
    if (!inside(self, realpathSync(join(root, 'apps', 'cli'))) || !inside(start, realpathSync(join(root, 'apps', 'channel-bridge')))) return undefined;
    return start;
  } catch {
    return undefined;
  }
}

/** The agent, role and kolab an entry konjir connect wrote signs in as, from its scope: `konjir kolab:<k> role:<r> agent:<a>`. */
export interface Who { agent: string; role: string; kolab: string }

/** The system prompt API24 describes: who the agent is, where, and where its rules come from. */
export const systemPrompt = (w: Who, name: string) =>
  `You are ${w.agent}, an agent working in Konjir kolab ${w.kolab} in the ${w.role} role, through the ${name} tools. ` +
  'Call konjir_instructions before your first change, and konjir_instructions which=reviewer before you review a version; follow them.';

/** Claude Code's folder of subagents: the project's, or with --global the person's own. */
export const claudeAgentsDir = (opts: { global: boolean; cwd: string; env: Record<string, string | undefined> }) =>
  opts.global ? join(opts.env.CLAUDE_CONFIG_DIR || join(opts.env.HOME || homedir(), '.claude'), 'agents') : join(opts.cwd, '.claude', 'agents');

/**
 * One agent's Claude Code subagent (`--subagents`, API29), `<label>.md`: its tools are its own
 * entry's alone, `mcp__konjir-<label>__*`, so in a session that loads several entries each subagent
 * works as one agent, and has no other tool; its prompt is the one konjir claude gives a session.
 */
export const subagentFile = (e: Entry) => [
  '---',
  `name: ${e.label}`,
  `description: Works in Konjir as ${e.agent}, in the ${e.role} role in kolab ${e.kolab}. Give it that agent's Konjir work.`,
  `tools: mcp__${e.name}__*`,
  '---',
  '',
  systemPrompt(e, e.name),
  '',
].join('\n');

/** A planned change to one configuration file: its text before (empty when it is new) and after. */
export interface FileChange { path: string; before: string; after: string; exists: boolean }

/** Where OpenCode's configuration is: the project's (the folder's) or, with --global, the person's. Its `.jsonc` form when only that one exists. */
export function opencodePath(opts: { global: boolean; cwd: string; env: Record<string, string | undefined> }): string {
  const dir = opts.global ? join(opts.env.XDG_CONFIG_HOME || join(opts.env.HOME || homedir(), '.config'), 'opencode') : opts.cwd;
  const json = join(dir, 'opencode.json');
  const withComments = join(dir, 'opencode.jsonc');
  return !existsSync(json) && existsSync(withComments) ? withComments : json;
}

/** Claude Code's file of the person's own (user-scope) settings, which `claude mcp add --scope user` writes. Only read here. */
export const claudeUserConfig = (env: Record<string, string | undefined>) =>
  join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), '.claude.json');

/**
 * OpenCode's configuration with the entries merged in, under `mcp`: every other key, comment and
 * line kept as it is, and the indentation the file already uses. OpenCode reads JSON with comments
 * and trailing commas, so this does too; a file it can't parse is refused, never rewritten.
 * Existing `konjir-<label>` entries are refused unless `force`. The result is checked before it is
 * returned (checkMerge): anything but the entries set, everything else as it was, is refused.
 */
export function mergeOpencode(path: string, before: string, entries: Entry[], force: boolean): string {
  const text = before.trim() ? before : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const root = parseOrRefuse(path, text, 'OpenCode');
  if (root.type !== 'object') throw new Error(`${path} isn't an OpenCode configuration (not a JSON object), so konjir connect won't touch it`);
  const mcp = member(root, 'mcp');
  if (mcp && mcp.type !== 'object') throw new Error(`${path}: its "mcp" is ${mcp.type === 'null' ? 'null' : 'not an object'}, so konjir connect won't touch it: make it {} or remove it, then run konjir connect again`);
  refuseTaken(path, entries, (mcp ? valueOf(mcp) : {}) as Record<string, unknown>, force, opencodeEntry);
  const after = setEntries(text, 'mcp', entries.map((e) => [e.name, opencodeEntry(e)]));
  checkMerge(path, text, after, 'mcp', entries.map((e) => [e.name, opencodeEntry(e)]));
  return after;
}

/**
 * The project's `.mcp.json` with the entries merged in under `mcpServers`. A new file is written as
 * `claude mcp add --scope project` writes it, the whole of it JSON with two-space indentation; an
 * existing one is edited in place, every other key, number and line kept as it is. Claude Code
 * reads it as plain JSON, so a file that isn't (comments included) is refused, never rewritten.
 * Existing entries are refused unless `force`; the result is checked as OpenCode's is.
 */
export function mergeClaude(path: string, before: string, entries: Entry[], force: boolean, make: (e: Entry) => unknown = claudeEntry): string {
  const set: [string, unknown][] = entries.map((e) => [e.name, make(e)]);
  if (!before.trim()) return JSON.stringify({ mcpServers: Object.fromEntries(set) }, null, 2);
  let config: unknown;
  try { config = JSON.parse(before); } catch (e) {
    throw new Error(`${path} isn't JSON (${(e as Error).message}), so konjir connect won't touch it: fix it, then run konjir connect again`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${path} isn't a Claude Code MCP configuration (not a JSON object), so konjir connect won't touch it`);
  const raw = config as Record<string, unknown>;
  const servers = 'mcpServers' in raw ? raw.mcpServers : {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`${path}: its "mcpServers" is ${servers === null ? 'null' : 'not an object'}, so konjir connect won't touch it: make it {} or remove it, then run konjir connect again`);
  refuseTaken(path, entries, servers as Record<string, unknown>, force, make);
  const after = setEntries(before, 'mcpServers', set);
  checkMerge(path, before, after, 'mcpServers', set);
  try { JSON.parse(after); } catch { throw new Error(`konjir connect couldn't merge into ${path} safely, so nothing is written: add the entries by hand`); }
  return after;
}

function parseOrRefuse(path: string, text: string, reader: string): JsonNode {
  try { return parseTree(text); } catch (e) {
    if (!(e instanceof JsoncError)) throw e;
    throw new Error(`${path} isn't JSON that ${reader} reads (${e.message}), so konjir connect won't touch it: fix it, then run konjir connect again`);
  }
}

/** Sets each [key, value] under the root's `section` object, made if it isn't there, by editing the text. */
function setEntries(text: string, section: string, set: [string, unknown][]): string {
  for (const [key, value] of set) {
    const tree = parseTree(text);
    const servers = member(tree, section);
    text = servers ? setMember(text, servers, key, value) : setMember(text, tree, section, { [key]: value });
  }
  return text;
}

/** JSON's value with every object's keys in order, to compare two values whatever order their keys are in. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

/**
 * The merge checked before anything is written: `after` parses; its value is `before`'s with
 * exactly `set` under `section`, and nothing else changed; and every comment of `before` is still
 * in it, in order. Anything else is refused, so an edit gone wrong is never written.
 */
function checkMerge(path: string, before: string, after: string, section: string, set: [string, unknown][]) {
  const refuse = (why: string) => new Error(`konjir connect couldn't merge into ${path} safely (${why}), so nothing is written: add the entries by hand, or tell us at github.com/konjir/kolab`);
  let got: unknown;
  try { got = valueOf(parseTree(after)); } catch { throw refuse('the result wouldn\'t parse'); }
  const was = valueOf(parseTree(before.trim() ? before : '{}')) as Record<string, unknown>;
  const want = { ...was, [section]: { ...((was[section] as Record<string, unknown> | undefined) ?? {}), ...Object.fromEntries(set) } };
  if (canonical(got) !== canonical(want)) throw refuse('the result would differ from the file with just the entries added');
  const kept = commentsOf(after);
  let k = 0;
  for (const c of commentsOf(before)) {
    while (k < kept.length && kept[k] !== c) k++;
    if (k++ >= kept.length) throw refuse('a comment would be lost');
  }
}

/** The indentation one level takes in `text`: what its first indented key uses, or two spaces. */
const indentUnit = (text: string) => {
  const first = /\n([ \t]+)"/.exec(text)?.[1];
  return first?.startsWith('\t') ? '\t' : first || '  ';
};
/** The whitespace a line starts with, for the line `offset` is on. */
const indentAt = (text: string, offset: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1))![0];
const sameLine = (text: string, a: number, b: number) => !text.slice(a, b).includes('\n');

/**
 * Sets `key` in the object `obj` of `text` to `value`, by editing the text alone, from its tokens:
 * - a member already there has its value replaced where it stands, every copy of it if the key is
 *   there more than once, so whichever copy a reader takes (the last, as JSON.parse does) is new;
 * - a new one goes after the last member and every comment that follows it, never inside one, on
 *   a line of its own at that member's indentation, with a comma after the last member only if it
 *   has none (a comma before a comment counts), and the file's trailing-comma habit kept;
 * - in an empty object, after any comment in it, which stays.
 */
function setMember(text: string, obj: JsonNode, key: string, value: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentUnit(text);
  const show = (v: unknown, base: string) => JSON.stringify(v, null, unit).split('\n').join(eol + base);
  const members = obj.children ?? [];
  const copies = members.filter((p) => p.value === key);
  if (copies.length) {
    for (const p of [...copies].reverse()) {
      const v = p.children![1];
      text = text.slice(0, v.offset) + show(value, indentAt(text, p.offset)) + text.slice(v.offset + v.length);
    }
    return text;
  }
  const close = obj.offset + obj.length - 1;
  const objIndent = indentAt(text, obj.offset);
  const last = members.at(-1);
  const from = last ? last.offset + last.length : obj.offset + 1;
  const after = [...tokens(text, from, close, { comments: true })].filter((t) => t.kind !== 'eof');
  // After everything between the last member and the close: its comma and its comments.
  let at = after.length ? after.at(-1)!.end : from;
  if (after.at(-1)?.kind === 'comment' && text[at - 1] === '\r') at--;   // a line comment's CR stays with its line
  const comma = after.some((t) => t.kind === ',');
  const base = last && !sameLine(text, obj.offset, last.offset) ? indentAt(text, last.offset) : objIndent + unit;
  const tail = sameLine(text, at, close) ? `${eol}${objIndent}` : '';
  const line = `${eol}${base}${JSON.stringify(key)}: ${show(value, base)}${last && comma ? ',' : ''}${tail}`;
  const head = last && !comma ? `${text.slice(0, from)},${text.slice(from, at)}` : text.slice(0, at);
  return `${head}${line}${text.slice(at)}`;
}

/**
 * Refuses, unless `force`, to replace an entry already there, `existing[name]`: one that already
 * says exactly what `make` would write (konjir connect run again) isn't replaced, so it passes.
 */
function refuseTaken(where: string, entries: Entry[], existing: Record<string, unknown>, force: boolean, make: (e: Entry) => unknown) {
  const taken = entries.filter((e) => e.name in existing && canonical(existing[e.name]) !== canonical(make(e))).map((e) => e.name);
  if (taken.length && !force) {
    throw new Error(`${where} already has ${taken.join(', ')}. konjir connect won't overwrite ${taken.length === 1 ? 'it' : 'them'}: pass --force to replace ${taken.length === 1 ? 'it' : 'them'}, or choose other labels with --agent`);
  }
}

/**
 * A unified diff of `before` and `after`, three lines of context, for the person to read before
 * anything is written. Configuration files are small, so a plain longest-common-subsequence will do.
 */
export function unifiedDiff(path: string, before: string, after: string, exists: boolean): string {
  const a = before ? before.split('\n') : [];
  const b = after.split('\n');
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string; i: number; j: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: ' ', s: a[i], i, j }); i++; j++; }
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push({ t: '-', s: a[i], i, j }); i++; }
    else { ops.push({ t: '+', s: b[j], i, j }); j++; }
  }
  const out = [`--- ${exists ? path : '/dev/null'}`, `+++ ${path}`];
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  for (let k = 0; k < changed.length;) {
    const start = Math.max(0, changed[k] - 3);
    let end = changed[k];
    while (k < changed.length && changed[k] <= end + 6) { end = changed[k]; k++; }
    const stop = Math.min(ops.length - 1, end + 3);
    const hunk = ops.slice(start, stop + 1);
    const aLen = hunk.filter((o) => o.t !== '+').length, bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aLen ? hunk[0].i + 1 : hunk[0].i},${aLen} +${bLen ? hunk[0].j + 1 : hunk[0].j},${bLen} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
  }
  return out.join('\n');
}

/**
 * Writes `text` to `path` atomically: whole, to a new file of a random name beside it (O_EXCL,
 * so never through a link left there), with the file's own mode if it has one, then moved into
 * place. A path that is a symbolic link is written where it leads, so the link stays.
 */
export function writeAtomically(path: string, text: string, opts: { within?: string; mode?: number } = {}) {
  let target = path;
  const link = linkTarget(path);
  if (link) {
    if (!link.real) throw new Error(`${path} is a link to ${link.to}, which isn't there; konjir won't write through it`);
    target = link.real;
  }
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  // A mode given is kept to; else the file's own, or 0644 for a new one.
  let mode = opts.mode ?? 0o644;
  if (opts.mode === undefined) try { mode = statSync(target).mode & 0o777; } catch { /* new */ }
  const tmp = join(dir, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { mode, flag: 'wx' });
  try {
    // Checked again just before the rename, as real paths: a link or folder swapped in meanwhile
    // can't aim the write outside `within`, nor replace a link with a file.
    if (opts.within !== undefined) {
      const now = linkTarget(path);
      const real = join(realpathSync(dirname(target)), basename(target));
      if ((link ? now?.real !== target : !!now) || !inside(real, opts.within)) throw new Error(`${path} changed while konjir connect wrote it, or leads outside ${opts.within}; nothing written`);
    }
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`${target} isn't a regular file; nothing written`);
    renameSync(tmp, target);
  } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

/** The most of a config file konjir connect reads: a harness's config is far smaller. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * A config file's text, or '' if there is none: only a regular file (a link is followed to one; a
 * link to nothing reads as none, and writeAtomically refuses it), of at most MAX_CONFIG_BYTES, read
 * from the descriptor it was checked through, so a FIFO, a device or a folder is never read.
 */
function readText(path: string): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return '';
    throw new Error(`konjir connect can't read ${path} (${(e as { code?: string }).code ?? e})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} isn't a regular file, so konjir connect won't read or write it`);
    if (st.size > MAX_CONFIG_BYTES) throw new Error(`${path} is over ${MAX_CONFIG_BYTES / 1024 / 1024} MiB, far more than a harness's config; konjir connect won't read it`);
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r;
    if (n > st.size) throw new Error(`${path} grew while konjir connect read it; run konjir connect again`);
    return buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
}

/** A config file's text, as konjir connect reads it (readText), for konjir claude. */
export const readConfigText = (path: string) => readText(path);

/** What `konjir connect` is asked to do. */
export interface ConnectOptions {
  harness: Harness;
  /** Kolab's MCP URL. */
  url: string;
  /** The kolab to connect to: the person's own, or one they reach; made now, private and theirs, if no kolab has that name. */
  kolab?: string;
  agents: AgentSpec[];
  global: boolean;
  force: boolean;
  /** Write a config file that is a link to somewhere outside the project (or, with --global, the config folder). */
  forcePath?: boolean;
  /** Print the plan, and stop: nothing made, written or signed in. */
  dryRun?: boolean;
  /** Sign each entry in: for Claude Code's channel, have Kolab issue each agent's sign-in at the setup; for OpenCode, run its own sign-in. Without it, each entry signs in by itself later. */
  auth: boolean;
  /** Claude Code: write the plain HTTP entry (no channel) instead of the channel bridge. */
  http?: boolean;
  /** Claude Code: how the channel bridge starts (a start.sh alone, or a command and its arguments); by default the checkout's this konjir runs from, else the published konjir's own. */
  bridge?: string | Bridge;
  /** Claude Code: also write one subagent per agent, `.claude/agents/<label>.md`, with only its entry's tools. */
  subagents?: boolean;
  /** How a person runs this konjir again, in the steps printed last: `konjir` by default, or the published one's own (npx). */
  self?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

/** What `konjir connect` asks Kolab to set up, on its one page. */
export interface SetupRequest {
  /** Kolab's MCP URL. */
  url: string;
  /** The setup's scope: `konjir kolab:<k> setup:<label>:<role> …` (setupScopeOf). */
  scope: string;
  /** Whether Kolab issues each agent's own sign-in (Claude Code's channel), or only sets them up. */
  mint: boolean;
  /** The name konjir registers under, which Kolab's page shows, and which each agent's sign-in is issued to. */
  clientName: string;
  /** What the terminal says as the browser opens (the link follows it). */
  opening: string;
}

/** The world `konjir connect` acts on, so tests can stand in for the browser, the harnesses and Kolab. */
export interface ConnectIO {
  log: (line: string) => void;
  /** Runs a harness's own command, attached to the terminal; resolves with its exit code (-1 if it can't start). */
  run: (cmd: string, args: string[], opts: { cwd: string }) => Promise<number>;
  /** The setup (@konjir/login's setup): the browser opened once, at Kolab's setup page; what the person allowed there. */
  setup: (r: SetupRequest) => Promise<SetupDone>;
}

/** The default terminal: runs commands attached to it, and sets up with the person's browser. */
export const terminalIO = (setUp: ConnectIO['setup']): ConnectIO => ({
  log: (line) => console.log(line),
  run: (cmd, args, opts) => new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  }),
  setup: setUp,
});

/** A setup's scope, which names the kolab and each agent by its label and role: what Kolab's setup page shows, and all it allows. Never a secret. */
export const setupScopeOf = (kolab: string, agents: AgentSpec[]) => ['konjir', `kolab:${kolab}`, ...agents.map((a) => `setup:${a.label}:${a.role}`)].join(' ');

/** Who stands in the plan for the person until they sign in: the plan's agent names are `<you>-<label>`. */
const YOU = '<you>';

/** How to start Claude Code with the Konjir channel entries (a development channel, during the research preview). */
function channelSteps(entries: Entry[], cwd: string, global: boolean, signedIn: boolean, self: string, local: boolean): string[] {
  return [
    ...(global || !local ? [] : ['The entries in this project\'s .mcp.json name this machine\'s paths, as konjir claude\'s files in .claude/ do, so don\'t commit them.']),
    'At its development-channels warning, choose "I am using this for local development". Channels need Claude Code signed in with a claude.ai account.',
    ...(signedIn ? [] : ['Each entry signs in by itself in your browser when Claude Code first starts it, on a page locked to its agent.']),
    ...sessionSteps(entries, cwd, self),
  ];
}

/**
 * One `konjir claude <label>` per agent (API24): each starts Claude Code with that agent's entry and
 * channel alone, and its system prompt, rather than one session that loads every agent's channel.
 */
function sessionSteps(entries: Entry[], cwd: string, self = 'konjir'): string[] {
  return [`Start each agent's own Claude Code session, one terminal each, from ${cwd}:`,
    ...entries.map((e) => `${self} claude ${e.label}`)];
}

/** The steps that sign an entry in by hand, per harness. */
function signInSteps(harness: Harness, entries: Entry[], cwd: string, global: boolean, self = 'konjir'): string[] {
  if (harness === 'opencode') {
    return [`Sign each entry in, one at a time${global ? '' : `, from ${cwd}`}:`,
      ...entries.map((e) => `  opencode mcp auth ${e.name}     # Kolab's page is for ${e.agent} alone, in kolab ${e.kolab} as ${e.role}: check it, then Allow`)];
  }
  return ['Each entry signs in the first time its session starts: in it, type /mcp, choose the entry, then Authenticate.',
    ...entries.map((e) => `  ${e.name}: Kolab's page is for ${e.agent} alone, in kolab ${e.kolab} as ${e.role}: check it, then Allow.`),
    ...sessionSteps(entries, cwd, self)];
}

/** A kolab name `--kolab` may give: Kolab's grammar (lowercase letters, digits and '-', starting with a letter or digit, at most 100). */
const KOLAB = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `konjir connect` (Lee's instruction of 2026-11-01): one command, one browser page. It checks what
 * it can first (the kolab's name, the config file, the entries already there), prints the plan, and
 * opens the browser once at Kolab's setup page, locked to what it asks: the kolab, made now if it is
 * new, and each agent with its role, made now or reused. On Allow, Kolab makes them and grants each
 * agent in the kolab; for Claude Code's channel it also issues each agent its own sign-in, which
 * konjir keeps in that agent's credentials file, where the bridge finds it. Then the config is
 * written atomically, and for OpenCode each entry signs in by itself. Denied, or refused on the page
 * (a kolab of that name the person can't reach, say), nothing is written. Returns the entries.
 */
export async function connectHarness(opts: ConnectOptions, io: ConnectIO): Promise<Entry[]> {
  if (opts.kolab === undefined) throw new Error('konjir connect needs --kolab <name>: a kolab of yours or one you reach, or a new one, made private and yours on Kolab\'s page');
  if (!KOLAB.test(opts.kolab) || opts.kolab.length > 100) throw new Error(`--kolab ${opts.kolab.slice(0, 120)}: a kolab's name is lowercase letters, digits and '-', starting with a letter or digit (a new one, at most 40)`);
  if (opts.http && opts.harness !== 'claude') throw new Error('--http is for Claude Code: OpenCode\'s entries are always its remote MCP server');
  if (opts.subagents && opts.harness !== 'claude') throw new Error('--subagents is for Claude Code: it writes Claude Code\'s subagents, one per agent');
  // Claude Code's entry: the channel bridge (W3.8), the checkout's own or the one the published konjir
  // carries (W9.5); or, with --http, the plain HTTP server.
  const channel = opts.harness === 'claude' && !opts.http;
  const published = publishedKonjir();
  const bridge = channel ? opts.bridge ?? bridgeCommand() ?? published?.bridge : undefined;
  if (channel && !bridge) {
    throw new Error('konjir connect claude sets up the Konjir channel, Claude Code\'s one Konjir server, which the published konjir carries and a checkout of github.com/konjir/kolab runs from its own source, and this konjir is neither. Run it as <checkout>/bin/konjir connect claude or from the npm package, or pass --http for Claude Code\'s plain HTTP entry (no channel)');
  }
  const claudeMake = bridge ? (e: Entry) => claudeBridgeEntry(e, bridge) : claudeEntry;
  const self = opts.self ?? published?.self ?? 'konjir';
  // Whether the entries name this machine's paths: all but the published konjir run by npx.
  const local = !!bridge && /[\\/]/.test(typeof bridge === 'string' ? bridge : bridge.command);
  const kolab = opts.kolab;

  // The plan for `person`: each file's text after, or for Claude Code's own user settings, its
  // commands. Made first with `<you>` in the person's place, so a config konjir won't touch, or an
  // entry already there, stops it before any browser opens; again once the person is known.
  const planFor = (person: string) => {
    const entries: Entry[] = opts.agents.map((a) => ({ name: `konjir-${a.label}`, agent: `${person}-${a.label}`, label: a.label, role: a.role, kolab, url: opts.url }));
    let change: FileChange | undefined;
    let commands: string[][] = [];
    if (opts.harness === 'opencode') {
      const path = opencodePath(opts);
      const before = readText(path);
      change = { path, before, after: mergeOpencode(path, before, entries, opts.force), exists: existsSync(path) };
    } else if (!opts.global) {
      const path = join(opts.cwd, '.mcp.json');
      const before = readText(path);
      change = { path, before, after: mergeClaude(path, before, entries, opts.force, claudeMake), exists: existsSync(path) };
    } else {
      // Claude Code's user settings are its own file, which it rewrites as it runs: konjir only reads
      // it, to refuse an entry already there, and lets Claude Code's own command write it.
      const path = claudeUserConfig(opts.env);
      let parsed: unknown;
      try { parsed = JSON.parse(readText(path) || '{}'); } catch {
        throw new Error(`${path} isn't JSON, so konjir connect can't tell which servers Claude Code already has: fix it, then run konjir connect again`);
      }
      const s = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).mcpServers ?? {} : null;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${path}: its "mcpServers" isn't an object, so konjir connect can't tell which servers Claude Code already has`);
      const servers = s as Record<string, unknown>;
      refuseTaken(`Claude Code's user settings (${path})`, entries, servers, opts.force, claudeMake);
      commands = entries.flatMap((e) => [
        ...(e.name in servers ? [['claude', 'mcp', 'remove', '--scope', 'user', e.name]] : []),
        ['claude', 'mcp', 'add-json', '--scope', 'user', e.name, JSON.stringify(claudeMake(e))],
      ]);
    }
    // Each agent's subagent (--subagents): one already there that says anything else is refused, as an entry is.
    const agents: FileChange[] = !opts.subagents ? [] : entries.map((e) => {
      const path = join(claudeAgentsDir(opts), `${e.label}.md`);
      refuseLinkedSubagent(path, opts.global ? dirname(dirname(path)) : opts.cwd);
      const before = readText(path);
      return { path, before, after: subagentFile(e), exists: existsSync(path) };
    });
    const taken = agents.filter((a) => a.exists && a.before !== a.after).map((a) => a.path);
    if (taken.length && !opts.force) throw new Error(`${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already there and ${taken.length === 1 ? 'says' : 'say'} something else. konjir connect won't overwrite ${taken.length === 1 ? 'it' : 'them'}: pass --force to replace ${taken.length === 1 ? 'it' : 'them'}, or choose other labels with --agent`);
    return { entries, change, commands, agents };
  };

  // Run again, the entries already there name the person; else `<you>` stands for them until they sign in.
  const known = personIn(opts.harness === 'opencode' ? opencodePath(opts) : opts.global ? claudeUserConfig(opts.env) : join(opts.cwd, '.mcp.json'), opts.agents, opts.url);
  const draft = planFor(known ?? YOU);
  io.log(`konjir connect ${opts.harness}: kolab ${kolab} at ${opts.url}, ${draft.entries.length === 1 ? 'one agent' : `${draft.entries.length} agents`}, one entry each${known ? '' : ` (${YOU} is the name you sign in to Kolab as)`}:`);
  for (const e of draft.entries) io.log(`  ${e.name}  as ${e.agent}, ${e.role}`);
  io.log('');
  if (draft.change) {
    // A link is written where it leads: only inside the project (or the config folder), unless
    // --force-path, so a cloned repository's link can't aim an edit elsewhere.
    const target = linkTarget(draft.change.path);
    if (target) {
      const root = opts.global ? dirname(draft.change.path) : opts.cwd;
      if (!target.real) throw new Error(`${draft.change.path} is a link to ${target.to}, which isn't there; konjir connect won't write through it. Remove the link, then run konjir connect again`);
      if (!inside(target.real, root) && !opts.forcePath) {
        throw new Error(`${draft.change.path} is a link to ${target.real}, outside ${root}; konjir connect won't write there. Pass --force-path if you mean it to`);
      }
      io.log(`${draft.change.path} is a link to ${target.real}, which konjir connect would change.`);
    }
    if (draft.change.before === draft.change.after) io.log(`${draft.change.path} already says exactly this.`);
    // A new file in one line; the diff for a file that is there already, or with --dry-run.
    else if (!draft.change.exists && !opts.dryRun) io.log(`Will write ${draft.change.path}: ${draft.entries.length === 1 ? 'one entry' : `${draft.entries.length} entries`}, ${draft.entries.map((e) => e.name).join(', ')}.`);
    else io.log(unifiedDiff(draft.change.path, draft.change.before, draft.change.after, draft.change.exists));
  } else {
    io.log('Claude Code\'s own command will write them to your user settings:');
    for (const c of draft.commands) io.log(`  ${c.map(shellWord).join(' ')}`);
  }
  for (const a of draft.agents) {
    // A new file in one line; the diff for one that is there already (--force replaces it), or with --dry-run.
    io.log(a.before === a.after ? `${a.path} already says exactly this.` : a.exists || opts.dryRun ? unifiedDiff(a.path, a.before, a.after, a.exists) : `Will write ${a.path}: the subagent ${basename(a.path, '.md')}, with only its entry's tools.`);
  }
  io.log('');
  if (opts.dryRun) {
    io.log('Dry run: nothing made, written or signed in.');
    return draft.entries;
  }

  // The one page: the person signs in, and allows exactly this. Kolab makes and grants it all.
  const mint = channel && opts.auth;
  const done = await io.setup({
    url: opts.url, scope: setupScopeOf(kolab, opts.agents), mint, clientName: channel ? CHANNEL_CLIENT_NAME : CONNECT_CLIENT_NAME,
    opening: `Opening your browser at Kolab's setup page: sign in, check it names kolab ${kolab} and ${draft.entries.length === 1 ? 'this agent' : `these ${draft.entries.length} agents`}, then Allow.`,
  });
  const issued = done.agents.flatMap((a) => (a.tokens ? [a.tokens] : []));
  // Anything that fails from here revokes the sign-ins the setup just issued, so none is left standing unused.
  let kept = 0;
  const failed = async (e: unknown): Promise<never> => {
    const revoked = issued.length ? await revokeIssued(opts.url, done.client, issued) : 0;
    // Never "nothing written" once an agent's credentials file was.
    const said = String((e as Error)?.message ?? e).replace(/\.$/, '').replace(kept ? /[;,] nothing (is )?written\b/g : /$^/, '');
    const signIns = !issued.length ? ''
      : revoked === issued.length ? `. The ${issued.length === 1 ? 'agent\'s new sign-in was' : `agents' ${issued.length} new sign-ins were`} revoked`
        : `. ${issued.length - revoked} of the agents' ${issued.length} new sign-ins couldn't be revoked; unused, they lapse within 30 days`;
    const files = kept ? `; ${kept === 1 ? 'one agent\'s credentials file was' : `${kept} agents' credentials files were`} written before it failed, and ${kept === 1 ? 'holds' : 'hold'} a sign-in that no longer works` : '';
    throw new Error(`${said}${signIns}${files}. Run konjir connect again`);
  };

  // Everything checked before anything is kept or written: the plan for the person who signed in,
  // that Kolab set up exactly what was asked, and that the config file hasn't changed meanwhile.
  let plan: ReturnType<typeof planFor>;
  try {
    // Kolab's names go into the config and each subagent's file: only a name Kolab's grammar allows does.
    for (const name of [done.person, ...done.agents.map((a) => a.agent)]) {
      if (typeof name !== 'string' || !KOLAB.test(name) || name.length > 100) throw new Error('Kolab named a person or an agent in a way no name is written, so nothing is written');
    }
    plan = planFor(done.person);
    if (done.kolab.id !== kolab || done.agents.length !== plan.entries.length || done.agents.some((a, k) => a.agent !== plan.entries[k].agent || a.role !== plan.entries[k].role || (mint && !a.tokens))) {
      throw new Error('Kolab set up something other than konjir connect asked for, so nothing is written');
    }
    if (plan.change && readText(plan.change.path) !== draft.change!.before) throw new Error(`${plan.change.path} changed while konjir connect was waiting; nothing written`);
    for (const [k, a] of plan.agents.entries()) if (readText(a.path) !== draft.agents[k].before) throw new Error(`${a.path} changed while konjir connect was waiting; nothing written`);
  } catch (e) { return failed(e); }
  const { entries } = plan;
  io.log(`Set up for ${done.person}: kolab ${kolab}${done.kolab.made ? ' (made now, private, yours)' : ''}; ${done.agents.map((a) => `${a.agent}${a.made ? ' (made now)' : ''}`).join(', ')}.`);

  try {
    // Each agent's own sign-in, kept where the bridge started with KONJIR_AGENT finds it.
    if (mint) {
      for (const a of done.agents) {
        await keepSignIn(opts.url, agentCredentials(a.agent, opts.env), { client: done.client, tokens: a.tokens!, discovery: done.discovery });
        kept++;
      }
    }
    // What the entries name is there before they are: the bridge konjir keeps, and each subagent.
    if (channel && !opts.bridge && !bridgeCommand() && published?.keep) keepKonjir(published.keep);
    for (const a of plan.agents) {
      if (a.after === a.before) { io.log(`${a.path} already says this; left as it is.`); continue; }
      writeAtomically(a.path, a.after, { within: opts.global ? dirname(dirname(a.path)) : opts.cwd });
      io.log(`Wrote ${a.path}.`);
    }
    if (plan.change) {
      if (plan.change.after === plan.change.before) io.log(`${plan.change.path} already says this; left as it is.`);
      else {
        writeAtomically(plan.change.path, plan.change.after, opts.forcePath ? {} : { within: opts.global ? dirname(plan.change.path) : opts.cwd });
        io.log(`Wrote ${plan.change.path}. It holds no token.`);
      }
    } else {
      for (const c of plan.commands) {
        if (await io.run(c[0], c.slice(1), { cwd: opts.cwd }) !== 0) throw new Error(`${c.slice(0, 3).join(' ')} didn't succeed${c[0] === 'claude' ? ' (is Claude Code installed, and claude on your PATH?)' : ''}`);
      }
      io.log('Claude Code has them in your user settings. They hold no token.');
    }
  } catch (e) { return failed(e); }

  if (channel) {
    if (mint) io.log(`Each agent is signed in, in its own file under ${dirname(agentCredentialsPath(entries[0].agent, opts.env))}.`);
    for (const line of channelSteps(entries, opts.cwd, opts.global, mint, self, local)) io.log(line);
    return entries;
  }
  // OpenCode and Claude Code's plain HTTP entries sign in by themselves, each on a page locked to its agent.
  if (opts.harness === 'opencode' && opts.auth) {
    for (const [k, e] of entries.entries()) {
      io.log(`Signing ${e.name} in as ${e.agent}. Kolab's page is for ${e.agent} alone, in kolab ${e.kolab} as ${e.role}: check it, then Allow.`);
      const code = await io.run('opencode', ['mcp', 'auth', e.name], { cwd: opts.cwd });
      if (code !== 0) {
        io.log(`opencode mcp auth ${e.name} didn't finish${code === -1 ? ' (is OpenCode installed, and opencode on your PATH?)' : ''}.`);
        for (const line of signInSteps('opencode', entries.slice(k), opts.cwd, opts.global)) io.log(line);
        return entries;
      }
    }
    io.log(`Connected: each entry works as its own agent in ${kolab}.`);
  } else {
    for (const line of signInSteps(opts.harness, entries, opts.cwd, opts.global, self)) io.log(line);
  }
  return entries;
}

/**
 * The person the `konjir-<label>` entries already in `path` sign in for, when konjir connect wrote
 * them for this Kolab before: their agent, `<person>-<label>`, from KONJIR_AGENT (the channel) or the
 * scope's `agent:` (OpenCode's and Claude Code's HTTP entries). Only to show the plan by name, and
 * to see that a run again writes nothing new; undefined when it can't tell.
 */
function personIn(path: string, agents: AgentSpec[], url: string): string | undefined {
  let config: unknown;
  try { config = valueOf(parseTree(readText(path) || '{}')); } catch { return undefined; }
  const c = (config ?? {}) as { mcp?: Record<string, unknown>; mcpServers?: Record<string, unknown> };
  const servers = (c.mcpServers ?? c.mcp ?? {}) as Record<string, { url?: string; env?: { KONJIR_AGENT?: string; KONJIR_URL?: string }; oauth?: { scope?: string; scopes?: string } } | undefined>;
  for (const a of agents) {
    const e = servers?.[`konjir-${a.label}`];
    if (!e || typeof e !== 'object' || (e.url ?? e.env?.KONJIR_URL) !== url) continue;
    const agent = e.env?.KONJIR_AGENT ?? (e.oauth?.scope ?? e.oauth?.scopes ?? '').split(' ').find((w) => w.startsWith('agent:'))?.slice('agent:'.length);
    if (typeof agent === 'string' && agent.endsWith(`-${a.label}`) && /^[a-z0-9][a-z0-9-]*$/.test(agent)) return agent.slice(0, -`-${a.label}`.length);
  }
  return undefined;
}

/**
 * Refuses a subagent's file konjir connect would write outside `root` (the project, or with
 * --global Claude Code's own folder): one that is a link, or whose folder, as far as it exists yet,
 * really is somewhere else (`.claude` or `.claude/agents` linked away). Checked with the plan,
 * before the file is read or any browser opens, so nothing is made, read or left behind out there.
 */
function refuseLinkedSubagent(path: string, root: string) {
  if (linkTarget(path)) throw new Error(`${path} is a link; konjir connect won't write a subagent through it. Remove the link, then run konjir connect again`);
  // Each as it really is, as far as it exists yet: what is still to be made is made where it says.
  const really = (p: string): string => {
    const rest: string[] = [];
    let dir = p;
    while (!existsSync(dir) && dirname(dir) !== dir) { rest.unshift(basename(dir)); dir = dirname(dir); }
    return join(realpathSync(dir), ...rest);
  };
  let real: string, within: string;
  try { real = really(dirname(path)); within = really(root); } catch { throw new Error(`${dirname(path)} can't be read, so konjir connect won't write a subagent there`); }
  if (real !== within && !real.startsWith(within.endsWith(sep) ? within : within + sep)) throw new Error(`${dirname(path)} leads to ${real}, outside ${root}; konjir connect won't write a subagent there. Remove the link, then run konjir connect again`);
}

/** Where a link at `path` leads, if `path` is one: `real` is the file it reaches, if that is there. */
function linkTarget(path: string): { to: string; real?: string } | undefined {
  let st;
  try { st = lstatSync(path); } catch { return undefined; }
  if (!st.isSymbolicLink()) return undefined;
  const to = readlinkSync(path);
  try { return { to, real: realpathSync(path) }; } catch { return { to }; }
}

/** Whether `path` (real) is `root` or inside it, both taken as the real paths they are. */
function inside(path: string, root: string): boolean {
  let r = root;
  try { r = realpathSync(root); } catch { /* as given */ }
  return path === r || path.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** A word as a POSIX shell reads it, quoted only when it needs to be. */
const shellWord = (w: string) => (/^[A-Za-z0-9_./:=@-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
