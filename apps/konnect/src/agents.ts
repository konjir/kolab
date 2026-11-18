/**
 * `konnect agent add|run`: an agent of the person's, in their team, with konnect's tools
 * (`konnect mcp`), started in the harness they use.
 *
 * 1. The agent is made if it is new, and logged in, by Kolab's setup page, the same flow `konjir
 *    connect` uses (@konjir/login's setup: one page in the browser, scope
 *    `konjir kolab:<team> setup:<label>:engineer`, which mints the agent's own login). Every agent
 *    konnect makes has the role engineer, which konnect never shows: konnect's agents talk, and
 *    the role only decides what else they could do in Kolab.
 * 2. Its login is kept where `konnect mcp` reads it, `<config>/agents/<team>/<label>.json`.
 * 3. The MCP entry runs `konnect mcp` with the team and the agent in its environment, and no token.
 *    Nothing is written in the folder: Claude Code takes it on its command line (--mcp-config),
 *    Codex as `-c mcp_servers.…`, OpenCode in OPENCODE_CONFIG_CONTENT.
 * 4. The harness is started in this folder. Claude Code is also passed, in --settings, the hook that
 *    wakes its idle session when a message comes for the agent (cmd-wake.ts) and leave to call the
 *    agent's own tools, and the agent's system prompt (--append-system-prompt). Codex and OpenCode
 *    aren't woken, and receive at the start of each turn.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { keepSignIn, revokeIssued, setup } from '@konjir/login';
import { printable } from './names.js';
import { agentFileReady, configDir } from './teams.js';

/** The tools konnect starts an agent in. */
export type Tool = 'claude' | 'codex' | 'opencode';
export const HARNESSES: readonly Tool[] = ['claude', 'codex', 'opencode'];

/** The role every agent konnect makes has, never shown. */
export const AGENT_ROLE = 'engineer';

/** The scope of Kolab's setup page for one agent in a team: the same as `konjir connect`'s. */
export const agentSetupScope = (team: string, ...labels: string[]) => `konjir kolab:${team} ${labels.map((label) => `setup:${label}:${AGENT_ROLE}`).join(' ')}`;

/** The name the agent's MCP server goes by in its tool. */
export const serverName = (label: string) => `konnect-${label}`;

/** An agent's label: as Kolab allows one. */
export function checkLabel(label: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(label)) throw new Error(`${printable(label)} isn't an agent's name: lowercase letters, digits and -, at most 24 characters, such as reviewer`);
  return label;
}

/**
 * Makes each agent that is new, and logs each in: one page of Kolab's setup, in the browser, where
 * the person allows them all at once; each agent's own login is kept in its file. Returns each one's
 * stored name, in the order given.
 */
export async function setUpAgents(team: string, url: string, labels: string[], io: { open?: (u: URL) => void | Promise<void>; log: (l: string) => void; env: Record<string, string | undefined> }, again = `run konnect agent add ${labels.join(' ')} again`): Promise<{ label: string; agent: string; made: boolean; file: string }[]> {
  const files = labels.map((label) => agentFileReady(team, label, io.env));
  const named = labels.length === 1 ? `your agent ${labels[0]}` : `your agents ${labels.join(', ')}`;
  let done;
  try {
    done = await setup(url, {
      scope: agentSetupScope(team, ...labels), mint: true, clientName: 'konnect agent', open: io.open, log: io.log,
      opening: `Opening your browser to add ${named} to team ${team}. Check what the page names, then Allow.`,
      again,
    });
  } catch (e) {
    throw new Error(String((e as Error)?.message ?? e).replace(/run konjir connect again/g, again).replace(/konjir connect/g, 'konnect'));
  }
  // A login issued and not kept is revoked, never left to lapse by itself: every one is checked to be
  // there before any is kept, and when keeping one fails, those not yet kept are revoked.
  const issued = labels.map((label) => done.agents.find((x) => x.label === label));
  const lacking = labels.filter((_, i) => !issued[i]?.tokens);
  if (lacking.length) {
    await revokeIssued(url, done.client, issued.flatMap((a) => (a?.tokens ? [a.tokens] : [])));
    throw new Error(`the service added ${lacking.join(', ')} but issued ${lacking.length === 1 ? 'it' : 'them'} no login, so none was kept: run the command again`);
  }
  const out = [];
  for (const [i, label] of labels.entries()) {
    const a = issued[i]!;
    try {
      await keepSignIn(url, files[i], { client: done.client, tokens: a.tokens!, ...(done.discovery ? { discovery: done.discovery } : {}) });
    } catch (e) {
      await revokeIssued(url, done.client, issued.slice(i).map((x) => x!.tokens!));
      throw new Error(`konnect couldn't keep ${label}'s login (${(e as Error)?.message ?? e})${i ? `; ${labels.slice(0, i).join(', ')} ${i === 1 ? 'is' : 'are'} added and logged in` : ''}: run the command again`);
    }
    out.push({ label, agent: a.agent, made: a.made, file: files[i] });
  }
  return out;
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

/**
 * The environment of the agent's `konnect mcp`: its team, its name, what sets its system prompt
 * (whose messages it carries out, the channels that wake it, the owner's own words), and the
 * service's URL when it isn't the hosted one. No token.
 */
export function entryEnv(o: { team: string; label: string; wakeOn?: string[]; actFor?: string; systemPrompt?: string; url?: string }): Record<string, string> {
  return {
    KONNECT_TEAM: o.team, KONNECT_AGENT: o.label,
    ...(o.actFor && o.actFor !== 'nobody' ? { KONNECT_ACT_FOR: o.actFor } : {}),
    ...(o.wakeOn?.length ? { KONNECT_WAKE_ON: o.wakeOn.join(',') } : {}),
    ...(o.systemPrompt?.trim() ? { KONNECT_SYSTEM_PROMPT: o.systemPrompt } : {}),
    ...(o.url ? { KONNECT_URL: o.url } : {}),
  };
}

/** The channels `--wake-on` names (KONNECT_WAKE_ON, as 'a,b'), checked. */
export function listenList(given: string | undefined): string[] {
  if (given === undefined) return [];
  const names = given.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
  for (const n of names) if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(n)) throw new Error(`--listen names channels: '#a,#b' (${printable(n)} isn't one)`);
  return [...new Set(names)];
}

/**
 * konnect 0.1.0 and 0.2.0 wrote the agent's entry in the folder's `.mcp.json`. Claude Code would
 * load it beside the one konnect now passes on its command line, under the same name, so that
 * entry, and only one konnect itself wrote (it runs `konnect mcp` for this agent), is taken out.
 * Returns the file when it did.
 */
export function dropOldEntry(dir: string, name: string, label: string): string | undefined {
  const path = join(dir, '.mcp.json');
  let doc: { mcpServers?: Record<string, { args?: unknown; env?: Record<string, unknown> }> } & Record<string, unknown>;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
  const entry = doc?.mcpServers?.[name];
  if (!entry || !Array.isArray(entry.args) || entry.args.at(-1) !== 'mcp' || entry.env?.KONNECT_AGENT !== label) return undefined;
  const { [name]: _, ...others } = doc.mcpServers!;
  const tmp = join(dir, `.mcp.json.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ ...doc, mcpServers: others }, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
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
export function toolCommand(tool: Tool, name: string, entry: { command: string; args: string[]; env: Record<string, string> }, extra: string[], prompt?: string): { cmd: string; args: string[]; env: Record<string, string> } {
  if (tool === 'claude') {
    // Everything Claude Code needs is on its command line, for this session alone: nothing is written
    // in the folder or in the person's settings. The server (--mcp-config), then --settings with the
    // hook that wakes the idle session (cmd-wake.ts) and leave to call the agent's own tools, so a
    // turn that starts with nobody there isn't stopped at a permission question.
    const hook = { type: 'command', command: shellLine([entry.command, ...entry.args.slice(0, -1), 'wake']), async: true, asyncRewake: true, timeout: WAKE_HOOK_SECONDS };
    const ours = { permissions: { allow: [`mcp__${name}`] }, hooks: { SessionStart: [{ hooks: [hook] }], Stop: [{ hooks: [hook] }] } };
    const merged = withSettings(extra, ours);
    const settings = merged.settings;
    // The agent's system prompt, as Claude Code's own (added to it, with any the person passes after it).
    const rest: string[] = [];
    let theirs: string | undefined;
    for (let i = 0; i < merged.rest.length; i++) {
      const w = merged.rest[i];
      if (w === '--append-system-prompt' && merged.rest[i + 1] !== undefined) theirs = merged.rest[++i];
      else if (w.startsWith('--append-system-prompt=')) theirs = w.slice('--append-system-prompt='.length);
      else rest.push(w);
    }
    const said = [prompt, theirs].filter((x): x is string => !!x?.trim()).join('\n\n');
    const server = { mcpServers: { [name]: { type: 'stdio', command: entry.command, args: entry.args, env: { ...entry.env, KONNECT_WAKE: 'hook' } } } };
    // --mcp-config takes several values, so an option always follows it: the person's own first word is never read as one.
    return { cmd: 'claude', args: ['--mcp-config', JSON.stringify(server), '--settings', JSON.stringify(settings), ...(said ? ['--append-system-prompt', said] : []), ...rest], env: {} };
  }
  if (tool === 'codex') {
    const key = `mcp_servers.${name}`;
    return { cmd: 'codex', args: ['-c', `${key}.command=${toml(entry.command)}`, '-c', `${key}.args=${toml(entry.args)}`, '-c', `${key}.env=${toml(entry.env)}`, ...extra], env: {} };
  }
  return {
    cmd: 'opencode', args: extra,
    // konnect wakes OpenCode itself, from beside it (opencode.ts), so the server is told not to.
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { [name]: { type: 'local', command: [entry.command, ...entry.args], environment: { ...entry.env, KONNECT_WAKE: 'hook' }, enabled: true } } }) },
  };
}

/** How long Claude Code lets the wake hook wait: 20 days, after which the next turn starts another. */
const WAKE_HOOK_SECONDS = 1_728_000;

type Settings = { permissions?: { allow?: unknown[] } & Record<string, unknown>; hooks?: Record<string, unknown[]> } & Record<string, unknown>;

/**
 * Claude Code takes one --settings: when the person passes their own after the harness's name,
 * konnect's are merged into theirs (their hooks and permissions kept, konnect's added) and one is
 * passed. Theirs may be JSON or a file of it; anything else is refused, never dropped.
 */
export function withSettings(extra: string[], ours: Settings): { settings: Settings; rest: string[] } {
  const rest: string[] = [];
  let theirs: Settings = {};
  for (let i = 0; i < extra.length; i++) {
    const w = extra[i];
    const given = w === '--settings' ? extra[++i] : w.startsWith('--settings=') ? w.slice('--settings='.length) : undefined;
    if (given === undefined) { if (w === '--settings') throw new Error('--settings needs a file or JSON'); rest.push(w); continue; }
    let text = given;
    if (!given.trim().startsWith('{')) { try { text = readFileSync(given, 'utf8'); } catch { throw new Error(`konnect couldn't read the --settings file ${printable(given)}, which it merges its own into`); } }
    try { theirs = JSON.parse(text) as Settings; } catch { throw new Error('the --settings you passed isn\'t JSON, so konnect can\'t add its own to it'); }
    if (!theirs || typeof theirs !== 'object' || Array.isArray(theirs)) throw new Error('the --settings you passed isn\'t a JSON object, so konnect can\'t add its own to it');
  }
  const hooks: Record<string, unknown[]> = { ...(theirs.hooks ?? {}) };
  for (const [event, list] of Object.entries(ours.hooks ?? {})) hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...list];
  const allow = [...(Array.isArray(theirs.permissions?.allow) ? theirs.permissions.allow : []), ...(ours.permissions?.allow ?? [])];
  return { settings: { ...theirs, permissions: { ...(theirs.permissions ?? {}), allow }, hooks }, rest };
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
