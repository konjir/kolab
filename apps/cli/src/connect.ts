/**
 * `konjir connect <harness>`: one command connects a harness to a kolab, with one agent per entry
 * (W3.7, D59). It signs the CLI in as the person (`konjir login`, if it isn't already), makes or
 * reuses each agent up front through `konjir_create_agent`, and writes one MCP server entry per
 * agent, `konjir-<label>`, into the harness's own configuration: OpenCode's `opencode.json` (or
 * `.jsonc`), merged with its comments and formatting kept, or Claude Code's project `.mcp.json`.
 * Each entry's OAuth scope names its agent, kolab and role, so Kolab's consent page arrives with
 * them chosen; the person confirms there, and Kolab checks access as it always does. No token is
 * written anywhere: each entry signs in by itself, one at a time.
 *
 * For Claude Code, each entry is the Konjir channel bridge (W3.8, D61), Claude Code's one Konjir
 * server: Kolab's tools passed through and the channel, on one sign-in per agent, kept in the
 * agent's own credentials file (KONJIR_AGENT). `--http` writes Claude Code's plain HTTP entry
 * instead, as `claude mcp add --scope project --transport http` writes it, with no channel.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { JsoncError, commentsOf, member, parseTree, tokens, valueOf, type JsonNode } from './jsonc.js';
import { agentCredentialsPath } from './login.js';

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
/**
 * What Claude Code is given by default (W3.8): the Konjir channel bridge, started from `command`
 * (a checkout's start.sh), as `claude mcp add --scope project` writes a stdio server. KONJIR_AGENT
 * keeps the agent's sign-in apart; KONJIR_SCOPE preselects it at consent. Neither is a secret.
 */
export const claudeBridgeEntry = (e: Entry, command: string) => ({
  type: 'stdio', command, args: [],
  env: { KONJIR_URL: e.url, KONJIR_AGENT: e.agent, KONJIR_SCOPE: entryScope(e.kolab, e.role, e.agent) },
});

/** The name the bridge registers under at Kolab, which its consent page shows: the bridge's own CLIENT_NAME. */
export const CHANNEL_CLIENT_NAME = 'konjir channel (Claude Code)';

/**
 * The channel bridge's start.sh in the checkout this konjir runs from, or undefined when it runs
 * from elsewhere (the published package, a binary), which has no bridge.
 */
export function bridgeCommand(): string | undefined {
  try {
    const path = fileURLToPath(new URL('../../channel-bridge/scripts/start.sh', import.meta.url));
    return existsSync(path) ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

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
  refuseTaken(path, entries, Object.keys((mcp ? valueOf(mcp) : {}) as object), force);
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
  refuseTaken(path, entries, Object.keys(servers), force);
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

function refuseTaken(where: string, entries: Entry[], names: string[], force: boolean) {
  const taken = entries.filter((e) => names.includes(e.name)).map((e) => e.name);
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
export function writeAtomically(path: string, text: string, opts: { within?: string } = {}) {
  let target = path;
  const link = linkTarget(path);
  if (link) {
    if (!link.real) throw new Error(`${path} is a link to ${link.to}, which isn't there; konjir won't write through it`);
    target = link.real;
  }
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  let mode = 0o644;
  try { mode = statSync(target).mode & 0o777; } catch { /* new */ }
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

/** What `konjir connect` is asked to do. */
export interface ConnectOptions {
  harness: Harness;
  /** Kolab's MCP URL. */
  url: string;
  /** The kolab to connect to; by default the one the person's sign-in works in. */
  kolab?: string;
  agents: AgentSpec[];
  global: boolean;
  force: boolean;
  /** Write a config file that is a link to somewhere outside the project (or, with --global, the config folder). */
  forcePath?: boolean;
  /** Write without asking (scripts). */
  yes: boolean;
  /** Run each harness's sign-in afterwards; without it, print the steps. */
  auth: boolean;
  /** Claude Code: write the plain HTTP entry (no channel) instead of the channel bridge. */
  http?: boolean;
  /** Claude Code: the channel bridge's start.sh; by default the checkout's this konjir runs from. */
  bridge?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

/** Who the CLI is signed in as, and a way to call a verb as them. */
export interface PersonSession {
  me: { actor: string; kind: string; owner: string | null; kolab: string; role: string };
  call: (verb: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

/** The world `konjir connect` acts on, so tests can stand in for the terminal, the harnesses and Kolab. */
export interface ConnectIO {
  log: (line: string) => void;
  /** Whether the person can be asked (a terminal); if not, --yes is needed. */
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  /** Runs a harness's own command, attached to the terminal; resolves with its exit code (-1 if it can't start). */
  run: (cmd: string, args: string[], opts: { cwd: string }) => Promise<number>;
  /** The CLI signed in as the person: konjir login's kept sign-in if it is already the person's, or one in memory only, revoked on close. */
  person: () => Promise<PersonSession>;
  /** Signs a Claude Code channel entry in with the browser as its agent, kept in `credentials`; resolves with who it works as. */
  signInAgent?: (e: Entry, credentials: string) => Promise<string>;
}

/** The default terminal: asks on stderr, runs commands attached to it. */
export const terminalIO = (person: ConnectIO['person'], signInAgent?: ConnectIO['signInAgent']): ConnectIO => ({
  log: (line) => console.log(line),
  interactive: !!process.stdin.isTTY,
  async confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
  },
  run: (cmd, args, opts) => new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  }),
  person,
  signInAgent,
});

/** How to start Claude Code with the Konjir channel entries (a development channel, during the research preview). */
function channelSteps(entries: Entry[], cwd: string, global: boolean, signedIn: boolean): string[] {
  return [
    `Start Claude Code with the Konjir channel${global ? '' : `, from ${cwd}`}:`,
    `  claude --dangerously-load-development-channels ${entries.map((e) => `server:${e.name}`).join(' ')}`,
    ...(global ? [] : ['  Claude Code asks first whether to use the servers in this project\'s .mcp.json: approve the konjir- ones.']),
    '  At the warning, choose "I am using this for local development".',
    signedIn
      ? `  Each entry is one Konjir server: Kolab's tools and its channel, on its agent's sign-in. Don't also add Kolab's HTTP server as the same agent: one session each (ENF4).`
      : `  On first start each entry signs in by itself in your browser, as its own agent: Kolab's page arrives with ${entries.map((e) => e.agent).join(' and ')} chosen in turn. Check them, then Allow.`,
  ];
}

/** The steps that sign an entry in by hand, per harness. */
function signInSteps(harness: Harness, entries: Entry[], cwd: string, global: boolean): string[] {
  if (harness === 'opencode') {
    return [`Sign each entry in, one at a time${global ? '' : `, from ${cwd}`}:`,
      ...entries.map((e) => `  opencode mcp auth ${e.name}     # Kolab's page arrives with ${e.agent}, kolab ${e.kolab} and ${e.role} chosen: check them, then Allow`)];
  }
  return [`Sign each entry in, one at a time, from Claude Code${global ? '' : ` started in ${cwd}`}:`,
    '  1. Run claude, and type /mcp.',
    ...(global ? [] : ['     Claude Code asks first whether to use the servers in this project\'s .mcp.json: approve the konjir- ones.']),
    ...entries.map((e, k) => `  ${k + 2}. Choose ${e.name}, then Authenticate. Kolab's page arrives with ${e.agent}, kolab ${e.kolab} and ${e.role} chosen: check them, then Allow.`)];
}

/**
 * `konjir connect`: plans every entry, shows the diff, asks, makes or reuses the agents, writes
 * the configuration atomically, then signs each entry in, one at a time (OpenCode), or says how
 * (Claude Code, or with --no-auth). Returns the entries written.
 */
export async function connectHarness(opts: ConnectOptions, io: ConnectIO): Promise<Entry[]> {
  if (opts.kolab !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(opts.kolab)) throw new Error('--kolab names a kolab: lowercase letters, digits and -');
  if (opts.http && opts.harness !== 'claude') throw new Error('--http is for Claude Code: OpenCode\'s entries are always its remote MCP server');
  // Claude Code's entry: the channel bridge (W3.8), from a checkout; or, with --http, the plain HTTP server.
  const channel = opts.harness === 'claude' && !opts.http;
  const bridge = channel ? opts.bridge ?? bridgeCommand() : undefined;
  if (channel && !bridge) {
    throw new Error('konjir connect claude sets up the Konjir channel, Claude Code\'s one Konjir server, which runs from a checkout of github.com/konjir/kolab, and this konjir isn\'t running from one. Run it as <checkout>/bin/konjir connect claude, or pass --http for Claude Code\'s plain HTTP entry (no channel)');
  }
  const claudeMake = bridge ? (e: Entry) => claudeBridgeEntry(e, bridge) : claudeEntry;
  const session = await io.person();
  let closed = false;
  // Interrupted (Ctrl-C, a kill) while it holds the sign-in as the person: that is revoked first.
  const onSignal = (signal: NodeJS.Signals) => {
    void closeSession().finally(() => { process.kill(process.pid, signal); });
  };
  const closeSession = async () => {
    if (closed) return;
    closed = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await session.close();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const { me } = session;
    if (me.kind !== 'person') {
      throw new Error(`konjir connect makes agents as you, and the token it was given (KONJIR_TOKEN or --token) works as ${me.actor}${me.owner ? `, an agent of ${me.owner}'s` : ''}. Unset it, and konjir connect signs you in as yourself for a moment, in your browser`);
    }
    const kolab = opts.kolab ?? me.kolab;
    const entries: Entry[] = opts.agents.map((a) => ({ name: `konjir-${a.label}`, agent: `${me.actor}-${a.label}`, label: a.label, role: a.role, kolab, url: opts.url }));

    // The plan: each file's text after, or for Claude Code's own user settings, its commands.
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
      let servers: Record<string, unknown> = {};
      let parsed: unknown;
      try { parsed = JSON.parse(readText(path) || '{}'); } catch {
        throw new Error(`${path} isn't JSON, so konjir connect can't tell which servers Claude Code already has: fix it, then run konjir connect again`);
      }
      const s = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).mcpServers ?? {} : null;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${path}: its "mcpServers" isn't an object, so konjir connect can't tell which servers Claude Code already has`);
      servers = s as Record<string, unknown>;
      refuseTaken(`Claude Code's user settings (${path})`, entries, Object.keys(servers), opts.force);
      commands = entries.flatMap((e) => [
        ...(e.name in servers ? [['claude', 'mcp', 'remove', '--scope', 'user', e.name]] : []),
        ['claude', 'mcp', 'add-json', '--scope', 'user', e.name, JSON.stringify(claudeMake(e))],
      ]);
    }

    io.log(`konjir connect ${opts.harness}: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} for kolab ${kolab} at ${opts.url}, one agent each:`);
    for (const e of entries) io.log(`  ${e.name}  as ${e.agent}, ${e.role}`);
    io.log('');
    if (change) {
      // A link is written where it leads: only inside the project (or the config folder), unless
      // --force-path, even with --yes, so a cloned repository's link can't aim an edit elsewhere.
      const target = linkTarget(change.path);
      if (target) {
        const root = opts.global ? dirname(change.path) : opts.cwd;
        if (!target.real) throw new Error(`${change.path} is a link to ${target.to}, which isn't there; konjir connect won't write through it. Remove the link, then run konjir connect again`);
        if (!inside(target.real, root) && !opts.forcePath) {
          throw new Error(`${change.path} is a link to ${target.real}, outside ${root}; konjir connect won't write there. Pass --force-path if you mean it to`);
        }
        io.log(`${change.path} is a link to ${target.real}, which konjir connect would change.`);
      }
      if (change.before === change.after) io.log(`${change.path} already says exactly this.`);
      else io.log(unifiedDiff(change.path, change.before, change.after, change.exists));
    } else {
      io.log('Claude Code\'s own command will write them to your user settings:');
      for (const c of commands) io.log(`  ${c.map(shellWord).join(' ')}`);
    }
    io.log('');
    if (!opts.yes) {
      if (!io.interactive) throw new Error('konjir connect asks before it writes anything: run it in a terminal, or pass --yes');
      if (!(await io.confirm(change ? `Make ${entries.length === 1 ? 'this agent' : 'these agents'} and write ${change.path}?` : 'Make these agents and run those commands?'))) {
        io.log('Nothing written, and no agent made.');
        return [];
      }
    }

    // The agents, up front (D59): made, or found again, as the person; then that sign-in ends.
    for (const e of entries) {
      const r = await session.call('create_agent', { label: e.label }) as { agent: string; created: boolean };
      if (r.agent !== e.agent) throw new Error(`Kolab made ${r.agent}, not ${e.agent}; nothing written`);
      io.log(r.created ? `Made your agent ${r.agent}.` : `Using your agent ${r.agent}.`);
    }
    await closeSession();

    if (change) {
      // Written only if nobody changed it since it was read: never over an edit made meanwhile.
      if (readText(change.path) !== change.before) throw new Error(`${change.path} changed while konjir connect was waiting; nothing written. Run konjir connect again`);
      writeAtomically(change.path, change.after, opts.forcePath ? {} : { within: opts.global ? dirname(change.path) : opts.cwd });
      io.log(`Wrote ${change.path}. It holds no token: each entry signs in by itself.`);
    } else {
      for (const c of commands) {
        if (await io.run(c[0], c.slice(1), { cwd: opts.cwd }) !== 0) throw new Error(`${c.slice(0, 3).join(' ')} didn't succeed${c[0] === 'claude' ? ' (is Claude Code installed, and claude on your PATH?)' : ''}`);
      }
      io.log('Claude Code has them in your user settings. They hold no token: each entry signs in by itself.');
    }

    // Each harness signs in by itself, one entry at a time, as its own agent.
    if (channel) {
      let signed = 0;
      if (opts.auth && io.signInAgent) {
        for (const e of entries) {
          io.log(`Signing ${e.name} in as ${e.agent}, in your browser. Kolab's page arrives with ${e.agent}, kolab ${e.kolab} and ${e.role} chosen: check them, then Allow.`);
          try {
            const actor = await io.signInAgent(e, agentCredentialsPath(e.agent, opts.env));
            io.log(actor === e.agent ? `${e.name} is signed in as ${e.agent}.` : `warning: ${e.name} signed in as ${actor}, not ${e.agent}: it works as ${actor}.`);
            signed++;
          } catch (err) {
            io.log(`${e.name} didn't sign in (${(err as Error).message}). It signs in by itself, in your browser, when Claude Code first starts it.`);
          }
        }
      }
      for (const line of channelSteps(entries, opts.cwd, opts.global, signed === entries.length)) io.log(line);
      return entries;
    }
    if (opts.harness === 'opencode' && opts.auth) {
      for (const [k, e] of entries.entries()) {
        io.log(`Signing ${e.name} in as ${e.agent}. Kolab's page arrives with ${e.agent}, kolab ${e.kolab} and ${e.role} chosen: check them, then Allow.`);
        const code = await io.run('opencode', ['mcp', 'auth', e.name], { cwd: opts.cwd });
        if (code !== 0) {
          io.log(`opencode mcp auth ${e.name} didn't finish${code === -1 ? ' (is OpenCode installed, and opencode on your PATH?)' : ''}.`);
          for (const line of signInSteps('opencode', entries.slice(k), opts.cwd, opts.global)) io.log(line);
          return entries;
        }
      }
      io.log(`Connected: each entry works as its own agent in ${kolab}.`);
    } else {
      for (const line of signInSteps(opts.harness, entries, opts.cwd, opts.global)) io.log(line);
    }
    return entries;
  } finally {
    await closeSession();
  }
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
