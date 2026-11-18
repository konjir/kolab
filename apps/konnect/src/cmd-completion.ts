/**
 * Shell completion.
 *
 *   konnect completion bash|zsh|fish   prints what to load in the shell
 *   konnect _complete -- <words...>    plumbing: what could come next, a line each; the scripts call it
 *
 * konnect completes its own commands, verbs and options, the teams and agents it keeps logins for
 * on this machine, and the team's channels and members. Those last are kept for ten minutes beside
 * the logins, so a Tab doesn't wait on the service each time, and are asked for again, briefly,
 * when they are older.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HARNESSES } from './agents.js';
import { ACT_FOR } from './args.js';
import { chooseTeam, type Ctx } from './context.js';
import { UsageError } from './errors.js';
import { printable, shownName } from './names.js';
import { agentFile, configDir, teamsAt } from './teams.js';

const TOP = ['status', 'send', 'receive', 'history', 'watch', 'login', 'logout', 'channel', 'team', 'agent', 'lease', 'doctor', 'completion'];
const VERBS: Record<string, string[]> = {
  channel: ['list', 'create', 'follow', 'unfollow'],
  team: ['list', 'create', 'invite', 'remove', 'leave'],
  agent: ['list', 'add', 'run', 'attach', 'stop', 'remove'],
  lease: ['list', 'claim', 'release', 'break', 'run'],
};
const GLOBAL = ['--team', '--agent', '--json', '--help'];
/** Options that take a value, so the word after one isn't a command or a name. */
const VALUED = new Set(['--team', '--agent', '--limit', '-n', '--wait', '--for', '--wake-on', '--act-for', '--system-prompt', '--count']);
/** How long the team's channels and members are kept, and how long a Tab waits to ask for them again. */
const KEPT_MS = 10 * 60_000, ASK_MS = 1_500;

const SCRIPTS: Record<string, string> = {
  bash: `# konnect completion for bash. Load it with: eval "$(konnect completion bash)"
_konnect() {
  local IFS=$'\\n'
  COMPREPLY=($(KONNECT_COMPLETE=bash konnect _complete -- "\${COMP_WORDS[@]:1:$COMP_CWORD}" 2>/dev/null))
}
complete -o default -F _konnect konnect`,
  zsh: `#compdef konnect
# konnect completion for zsh. Load it with: eval "$(konnect completion zsh)"
_konnect() {
  local -a found
  found=("\${(@f)$(konnect _complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  (( \${#found} )) && [[ -n "\${found[1]}" ]] && compadd -- "\${found[@]}"
}
compdef _konnect konnect`,
  fish: `# konnect completion for fish. Load it with: konnect completion fish | source
complete -c konnect -f -a '(konnect _complete -- (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'`,
};

export async function completion(ctx: Ctx, rest: string[]) {
  const [shell, ...more] = rest;
  if (shell === undefined || more.length || !SCRIPTS[shell]) throw new UsageError('konnect completion <shell>: bash, zsh or fish. Load it with eval "$(konnect completion zsh)", or konnect completion fish | source');
  ctx.out(SCRIPTS[shell]);
}

interface Names { at: number; channels: string[]; people: string[]; agents: string[] }

/** The team's channels and members, from what is kept when it is fresh, else asked for briefly; nothing when neither can be had. */
async function names(ctx: Ctx, typed?: string): Promise<Names> {
  const none: Names = { at: 0, channels: [], people: [], agents: [] };
  let team: string;
  try { team = chooseTeam(typed ?? ctx.args.team, ctx.url, ctx.env); } catch { return none; }
  const file = join(configDir(ctx.env), 'completion', `${team}.json`);
  let kept = none;
  try { const read = JSON.parse(readFileSync(file, 'utf8')) as Names | null; if (read && Array.isArray(read.channels) && Array.isArray(read.people) && Array.isArray(read.agents)) kept = read; } catch { /* none kept, or not what konnect wrote */ }
  if (Date.now() - (kept.at ?? 0) < KEPT_MS) return kept;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const asked = (async () => {
      const client = await ctx.open(team);
      try {
        const [channels, members] = await Promise.all([client.channels(), client.members()]);
        return { at: Date.now(), channels: channels.map((c) => c.channel), people: members.filter((m) => m.kind !== 'agent').map((m) => m.actor), agents: members.filter((m) => m.kind === 'agent').map(shownName) };
      } finally { await client.close(); }
    })();
    asked.catch(() => undefined);
    const fresh = await Promise.race([asked, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ASK_MS); })]);
    if (!fresh) return kept;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(fresh), { mode: 0o600 });
    renameSync(`${file}.${process.pid}.tmp`, file);
    return fresh;
  } catch { return kept; } finally { clearTimeout(timer); }
}

/** The agents konnect keeps a login for on this machine, in the team a command would work in (or in any, when none is settled). */
function agentsHere(ctx: Ctx): string[] {
  let teams: string[];
  try { teams = [chooseTeam(ctx.args.team, ctx.url, ctx.env)]; } catch { teams = teamsAt(ctx.url, ctx.env); }
  const found = new Set<string>();
  for (const t of teams) {
    try { for (const f of readdirSync(dirname(agentFile(t, 'x', ctx.env)))) if (/^[a-z0-9][a-z0-9-]{0,23}\.json$/.test(f)) found.add(f.slice(0, -5)); } catch { /* none */ }
  }
  return [...found].sort();
}

/** What could come next after `words`, the last of which is being typed. */
export async function candidates(ctx: Ctx, words: string[]): Promise<string[]> {
  const cur = words.at(-1) ?? '';
  const before = words.slice(0, -1);
  const prev = before.at(-1);
  // The words that are neither options nor an option's value.
  const pos: string[] = [];
  for (let i = 0; i < before.length; i++) {
    if (VALUED.has(before[i])) { i++; continue; }
    if (!before[i].startsWith('-')) pos.push(before[i]);
  }
  const [cmd, verb] = pos;
  // The team named on the line being typed is the one whose channels and members are offered.
  const typed = before.includes('--team') ? before[before.indexOf('--team') + 1] : undefined;
  const team = typed && /^[a-z0-9][a-z0-9-]{0,39}$/.test(typed) ? typed : undefined;

  if (prev === '--team') return teamsAt(ctx.url, ctx.env);
  if (prev === '--agent') return agentsHere(ctx);
  if (prev === '--act-for') return [...ACT_FOR];
  if (prev === '--wake-on') return (await names(ctx, team)).channels;
  if (prev && VALUED.has(prev)) return [];

  if (cur.startsWith('-')) {
    const own = cmd === 'receive' ? ['-n', '--wait'] : cmd === 'history' ? ['-n']
      : cmd === 'agent' && verb === 'run' ? ['--act-for', '--wake-on', '--system-prompt', '--background', '--count']
      : cmd === 'agent' && verb === 'add' ? ['--act-for', '--wake-on', '--system-prompt']
      : cmd === 'lease' && (verb === 'claim' || verb === 'run') ? ['--for', '--wait'] : [];
    return [...own, ...GLOBAL];
  }
  if (cmd === undefined) return TOP;
  if (VERBS[cmd] && pos.length === 1) return VERBS[cmd];
  if (cmd === 'completion' && pos.length === 1) return Object.keys(SCRIPTS);
  if ((cmd === 'login' || cmd === 'logout') && pos.length === 1) return teamsAt(ctx.url, ctx.env);
  if (cmd === 'team' && verb === 'leave' && pos.length === 2) return teamsAt(ctx.url, ctx.env);
  if (cmd === 'agent' && ['run', 'attach', 'stop', 'remove', 'add'].includes(verb) && pos.length === 2) return agentsHere(ctx);
  if (cmd === 'agent' && verb === 'run' && pos.length === 3) return [...HARNESSES];
  if (['send', 'receive', 'history', 'watch'].includes(cmd) && pos.length === 1) {
    const n = await names(ctx, team);
    return [...n.channels.map((c) => `#${c}`), ...n.people.map((p) => `@${p}`), ...n.agents.map((a) => `@${a}`)];
  }
  if (cmd === 'channel' && (verb === 'follow' || verb === 'unfollow') && pos.length === 2) return (await names(ctx, team)).channels;
  if (cmd === 'team' && verb === 'remove' && pos.length === 2) return (await names(ctx, team)).people;
  return [];
}

export async function complete(ctx: Ctx, words: string[]) {
  const cur = words.at(-1) ?? '';
  // bash inserts what it is given as it stands, and '#' starts a comment there: a channel is given quoted.
  const bash = ctx.env.KONNECT_COMPLETE === 'bash';
  const shown = (c: string) => (bash && c.startsWith('#') ? `'${c}'` : c);
  const typed = bash ? cur.replace(/^'/, '') : cur;
  for (const c of await candidates(ctx, words.length ? words : [''])) if (c.startsWith(typed)) ctx.out(printable(shown(c)).replace(/\n/g, ' '));
}
