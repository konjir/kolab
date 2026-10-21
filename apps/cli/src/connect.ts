/**
 * `konjir connect <harness>`: one command connects a harness to a kolab, with one agent per entry
 * (W3.7, D59). It signs the CLI in as the person (`konjir login`, if it isn't already), makes or
 * reuses each agent up front through `konjir_create_agent`, and writes one MCP server entry per
 * agent, `konjir-<label>`, into the harness's own configuration: OpenCode's `opencode.json` (or
 * `.jsonc`), merged with its comments and formatting kept, or Claude Code's project `.mcp.json`,
 * as `claude mcp add --scope project --transport http` writes it. Each entry's OAuth scope names
 * its agent, kolab and role, so Kolab's consent page arrives with them chosen; the person confirms
 * there, and Kolab checks access as it always does. No token is written anywhere: each harness
 * signs in by itself, one entry at a time.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { JsoncError, member, parseTree, tokens, valueOf, type JsonNode } from './jsonc.js';

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
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/mcp';
  return u.toString();
}

/** The scope an entry signs in with: what Kolab's consent page preselects (D59). Never a secret. */
export const entryScope = (kolab: string, role: Role, agent: string) => `konjir kolab:${kolab} role:${role} agent:${agent}`;

/** One harness entry to write: its name, and the agent, kolab and role it signs in as. */
export interface Entry { name: string; agent: string; label: string; role: Role; kolab: string; url: string }

/** What OpenCode is given for one entry: a remote MCP server, with the scope that preselects its agent. */
export const opencodeEntry = (e: Entry) => ({ type: 'remote', url: e.url, oauth: { scope: entryScope(e.kolab, e.role, e.agent) } });
/** What Claude Code is given: as `claude mcp add --transport http` writes it, with the scope in its OAuth settings. */
export const claudeEntry = (e: Entry) => ({ type: 'http', url: e.url, oauth: { scopes: entryScope(e.kolab, e.role, e.agent) } });

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
 * Existing `konjir-<label>` entries are refused unless `force`.
 */
export function mergeOpencode(path: string, before: string, entries: Entry[], force: boolean): string {
  let text = before.trim() ? before : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  let root: JsonNode;
  try { root = parseTree(text); } catch (e) {
    if (!(e instanceof JsoncError)) throw e;
    throw new Error(`${path} isn't JSON that OpenCode reads (${e.message}), so konjir connect won't touch it: fix it, then run konjir connect again`);
  }
  if (root.type !== 'object') throw new Error(`${path} isn't an OpenCode configuration (not a JSON object), so konjir connect won't touch it`);
  const mcp = member(root, 'mcp');
  if (mcp && mcp.type !== 'object') throw new Error(`${path}: its "mcp" isn't an object, so konjir connect won't touch it`);
  refuseTaken(path, entries, Object.keys((mcp ? valueOf(mcp) : {}) as object), force);
  for (const e of entries) {
    const tree = parseTree(text);
    const servers = member(tree, 'mcp');
    text = servers ? setMember(text, servers, e.name, opencodeEntry(e)) : setMember(text, tree, 'mcp', { [e.name]: opencodeEntry(e) });
  }
  return text;
}

/** The indentation one level takes in `text`: what its first indented key uses, or two spaces. */
const indentUnit = (text: string) => {
  const first = /\n([ \t]+)"/.exec(text)?.[1];
  return first?.startsWith('\t') ? '\t' : first || '  ';
};
/** The whitespace a line starts with, for the line `offset` is on. */
const indentAt = (text: string, offset: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1))![0];

/**
 * Sets `key` in the object `obj` of `text` to `value`, by editing the text alone: a member already
 * there has its value replaced where it stands; a new one is added on a line of its own after the
 * last member, with that member's indentation, a comma added after it only where JSON needs one,
 * and the file's trailing-comma habit kept. Comments, blank lines and every other member stay as
 * they are, on their own lines.
 */
function setMember(text: string, obj: JsonNode, key: string, value: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentUnit(text);
  const show = (v: unknown, base: string) => JSON.stringify(v, null, unit).split('\n').join(eol + base);
  const members = obj.children ?? [];
  const there = members.find((p) => p.children?.[0]?.value === key);
  if (there?.children?.[1]) {
    const v = there.children[1];
    return text.slice(0, v.offset) + show(value, indentAt(text, there.offset)) + text.slice(v.offset + v.length);
  }
  const close = obj.offset + obj.length - 1;
  const last = members.at(-1);
  if (!last) {
    const base = indentAt(text, obj.offset);
    return `${text.slice(0, obj.offset + 1)}${eol}${base}${unit}${JSON.stringify(key)}: ${show(value, base + unit)}${eol}${base}${text.slice(close)}`;
  }
  const end = last.offset + last.length;
  // A comma after the last member already (comments aside): the file writes trailing commas.
  let trailing = false;
  for (const t of tokens(text, end, close)) if (t.kind === ',') trailing = true;
  const base = indentAt(text, last.offset);
  // After the last member's own line (its comment stays with it), unless the object closes on that line.
  const lineEnd = text.indexOf('\n', end);
  const at = lineEnd >= 0 && lineEnd < close ? (text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd) : end;
  const line = `${eol}${base}${JSON.stringify(key)}: ${show(value, base)}${trailing ? ',' : ''}`;
  if (at === end) {
    // The object closes on its last member's line: the new member goes on a line before the close.
    const head = text.slice(0, close).replace(/\s+$/, '');
    return `${head}${head.endsWith(',') ? '' : ','}${eol}${base}${JSON.stringify(key)}: ${show(value, base)}${eol}${indentAt(text, obj.offset)}${text.slice(close)}`;
  }
  return `${text.slice(0, end)}${trailing ? '' : ','}${text.slice(end, at)}${line}${text.slice(at)}`;
}

/**
 * The project's `.mcp.json` with the entries merged in under `mcpServers`, written as
 * `claude mcp add --scope project` writes it: the whole file as JSON with two-space indentation,
 * every other key kept. A file that isn't JSON is refused, never rewritten. Existing entries are
 * refused unless `force`.
 */
export function mergeClaude(path: string, before: string, entries: Entry[], force: boolean): string {
  let config: Record<string, unknown> = {};
  if (before.trim()) {
    try { config = JSON.parse(before); } catch (e) {
      throw new Error(`${path} isn't JSON (${(e as Error).message}), so konjir connect won't touch it: fix it, then run konjir connect again`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${path} isn't a Claude Code MCP configuration (not a JSON object), so konjir connect won't touch it`);
  }
  const servers = config.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`${path}: its "mcpServers" isn't an object, so konjir connect won't touch it`);
  refuseTaken(path, entries, Object.keys(servers), force);
  const next: Record<string, unknown> = { ...(servers as Record<string, unknown>) };
  for (const e of entries) next[e.name] = claudeEntry(e);
  return JSON.stringify({ ...config, mcpServers: next }, null, 2);
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
export function writeAtomically(path: string, text: string) {
  let target = path;
  try { if (lstatSync(path).isSymbolicLink()) target = realpathSync(path); } catch { /* new */ }
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  let mode = 0o644;
  try { mode = statSync(target).mode & 0o777; } catch { /* new */ }
  const tmp = join(dir, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { mode, flag: 'wx' });
  try { renameSync(tmp, target); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

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
  /** Write without asking (scripts). */
  yes: boolean;
  /** Run each harness's sign-in afterwards; without it, print the steps. */
  auth: boolean;
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
  /** The CLI signed in as the person (konjir login's sign-in, made first if there is none). */
  person: () => Promise<PersonSession>;
}

/** The default terminal: asks on stderr, runs commands attached to it. */
export const terminalIO = (person: ConnectIO['person']): ConnectIO => ({
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
});

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
  const session = await io.person();
  try {
    const { me } = session;
    if (me.kind !== 'person') {
      throw new Error(`konjir connect makes agents as you, and your konjir sign-in to ${opts.url} works as ${me.actor}${me.owner ? `, an agent of ${me.owner}'s` : ''}. Run konjir login --self and choose Yourself on Kolab's page, then konjir connect again`);
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
      change = { path, before, after: mergeClaude(path, before, entries, opts.force), exists: existsSync(path) };
    } else {
      // Claude Code's user settings are its own file, which it rewrites as it runs: konjir only reads
      // it, to refuse an entry already there, and lets Claude Code's own command write it.
      const path = claudeUserConfig(opts.env);
      let servers: Record<string, unknown> = {};
      try { servers = (JSON.parse(readText(path) || '{}') as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}; } catch {
        throw new Error(`${path} isn't JSON, so konjir connect can't tell which servers Claude Code already has: fix it, then run konjir connect again`);
      }
      refuseTaken(`Claude Code's user settings (${path})`, entries, Object.keys(servers), opts.force);
      commands = entries.flatMap((e) => [
        ...(e.name in servers ? [['claude', 'mcp', 'remove', '--scope', 'user', e.name]] : []),
        ['claude', 'mcp', 'add-json', '--scope', 'user', e.name, JSON.stringify(claudeEntry(e))],
      ]);
    }

    io.log(`konjir connect ${opts.harness}: ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} for kolab ${kolab} at ${opts.url}, one agent each:`);
    for (const e of entries) io.log(`  ${e.name}  as ${e.agent}, ${e.role}`);
    io.log('');
    if (change) {
      // A link is written where it leads: said, so the person sees which file changes.
      let target: string | undefined;
      try { if (lstatSync(change.path).isSymbolicLink()) target = realpathSync(change.path); } catch { /* new */ }
      if (target) io.log(`${change.path} is a link to ${target}, which konjir connect would change.`);
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

    // The agents, up front (D59): made, or found again, as the person.
    for (const e of entries) {
      const r = await session.call('create_agent', { label: e.label }) as { agent: string; created: boolean };
      if (r.agent !== e.agent) throw new Error(`Kolab made ${r.agent}, not ${e.agent}; nothing written`);
      io.log(r.created ? `Made your agent ${r.agent}.` : `Using your agent ${r.agent}.`);
    }

    if (change) {
      // Written only if nobody changed it since it was read: never over an edit made meanwhile.
      if (readText(change.path) !== change.before) throw new Error(`${change.path} changed while konjir connect was waiting; nothing written. Run konjir connect again`);
      writeAtomically(change.path, change.after);
      io.log(`Wrote ${change.path}. It holds no token: each entry signs in by itself.`);
    } else {
      for (const c of commands) {
        if (await io.run(c[0], c.slice(1), { cwd: opts.cwd }) !== 0) throw new Error(`${c.slice(0, 3).join(' ')} didn't succeed${c[0] === 'claude' ? ' (is Claude Code installed, and claude on your PATH?)' : ''}`);
      }
      io.log('Claude Code has them in your user settings. They hold no token: each entry signs in by itself.');
    }

    // Each harness signs in by itself, one entry at a time, as its own agent.
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
    await session.close();
  }
}

/** A word as a POSIX shell reads it, quoted only when it needs to be. */
const shellWord = (w: string) => (/^[A-Za-z0-9_./:=@-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
