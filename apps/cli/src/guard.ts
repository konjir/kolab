/**
 * konjir work guard (W6.4; JOB4): the check a job's harness runs before each shell command, as
 * Claude Code's PreToolUse hook on Bash. Claude Code's permission patterns are prefix globs over
 * the command as written, so quoting (`git push origin ':main'`), an option's abbreviation
 * (`--del`), a short option in a cluster (`-uf`), a wrapper (`env git push`, `bash -c "…"`) or a
 * delete refspec (`:branch`, which no pattern can write: a trailing `:*` reads as their old prefix
 * syntax) slip past them. This reads the command as a shell would split it, finds each git, gh and
 * terraform it runs, and denies:
 *
 * - a push that deletes a remote branch: a refspec with no source (`:x`, `+:x`), `--delete` or
 *   `-d`, and `--prune`, `--mirror`, `--all` and `--branches`, which push or delete every branch;
 * - a forced push: a `+` refspec, `--force`, `-f`, `--force-with-lease` and `--force-if-includes`;
 * - a push to the default branch: a refspec whose destination is it (`main`, `x:main`,
 *   `x:refs/heads/main`, `HEAD` or no refspec at all while on it), or a wildcard one;
 * - a push whose options or refspecs aren't written out (`$var`, `$(…)`), which can't be checked;
 * - `git send-pack` and `git http-push`, which push without push's options;
 * - git pointed elsewhere or reconfigured (`-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`,
 *   `--config-env`, `git config`, or GIT_DIR, GIT_CONFIG_… and the like set for the command),
 *   `gh api`, any gh command naming `merge`, and terraform.
 *
 * Long options count by any abbreviation git accepts. It is a fence, not a wall: a script the job
 * writes and runs (an npm script among them), a git alias, a shell function or a variable holding
 * the command itself are beyond it. Main's branch protection (D89) is what keeps a job from merging.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/** A word as the shell would pass it, and whether any of it is expanded when the command runs (`$x`, `$(…)`, a glob). */
interface Word { text: string; dynamic: boolean }

/** Splits a command line into simple commands' words, each `$(…)` and backtick's command among them. */
export function simpleCommands(line: string): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  let word: Word | undefined;
  const flushWord = () => { if (word) cur.push(word); word = undefined; };
  const flushCmd = () => { flushWord(); if (cur.length) out.push(cur); cur = []; };
  const add = (s: string, dynamic = false) => { word ??= { text: '', dynamic: false }; word.text += s; word.dynamic ||= dynamic; };
  /** The text from `from` to the parenthesis that closes one opened just before it, counting nesting and quotes; its end. */
  const closing = (from: number) => {
    let depth = 1;
    for (let j = from; j < line.length; j++) {
      const c = line[j];
      if (c === '\\') { j++; continue; }
      if (c === "'") { const e = line.indexOf("'", j + 1); j = e < 0 ? line.length : e; continue; }
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return j;
    }
    return line.length;
  };
  const sub = (inner: string) => { out.push(...simpleCommands(inner)); };
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      if (line[i + 1] === '\n') { i += 2; continue; }
      add(line[i + 1] ?? ''); i += 2; continue;
    }
    if (c === "'") {
      const e = line.indexOf("'", i + 1);
      add(line.slice(i + 1, e < 0 ? line.length : e)); i = e < 0 ? line.length : e + 1; continue;
    }
    if (c === '$' && line[i + 1] === "'") {
      // ANSI-C quoting: its common escapes.
      let j = i + 2; let s = '';
      while (j < line.length && line[j] !== "'") {
        if (line[j] === '\\' && j + 1 < line.length) {
          const e = line[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
          if (e === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(line.slice(j + 2)); if (m) { s += String.fromCharCode(parseInt(m[0], 16)); j += 2 + m[0].length; continue; } }
          if (/[0-7]/.test(e)) { const m = /^[0-7]{1,3}/.exec(line.slice(j + 1))!; s += String.fromCharCode(parseInt(m[0], 8)); j += 1 + m[0].length; continue; }
          s += map[e] ?? `\\${e}`; j += 2; continue;
        }
        s += line[j++];
      }
      add(s); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        const d = line[j];
        if (d === '\\' && j + 1 < line.length) {
          if ('$`"\\'.includes(line[j + 1])) { add(line[j + 1]); j += 2; continue; }
          if (line[j + 1] === '\n') { j += 2; continue; }
          add(d); j++; continue;
        }
        if (d === '$' && line[j + 1] === '(') { const e = closing(j + 2); sub(line.slice(j + 2, e)); add(line.slice(j, e + 1), true); j = e + 1; continue; }
        if (d === '`') { const e = line.indexOf('`', j + 1); const end = e < 0 ? line.length : e; sub(line.slice(j + 1, end)); add(line.slice(j, end + 1), true); j = end + 1; continue; }
        add(d, d === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(line[j + 1] ?? ''));
        j++;
      }
      add(''); i = j + 1; continue;
    }
    if (c === '$' && line[i + 1] === '(') {
      const e = closing(i + 2); sub(line.slice(i + 2, e)); add(line.slice(i, e + 1), true); i = e + 1; continue;
    }
    if (c === '`') {
      const e = line.indexOf('`', i + 1); const end = e < 0 ? line.length : e;
      sub(line.slice(i + 1, end)); add(line.slice(i, end + 1), true); i = end + 1; continue;
    }
    if (c === '$') { add(c, /[A-Za-z_{0-9@*#?$!-]/.test(line[i + 1] ?? '')); i++; continue; }
    if (c === '#' && !word) { const e = line.indexOf('\n', i); i = e < 0 ? line.length : e; continue; }
    if (c === ' ' || c === '\t') { flushWord(); i++; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') { flushCmd(); i++; continue; }
    if (c === '<' || c === '>') {
      // A redirection: its operator, a digit before it, and its target, which isn't an argument.
      if (word && /^\d+$/.test(word.text) && !word.dynamic) word = undefined; else flushWord();
      i++;
      while (line[i] === '>' || line[i] === '<' || line[i] === '&' || line[i] === '|') i++;
      if (line[i] === '(') { const e = closing(i + 1); sub(line.slice(i + 1, e)); i = e + 1; continue; }
      while (line[i] === ' ' || line[i] === '\t') i++;
      // Read the target as a word of its own and drop it.
      const before = cur.length;
      const start = i;
      let j = i;
      while (j < line.length && !' \t\n;&|()<>'.includes(line[j])) {
        if (line[j] === "'") { const e = line.indexOf("'", j + 1); j = e < 0 ? line.length : e + 1; continue; }
        if (line[j] === '"') { const e = line.indexOf('"', j + 1); j = e < 0 ? line.length : e + 1; continue; }
        if (line[j] === '\\') { j += 2; continue; }
        j++;
      }
      const target = line.slice(start, j);
      if (/\$\(|`/.test(target)) out.push(...simpleCommands(target.replace(/^"|"$/g, '').replace(/^\$\(|\)$/g, '').replace(/`/g, '')));
      cur.length = before;
      i = j; continue;
    }
    if (c === '*' || c === '?' || c === '[') { add(c, true); i++; continue; }
    add(c); i++;
  }
  flushCmd();
  return out;
}

/** Words at a command's start that aren't its program: reserved words and assignments. */
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'case', 'esac', 'in', '[[', ']]']);
/** Programs that run the command after their own options. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'builtin', 'nohup', 'nice', 'sudo', 'doas', 'xargs', 'timeout', 'gtimeout', 'stdbuf', 'caffeinate', 'chronic', 'setsid', 'ionice', 'time', 'unbuffer', 'npx', 'npm', 'run-p', 'run-s']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
/** The programs this checks, and the shells and eval it looks into. */
const CHECKED = new Set(['git', 'gh', 'terraform', 'tofu', 'eval', ...SHELLS]);

/** git's options before its subcommand that take the next word as their value, when not written with `=`. */
const GIT_VALUED = ['--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--list-cmds', '--attr-source'];
/** git's options before its subcommand that point it elsewhere or reconfigure it. */
const GIT_REDIRECTS = ['--git-dir', '--work-tree', '--exec-path', '--config-env', '--namespace', '--super-prefix'];

/** The environment variables that do what git's redirecting options do. */
const GIT_ENV_REDIRECTS = /^GIT_(DIR|WORK_TREE|EXEC_PATH|NAMESPACE|COMMON_DIR|CONFIG\w*)$/;

/** git push's long options that delete or force, or push every branch. */
const PUSH_DENIED = ['--delete', '--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--branches', '--prune'];
/** git push's long options that take the next word as their value, when not written with `=`. */
const PUSH_VALUED = ['--repo', '--receive-pack', '--exec', '--push-option'];
const PUSH_LONG = [...PUSH_DENIED, ...PUSH_VALUED, '--tags', '--follow-tags', '--dry-run', '--porcelain', '--verbose', '--quiet', '--progress',
  '--set-upstream', '--thin', '--atomic', '--signed', '--recurse-submodules', '--verify', '--ipv4', '--ipv6', '--no-verify'];

/** The options in `names` that `opt` names, exactly or as an abbreviation git takes. */
const named = (opt: string, names: string[]) => names.filter((n) => n === opt || (opt.length > 2 && n.startsWith(opt)));

export interface GuardContext {
  /** The repository's default branch. */
  branch: string;
  /** The branch checked out where the command runs, or undefined when HEAD is detached (asked only when needed). */
  current: () => string | undefined;
}

/** Why `words`, a git command after `git`, is denied, or undefined when it isn't. */
function gitDenial(args: Word[], ctx: GuardContext): string | undefined {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a.dynamic) return 'a git command whose options aren\'t written out can\'t be checked';
    const t = a.text;
    if (!t.startsWith('-')) break;
    if (t === '-c' || t.startsWith('-c') || t === '-C' || t.startsWith('-C')) return `git ${t.slice(0, 2)} points git elsewhere or reconfigures it`;
    const [name] = t.split('=', 1);
    const redirect = named(name, GIT_REDIRECTS);
    if (redirect.length && name.startsWith('--')) return `git ${redirect[0]} points git elsewhere`;
    if (!t.includes('=') && named(name, GIT_VALUED).length) i++;
  }
  const sub = args[i];
  if (!sub) return undefined;
  if (sub.text === 'config') return 'git config reconfigures git';
  if (sub.text === 'send-pack' || sub.text === 'http-push') return `git ${sub.text} pushes without git push's checks`;
  if (sub.text !== 'push') return undefined;
  return pushDenial(args.slice(i + 1), ctx);
}

/** Why a `git push` with these arguments is denied, or undefined when it isn't. */
export function pushDenial(args: Word[], ctx: GuardContext): string | undefined {
  const positional: Word[] = [];
  let repoOption = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const t = a.text;
    if (a.dynamic) return `a push whose options or refspecs aren't written out (${t}) can't be checked`;
    if (t === '--') { positional.push(...args.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const [name] = t.split('=', 1);
      if (name.startsWith('--no-')) continue;
      const denied = named(name, PUSH_DENIED);
      if (denied.length) return `git push ${denied[0]} ${/delete|prune|mirror/.test(denied.join(' ')) ? 'can delete a remote branch' : /force/.test(denied.join(' ')) ? 'forces a push' : 'pushes every branch, the default one among them'}`;
      const valued = named(name, PUSH_VALUED);
      if (valued.length && !named(name, PUSH_LONG).some((n) => !PUSH_VALUED.includes(n))) {
        if (valued.includes('--repo')) repoOption = true;
        if (!t.includes('=')) i++;
      }
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const o = t[k];
        if (o === 'd') return 'git push -d deletes a remote branch';
        if (o === 'f') return 'git push -f forces a push';
        if (o === 'o') { if (k === t.length - 1) i++; break; }
      }
      continue;
    }
    positional.push(a);
  }
  // The repository, then the refspecs; with --repo, every word may be a refspec.
  const refspecs = repoOption ? positional : positional.slice(1);
  if (!refspecs.length) {
    const on = ctx.current();
    return on === ctx.branch ? `git push with no refspec, on ${ctx.branch}, pushes the default branch` : undefined;
  }
  for (let k = 0; k < refspecs.length; k++) {
    const r = refspecs[k].text;
    if (r === 'tag') { k++; continue; }
    if (/^\+?:$/.test(r)) return `the refspec ${r} pushes every matching branch, the default one among them`;
    if (/^\+?:/.test(r)) return `the refspec ${r} deletes ${r.replace(/^\+?:/, '')} on the remote`;
    if (r.startsWith('+')) return `the refspec ${r} forces a push`;
    const colon = r.indexOf(':');
    let dst = colon >= 0 ? r.slice(colon + 1) : r;
    if (colon < 0 && (r === 'HEAD' || r === '@')) dst = ctx.current() ?? '';
    if (!dst && colon >= 0) dst = r.slice(0, colon) === 'HEAD' || r.slice(0, colon) === '@' ? ctx.current() ?? '' : r.slice(0, colon);
    if (/[*?[]/.test(dst)) return `the refspec ${r} pushes by a pattern, which can reach the default branch`;
    dst = dst.replace(/^refs\/heads\//, '');
    if (dst === ctx.branch) return `the refspec ${r} pushes to the default branch, ${ctx.branch}`;
  }
  return undefined;
}

/** Why `words`, one simple command, is denied, or undefined. */
function commandDenial(words: Word[], ctx: GuardContext, depth: number): string | undefined {
  let i = 0;
  while (i < words.length && (RESERVED.has(words[i].text) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i].text))) i++;
  if (i >= words.length) return undefined;
  // A wrapper (env, xargs, timeout, npx…) runs a command after its own options and values: the
  // first word after it that names a program checked here is taken for that command.
  if (WRAPPERS.has(basename(words[i].text))) {
    const k = words.findIndex((x, n) => n > i && CHECKED.has(basename(x.text)));
    if (k < 0) return undefined;
    i = k;
  }
  const prog = basename(words[i].text);
  const rest = words.slice(i + 1);
  if (prog === 'git') {
    // GIT_DIR=… git, or env GIT_CONFIG_…=… git: the environment's way of saying -C, --git-dir or -c.
    const set = words.slice(0, i).map((w) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w.text)?.[1]).find((n) => n && GIT_ENV_REDIRECTS.test(n));
    if (set) return `${set} points git elsewhere or reconfigures it`;
    return gitDenial(rest, ctx);
  }
  if (prog === 'gh') {
    const first = rest.find((x, k) => !x.text.startsWith('-') && !['-R', '--repo'].includes(rest[k - 1]?.text ?? ''));
    if (first?.text === 'api') return 'gh api can merge, or change the repository\'s settings';
    if (rest.some((x) => x.text === 'merge')) return 'a job never merges';
    return undefined;
  }
  if (prog === 'terraform' || prog === 'tofu') return `${prog} is a person's, never a job's`;
  if (depth > 8 && (SHELLS.has(prog) || prog === 'eval')) return 'a command nested this deep can\'t be checked';
  if (SHELLS.has(prog)) {
    const k = rest.findIndex((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x.text));
    return k < 0 || !rest[k + 1] ? undefined : lineDenial(rest[k + 1].text, ctx, depth + 1);
  }
  if (prog === 'eval') return lineDenial(rest.map((x) => x.text).join(' '), ctx, depth + 1);
  return undefined;
}

/** Why a command line is denied, or undefined when nothing in it is. */
export function lineDenial(line: string, ctx: GuardContext, depth = 0): string | undefined {
  for (const words of simpleCommands(line)) {
    const why = commandDenial(words, ctx, depth);
    if (why) return why;
  }
  return undefined;
}

/** The branch checked out in `cwd`, or undefined when HEAD is detached or it isn't a repository. */
export function currentBranch(cwd: string | undefined): string | undefined {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || undefined;
  } catch { return undefined; }
}

/**
 * The hook itself: reads Claude Code's PreToolUse input (JSON on stdin), and for a Bash command
 * this denies, says why on stderr and exits 2, which blocks the command and tells the agent why.
 * Input it can't read is denied too.
 */
export function guardHook(input: string, branch: string): { code: 0 | 2; message?: string } {
  let hook: { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
  try { hook = JSON.parse(input); } catch { return { code: 2, message: 'konjir work guard couldn\'t read the command it was asked to check: denied' }; }
  const command = hook?.tool_input?.command;
  if (command === undefined && hook?.tool_name !== 'Bash') return { code: 0 };
  if (typeof command !== 'string') return { code: 2, message: 'konjir work guard was given no command to check: denied' };
  const cwd = typeof hook.cwd === 'string' ? hook.cwd : undefined;
  let current: string | undefined | null = null;
  const why = lineDenial(command, { branch, current: () => (current === null ? (current = currentBranch(cwd)) : current) });
  return why ? { code: 2, message: `Denied in a Konjir job: ${why}. A job pushes its own branch (git push -u origin <branch>), never deletes, forces or merges; a person does that.` } : { code: 0 };
}
