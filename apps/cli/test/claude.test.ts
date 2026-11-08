// `konjir claude <label>` (W9.1, API24): one agent's Claude Code session from one command, with
// only its konjir-<label> entry and channel and a system prompt naming it. Claude and git are stood
// in for; konjir connect's own scenario (connect.test.ts) starts each agent it set up this way.
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { claudeSession, gitIgnored, startClaude, systemPrompt, type ClaudeIO } from '../src/claude.js';
import { claudeBridgeEntry, claudeEntry, type Entry } from '../src/connect.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'konjir-claude-'));
const entry = (label: string, role: 'product' | 'engineer'): Entry =>
  ({ name: `konjir-${label}`, agent: `ann-${label}`, label, role, kolab: 'anns', url: 'https://kolab.example/mcp' });
const bridge = (label: string, role: 'product' | 'engineer') => claudeBridgeEntry(entry(label, role), '/src/kolab/apps/channel-bridge/scripts/start.sh');

/** A project whose .mcp.json holds `servers`, and a home with no Claude Code settings. */
function project(servers: Record<string, unknown>) {
  const cwd = scratch();
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  return { cwd, env: { HOME: scratch() } };
}

function io(code = 0) {
  const ran: string[][] = [];
  const warned: string[] = [];
  const world: ClaudeIO = { warn: (l) => warned.push(l), ignored: () => true, run: async (cmd, args) => { ran.push([cmd, ...args]); return code; } };
  return { ran, warned, world };
}

test('the system prompt names the agent, its role and its kolab, and says to read the instructions first (and the reviewer\'s before a review)', () => {
  const p = systemPrompt({ agent: 'ann-writer', role: 'product', kolab: 'linkly' }, 'konjir-writer');
  expect(p).toContain('You are ann-writer');
  expect(p).toContain('kolab linkly in the product role');
  expect(p).toContain('the konjir-writer tools');
  expect(p).toContain('Call konjir_instructions before your first change, and konjir_instructions which=reviewer before you review a version');
});

test('a channel entry: only it, written alone to .claude/konjir-<label>.json, its channel, the system prompt, then every further argument, --url and --token included', async () => {
  const p = project({ 'konjir-writer': bridge('writer', 'product'), 'konjir-builder': bridge('builder', 'engineer'), sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } });
  const w = io(3);
  expect(await startClaude('builder', ['-p', 'hi', '--url', 'x', '--token', 'y'], p, w.world)).toBe(3);
  const file = join(p.cwd, '.claude', 'konjir-builder.json');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({ mcpServers: { 'konjir-builder': bridge('builder', 'engineer') } });
  expect(w.ran).toStrictEqual([['claude', '--strict-mcp-config', '--mcp-config', file, '--dangerously-load-development-channels', 'server:konjir-builder',
    '--append-system-prompt', systemPrompt({ agent: 'ann-builder', role: 'engineer', kolab: 'anns' }, 'konjir-builder'), '-p', 'hi', '--url', 'x', '--token', 'y']]);
  expect(w.warned).toStrictEqual([]);
  // Run again, the file is rewritten from the entry as it is now.
  writeFileSync(join(p.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'konjir-builder': bridge('builder', 'product') } }));
  await startClaude('builder', [], p, w.world);
  expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers['konjir-builder'].env.KONJIR_SCOPE).toBe('konjir kolab:anns role:product agent:ann-builder');
});

test('an --http entry has no channel to load; one in Claude Code\'s user settings (--global) is found when the project has none', () => {
  const home = scratch();
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {}, mcpServers: { 'konjir-pm': claudeEntry(entry('pm', 'product')) } }));
  const cwd = scratch();
  const s = claudeSession('pm', [], { cwd, env: { HOME: home } });
  expect(s.from).toBe(join(home, '.claude.json'));
  expect(s.args).toStrictEqual(['--strict-mcp-config', '--mcp-config', join(cwd, '.claude', 'konjir-pm.json'), '--append-system-prompt', systemPrompt({ agent: 'ann-pm', role: 'product', kolab: 'anns' }, 'konjir-pm')]);
  // The project's entry comes first.
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { 'konjir-pm': bridge('pm', 'engineer') } }));
  expect(claudeSession('pm', [], { cwd, env: { HOME: home } }).who.role).toBe('engineer');
});

test('a label with no konjir-<label> entry is refused, naming the entries there are; nothing is written and claude doesn\'t start', async () => {
  const p = project({ 'konjir-writer': bridge('writer', 'product'), 'konjir-builder': bridge('builder', 'engineer'), sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } });
  const w = io();
  await expect(startClaude('reviewer', [], p, w.world)).rejects.toThrow(/There is no konjir-reviewer entry in .*\.mcp\.json or .*\.claude\.json\. The entries there are konjir-writer, konjir-builder: konjir claude writer \| builder$/);
  expect(w.ran).toStrictEqual([]);
  expect(() => readFileSync(join(p.cwd, '.claude', 'konjir-reviewer.json'))).toThrow();
  // None at all: says to run konjir connect claude.
  const empty = { cwd: scratch(), env: { HOME: scratch() } };
  expect(() => claudeSession('writer', [], empty)).toThrow(/There is no konjir-writer entry in .*, nor any konjir- entry: run konjir connect claude --kolab <k> --agent writer:<role> first/);
  // A label konjir connect would never write, or none.
  for (const bad of ['', 'Writer', '../x', 'a'.repeat(25)]) expect(() => claudeSession(bad, [], p)).toThrow(/konjir claude <label>/);
  // An entry that doesn't say who it signs in as.
  const odd = project({ 'konjir-x': { type: 'stdio', command: 'x', args: [] } });
  expect(() => claudeSession('x', [], odd)).toThrow(/konjir-x doesn't say which agent, role and kolab it signs in as/);
});

test('git: a session file git doesn\'t ignore is warned of; claude not on the PATH is said so', async () => {
  const p = project({ 'konjir-writer': bridge('writer', 'product') });
  execFileSync('git', ['init', '-q'], { cwd: p.cwd });
  expect(gitIgnored(join(p.cwd, '.claude', 'konjir-writer.json'), p.cwd)).toBe(false);
  const w = io();
  await startClaude('writer', [], p, { ...w.world, ignored: gitIgnored });
  expect(w.warned).toStrictEqual([`konjir claude: git doesn't ignore ${join(p.cwd, '.claude', 'konjir-writer.json')}, which names this machine's paths as .mcp.json does: add .claude/konjir-*.json to .gitignore`]);
  writeFileSync(join(p.cwd, '.gitignore'), '.mcp.json\n.claude/\n');
  expect(gitIgnored(join(p.cwd, '.claude', 'konjir-writer.json'), p.cwd)).toBe(true);
  const outside = scratch();
  mkdirSync(join(outside, 'x'));
  expect(gitIgnored(join(outside, 'x', 'f'), join(outside, 'x'))).toBeUndefined();
  await expect(startClaude('writer', [], p, io(-1).world)).rejects.toThrow(/claude didn't start: is Claude Code installed, and claude on your PATH\?/);
});

test('from a subfolder it finds the project\'s .mcp.json and writes beside it; a .mcp.json that isn\'t JSON is refused, not passed over', async () => {
  const p = project({ 'konjir-writer': bridge('writer', 'product') });
  mkdirSync(join(p.cwd, '.git'));
  const sub = join(p.cwd, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  const w = io();
  await startClaude('writer', [], { cwd: sub, env: p.env }, w.world);
  const file = join(p.cwd, '.claude', 'konjir-writer.json');
  expect(w.ran[0]).toContain(file);
  // Only its owner reads it.
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // Not above the repository's root.
  const outer = project({ 'konjir-writer': bridge('writer', 'product') });
  const repo = join(outer.cwd, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  expect(() => claudeSession('writer', [], { cwd: repo, env: outer.env })).toThrow(/There is no konjir-writer entry/);
  // Outside a repository, only the folder it runs in: a .mcp.json further up is no project of this one.
  const loose = project({ 'konjir-writer': bridge('writer', 'product') });
  const below = join(loose.cwd, 'notes');
  mkdirSync(below);
  expect(() => claudeSession('writer', [], { cwd: below, env: loose.env })).toThrow(/There is no konjir-writer entry/);
  // A broken project file is refused, though Claude Code's settings hold an entry of that name.
  writeFileSync(join(p.cwd, '.mcp.json'), '{ "mcpServers": ');
  writeFileSync(join(p.env.HOME, '.claude.json'), JSON.stringify({ mcpServers: { 'konjir-writer': bridge('writer', 'engineer') } }));
  expect(() => claudeSession('writer', [], { cwd: sub, env: p.env })).toThrow(/\.mcp\.json isn't valid JSON, so konjir claude can't read its entries/);
});

test('a system prompt the person appends is joined to konjir\'s, not put in its place', () => {
  const p = project({ 'konjir-writer': bridge('writer', 'product') });
  const prompt = systemPrompt({ agent: 'ann-writer', role: 'product', kolab: 'anns' }, 'konjir-writer');
  expect(claudeSession('writer', ['--append-system-prompt', 'Be brief.', '-p', 'hi'], p).args.slice(-4)).toStrictEqual(['--append-system-prompt', `${prompt}\n\nBe brief.`, '-p', 'hi']);
  expect(claudeSession('writer', ['--append-system-prompt=Be brief.'], p).args.slice(-2)).toStrictEqual(['--append-system-prompt', `${prompt}\n\nBe brief.`]);
  // After --, everything is claude's as given.
  expect(claudeSession('writer', ['--', '--append-system-prompt', 'x'], p).args.slice(-5)).toStrictEqual(['--append-system-prompt', prompt, '--', '--append-system-prompt', 'x']);
});
