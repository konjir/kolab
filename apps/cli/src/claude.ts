/**
 * `konjir claude <label> [claude's own arguments…]` (W9.1, API24): one agent's Claude Code session
 * from one command. It finds the `konjir-<label>` entry konjir connect claude wrote (the project's
 * `.mcp.json`, else Claude Code's user settings), writes that entry alone to
 * `.claude/konjir-<label>.json`, and runs claude with only that server (--strict-mcp-config), its
 * channel when the entry is the channel bridge, and a system prompt naming the agent, its role and
 * its kolab, so a person's prompt to it carries only the task. Further arguments go to claude.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeUserConfig, readConfigText, systemPrompt, writeAtomically, type Who } from './connect.js';

export { systemPrompt, type Who };

/** A label, as konjir connect's --agent takes it. */
const LABEL = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** One agent's session: the file to write, what it holds, and claude's arguments. */
export interface ClaudeSession { name: string; who: Who; path: string; dir: string; text: string; args: string[]; from: string }

/**
 * The entries of one config file's `mcpServers`, or {} when there is no file or it has none. One that
 * isn't JSON is refused, rather than passed over for another file's entry of the same name.
 */
function serversIn(path: string): Record<string, unknown> {
  let config: unknown;
  try { config = JSON.parse(readConfigText(path) || '{}'); } catch { throw new Error(`${path} isn't valid JSON, so konjir claude can't read its entries: fix it, or run konjir connect claude again`); }
  const s = config && typeof config === 'object' && !Array.isArray(config) ? (config as { mcpServers?: unknown }).mcpServers : undefined;
  return s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {};
}

/** Who an entry signs in as, from KONJIR_SCOPE (the channel) or its OAuth scopes (--http). */
function whoIn(entry: unknown): Who | undefined {
  const e = (entry ?? {}) as { env?: { KONJIR_SCOPE?: unknown }; oauth?: { scopes?: unknown; scope?: unknown } };
  const scope = e.env?.KONJIR_SCOPE ?? e.oauth?.scopes ?? e.oauth?.scope;
  if (typeof scope !== 'string') return undefined;
  const word = (k: string) => scope.split(' ').find((w) => w.startsWith(`${k}:`))?.slice(k.length + 1);
  const [agent, role, kolab] = [word('agent'), word('role'), word('kolab')];
  const ok = (v?: string) => !!v && /^[a-z0-9][a-z0-9-]*$/.test(v);
  return ok(agent) && ok(role) && ok(kolab) ? { agent: agent!, role: role!, kolab: kolab! } : undefined;
}

/**
 * The project konjir claude runs in: in a repository, the nearest folder from `cwd` up to its root
 * that holds a .mcp.json, so it runs the same from a subfolder; outside one, or with none, `cwd`.
 */
export function projectDir(cwd: string): string {
  const up: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    up.push(dir);
    if (existsSync(join(dir, '.git'))) return up.find((d) => existsSync(join(d, '.mcp.json'))) ?? cwd;
    if (dirname(dir) === dir) return cwd;
  }
}

/**
 * claude's own arguments, with any system prompt the person appends joined to konjir's: claude keeps
 * one --append-system-prompt, so a second would replace API24's prompt.
 */
function withPrompt(prompt: string, rest: string[]): string[] {
  const out: string[] = [];
  const theirs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { out.push(...rest.slice(i)); break; }
    if (a === '--append-system-prompt' && i + 1 < rest.length) theirs.push(rest[++i]);
    else if (a.startsWith('--append-system-prompt=')) theirs.push(a.slice('--append-system-prompt='.length));
    else out.push(a);
  }
  return ['--append-system-prompt', [prompt, ...theirs].join('\n\n'), ...out];
}

/**
 * The session `konjir claude <label>` starts, without starting it: the entry, from the project's
 * `.mcp.json` or else the person's Claude Code settings; the file it is written to alone; and the
 * arguments to claude. Refuses a label with no `konjir-<label>` entry, naming the entries there are.
 */
export function claudeSession(label: string, rest: string[], opts: { cwd: string; env: Record<string, string | undefined> }): ClaudeSession {
  if (!LABEL.test(label ?? '')) throw new Error('konjir claude <label> [claude\'s own arguments…]: the label of an agent konjir connect claude set up, such as product, up to 24 lowercase letters, digits and \'-\'');
  const name = `konjir-${label}`;
  const dir = projectDir(opts.cwd);
  const places = [join(dir, '.mcp.json'), claudeUserConfig(opts.env)];
  const found = places.map((path) => ({ path, servers: serversIn(path) }));
  const hit = found.find((f) => Object.hasOwn(f.servers, name));
  if (!hit) {
    const labels = [...new Set(found.flatMap((f) => Object.keys(f.servers)).filter((k) => k.startsWith('konjir-') && LABEL.test(k.slice('konjir-'.length))))];
    throw new Error(labels.length
      ? `There is no ${name} entry in ${places.join(' or ')}. The entries there are ${labels.join(', ')}: konjir claude ${labels.map((k) => k.slice('konjir-'.length)).join(' | ')}`
      : `There is no ${name} entry in ${places.join(' or ')}, nor any konjir- entry: run konjir connect claude --kolab <k> --agent ${label}:<role> first`);
  }
  const entry = hit.servers[name];
  const who = whoIn(entry);
  if (!who) throw new Error(`${hit.path}: ${name} doesn't say which agent, role and kolab it signs in as (KONJIR_SCOPE, or its OAuth scopes), so it isn't an entry konjir connect claude wrote: run it again`);
  const channel = (entry as { type?: unknown }).type === 'stdio';
  const path = join(dir, '.claude', `${name}.json`);
  return {
    name, who, path, dir, from: hit.path,
    text: `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`,
    args: ['--strict-mcp-config', '--mcp-config', path,
      ...(channel ? ['--dangerously-load-development-channels', `server:${name}`] : []),
      ...withPrompt(systemPrompt(who, name), rest)],
  };
}

/** The world `konjir claude` acts on, so tests can stand in for claude and git. */
export interface ClaudeIO {
  warn: (line: string) => void;
  /** Runs claude attached to the terminal; resolves with its exit code (-1 if it can't start). */
  run: (cmd: string, args: string[], opts: { cwd: string }) => Promise<number>;
  /** Whether git ignores `path`: true or false in a repository, undefined outside one. */
  ignored: (path: string, cwd: string) => boolean | undefined;
}

/** What git says of a path: `git check-ignore` exits 0 for ignored, 1 for not, anything else outside a repository. */
export const gitIgnored = (path: string, cwd: string): boolean | undefined => {
  const r = spawnSync('git', ['check-ignore', '-q', path], { cwd, stdio: 'ignore' });
  return r.status === 0 ? true : r.status === 1 ? false : undefined;
};

/** Writes the session's file and runs claude; resolves with claude's exit code. */
export async function startClaude(label: string, rest: string[], opts: { cwd: string; env: Record<string, string | undefined> }, io: ClaudeIO): Promise<number> {
  const s = claudeSession(label, rest, opts);
  // Only its owner reads it: it is the entry as written, whatever headers a person added to it.
  writeAtomically(s.path, s.text, { within: s.dir, mode: 0o600 });
  // It names the checkout's absolute path and the agent, as .mcp.json does: keep it out of git.
  if (io.ignored(s.path, s.dir) === false) io.warn(`konjir claude: git doesn't ignore ${s.path}, which names this machine's paths as .mcp.json does: add .claude/konjir-*.json to .gitignore`);
  const code = await io.run('claude', s.args, { cwd: s.dir });
  if (code === -1) throw new Error('claude didn\'t start: is Claude Code installed, and claude on your PATH?');
  return code;
}
