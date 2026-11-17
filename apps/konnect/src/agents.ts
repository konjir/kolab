/**
 * `konnect claude|codex|opencode <label>`: an agent of the person's, in their team, with konnect's
 * four tools (`konnect mcp`), started in the tool they use.
 *
 * 1. The agent is made if it is new, and signed in, by Kolab's setup page, the same flow `konjir
 *    connect` uses (@konjir/login's setup: one page in the browser, scope
 *    `konjir kolab:<team> setup:<label>:engineer`, which mints the agent's own sign-in). Every agent
 *    konnect makes has the role engineer, which konnect never shows: konnect's agents talk, and
 *    the role only decides what else they could do in Kolab.
 * 2. Its sign-in is kept where `konnect mcp` reads it, `<config>/agents/<team>/<label>.json`.
 * 3. The MCP entry runs `konnect mcp` with the team and the agent in its environment, and no token:
 *    Claude Code's goes in the project's `.mcp.json` (as `konnect-<label>`); Codex's is passed on its
 *    command line (`-c mcp_servers.…`) and OpenCode's in OPENCODE_CONFIG_CONTENT, writing nothing.
 * 4. The tool is started in this folder: Claude Code with the server loaded as its channel, so a
 *    message for the agent wakes it (`konnect mcp` sends it); Codex and OpenCode aren't woken in
 *    this release, and check for messages at the start of each turn (konnect_read says so).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { keepSignIn, setup } from '@konjir/login';
import { printable } from './names.js';
import { agentFileReady, configDir } from './teams.js';

/** The tools konnect starts an agent in. */
export type Tool = 'claude' | 'codex' | 'opencode';

/** The role every agent konnect makes has, never shown. */
export const AGENT_ROLE = 'engineer';

/** The scope of Kolab's setup page for one agent in a team: the same as `konjir connect`'s. */
export const agentSetupScope = (team: string, label: string) => `konjir kolab:${team} setup:${label}:${AGENT_ROLE}`;

/** The name the agent's MCP server goes by in its tool. */
export const serverName = (label: string) => `konnect-${label}`;

/** An agent's label: as Kolab allows one. */
export function checkLabel(label: string | undefined, tool: Tool): string {
  if (label === undefined) throw new Error(`konnect ${tool} <label>: name the agent, such as konnect ${tool} reviewer`);
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(label)) throw new Error(`${printable(label)} isn't an agent's label: lowercase letters, digits and -, at most 24 characters, such as reviewer`);
  return label;
}

/**
 * Makes the agent if it is new, and signs it in: Kolab's setup page, in the browser, where the
 * person allows it; the agent's own sign-in is kept in its file. Returns its stored name.
 */
export async function setUpAgent(team: string, url: string, label: string, io: { open?: (u: URL) => void | Promise<void>; log: (l: string) => void; env: Record<string, string | undefined> }): Promise<{ agent: string; made: boolean; file: string }> {
  const file = agentFileReady(team, label, io.env);
  let done;
  try {
    done = await setup(url, {
      scope: agentSetupScope(team, label), mint: true, clientName: 'konnect agent', open: io.open, log: io.log,
      opening: `Opening your browser to set up your agent ${label} in team ${team}. Check what Kolab's page names, then Allow.`,
      again: `run konnect claude ${label} again`,
    });
  } catch (e) {
    throw new Error(String((e as Error)?.message ?? e).replace(/run konjir connect again/g, `run the konnect command for ${label} again`).replace(/konjir connect/g, 'konnect'));
  }
  const a = done.agents.find((x) => x.label === label) ?? done.agents[0];
  if (!a?.tokens) throw new Error(`Kolab set up ${label} but issued it no sign-in: run the command again`);
  await keepSignIn(url, file, { client: done.client, tokens: a.tokens, ...(done.discovery ? { discovery: done.discovery } : {}) });
  return { agent: a.agent, made: a.made, file };
}

/** How this konnect runs, for an entry that starts `konnect mcp`. Tests give others. */
export interface Running { version?: string; execPath: string; script?: string; execArgv?: string[] }

// The published build (scripts/bundle.mjs) defines this as the package's version.
declare const KONNECT_VERSION: string | undefined;
const running = (): Running => ({ version: typeof KONNECT_VERSION === 'string' ? KONNECT_VERSION : undefined, execPath: process.execPath, script: process.argv[1], execArgv: process.execArgv });

/** A folder a package runner installs into for one run and clears by itself: npx's, pnpm's and yarn's dlx, bunx's. */
const RUN_ONCE = /^(_npx|dlx|dlx-.+|bunx-.+)$/;

/**
 * The command an entry runs `konnect mcp` with, as `konjir connect` resolves a published konjir:
 * the node running this konnect and its konnect.mjs where it is installed; when it runs from a
 * package runner's cache (npx), a copy konnect keeps in its config folder (`keep`), since the cache
 * is cleared under it, never `npx` in the project. From a checkout, the same node and flags (tsx's).
 */
export function konnectCommand(r: Running = running(), env: Record<string, string | undefined> = process.env): { command: string; args: string[]; keep?: { from: string; to: string } } {
  if (!r.script) return { command: r.execPath, args: [] };
  let real = r.script;
  try { real = realpathSync(r.script); } catch { /* as given */ }
  if (!r.version) return { command: r.execPath, args: [...(r.execArgv ?? []), real] };
  if (real.split(/[\\/]/).some((part) => RUN_ONCE.test(part))) {
    const to = resolve(configDir(env), 'bin', `konnect-${r.version}.mjs`);
    return { command: r.execPath, args: [to], keep: { from: real, to } };
  }
  return { command: r.execPath, args: [real] };
}

/** Keeps the copy konnectCommand's `keep` names: in konnect's own `bin/` folder, 0700; one with the same bytes already there is left. */
export function keepKonnect(keep: { from: string; to: string }) {
  const dir = dirname(keep.to);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} isn't a folder of konnect's: remove it`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to someone else: remove it`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  const bytes = readFileSync(keep.from);
  try { if (!lstatSync(keep.to).isSymbolicLink() && readFileSync(keep.to).equals(bytes)) return; } catch { /* not there yet */ }
  const tmp = join(dir, `.${basename(keep.to)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, bytes, { mode: 0o755, flag: 'wx' });
  try { renameSync(tmp, keep.to); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

/** The environment of the agent's `konnect mcp`: its team, its label, the channels it listens to, and Kolab's URL when it isn't the hosted one. No token. */
export function entryEnv(o: { team: string; label: string; listen?: string[]; url?: string }): Record<string, string> {
  return {
    KONNECT_TEAM: o.team, KONNECT_AGENT: o.label,
    ...(o.listen?.length ? { KONNECT_LISTEN: o.listen.join(',') } : {}),
    ...(o.url ? { KONNECT_URL: o.url } : {}),
  };
}

/** The channels `--listen '#a,#b'` names, checked. */
export function listenList(given: string | undefined): string[] {
  if (given === undefined) return [];
  const names = given.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
  for (const n of names) if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(n)) throw new Error(`--listen names channels: '#a,#b' (${printable(n)} isn't one)`);
  return [...new Set(names)];
}

/**
 * The project's `.mcp.json` with the agent's entry set, as `mcpServers[konnect-<label>]`; other
 * entries are kept. One that isn't a JSON object is refused, never replaced.
 */
export function mcpJsonText(before: string, name: string, entry: { command: string; args: string[]; env: Record<string, string> }): string {
  let doc: Record<string, unknown> = {};
  if (before.trim()) {
    try { doc = JSON.parse(before); } catch { throw new Error('.mcp.json isn\'t JSON, so konnect won\'t change it: fix it, or move it away'); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('.mcp.json isn\'t a JSON object, so konnect won\'t change it');
  }
  const servers = doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers) ? doc.mcpServers as Record<string, unknown> : {};
  return `${JSON.stringify({ ...doc, mcpServers: { ...servers, [name]: { type: 'stdio', ...entry } } }, null, 2)}\n`;
}

/** Writes `.mcp.json` in `dir` whole, then moves it into place. */
export function writeMcpJson(dir: string, name: string, entry: { command: string; args: string[]; env: Record<string, string> }): string {
  const path = join(dir, '.mcp.json');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const text = mcpJsonText(before, name, entry);
  const tmp = join(dir, `.mcp.json.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o644 });
  renameSync(tmp, path);
  return path;
}

/** The TOML value of a string, an array of strings, or a table of strings, for Codex's `-c key=value`. */
const toml = (v: string | string[] | Record<string, string>): string => (typeof v === 'string' ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map((s) => JSON.stringify(s)).join(', ')}]`
  : `{ ${Object.entries(v).map(([k, s]) => `${k} = ${JSON.stringify(s)}`).join(', ')} }`);

/**
 * How each tool is started with the agent's server, `extra` its own arguments after `--`: the
 * program, its arguments, and environment to add. Codex takes the server as `-c` overrides of
 * `mcp_servers.<name>`, OpenCode as OPENCODE_CONFIG_CONTENT; neither writes a file.
 */
export function toolCommand(tool: Tool, name: string, entry: { command: string; args: string[]; env: Record<string, string> }, extra: string[]): { cmd: string; args: string[]; env: Record<string, string> } {
  if (tool === 'claude') return { cmd: 'claude', args: ['--dangerously-load-development-channels', `server:${name}`, ...extra], env: {} };
  if (tool === 'codex') {
    const key = `mcp_servers.${name}`;
    return { cmd: 'codex', args: ['-c', `${key}.command=${toml(entry.command)}`, '-c', `${key}.args=${toml(entry.args)}`, '-c', `${key}.env=${toml(entry.env)}`, ...extra], env: {} };
  }
  return {
    cmd: 'opencode', args: extra,
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { [name]: { type: 'local', command: [entry.command, ...entry.args], environment: entry.env, enabled: true } } }) },
  };
}

/** What to install when a tool isn't on PATH. */
export const INSTALL: Record<Tool, string> = {
  claude: 'Claude Code: npm install -g @anthropic-ai/claude-code',
  codex: 'Codex: npm install -g @openai/codex',
  opencode: 'OpenCode: npm install -g opencode-ai',
};

/** A command line fit to paste in a shell. */
export const shellLine = (words: string[]) => words.map((w) => (/^[A-Za-z0-9_./:=@,%+-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');

/**
 * Starts the tool in `cwd`, its terminal its own, and resolves with its exit code; -1 when it
 * couldn't start because it isn't installed (ENOENT). Ctrl-C is the tool's to handle.
 */
export function startTool(c: { cmd: string; args: string[]; env: Record<string, string> }, cwd: string, env: Record<string, string | undefined>): Promise<number> {
  return new Promise((resolveExit) => {
    const ignore = () => undefined;
    process.on('SIGINT', ignore);
    const child = spawn(c.cmd, c.args, { cwd, stdio: 'inherit', env: { ...env, ...c.env } as NodeJS.ProcessEnv });
    const done = (code: number) => { process.off('SIGINT', ignore); resolveExit(code); };
    child.on('error', (e) => done((e as { code?: string }).code === 'ENOENT' ? -1 : 1));
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}
