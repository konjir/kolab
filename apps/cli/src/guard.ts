/**
 * konjir work guard (W6.4; JOB4): the check a job's harness runs before each shell command, as
 * Claude Code's PreToolUse hook on Bash and Monitor. Claude Code's permission patterns are prefix
 * globs over the command as written, so quoting (`git push origin ':main'`), an option's
 * abbreviation (`--del`), a short option in a cluster (`-uf`), a wrapper (`env git push`,
 * `bash -c "…"`) or a delete refspec (`:branch`, which no pattern can write: a trailing `:*` reads
 * as their old prefix syntax) slip past them. This reads the command the way a POSIX shell splits
 * it (quotes, escapes, `$'…'`, `;`, `&&`, `||`, pipes, subshells, `$(…)` and backticks, heredocs,
 * redirections and process substitutions; not aliases, functions, brace or tilde expansion, or
 * `case` patterns inside a substitution), finds each git, gh and terraform it runs, and denies:
 *
 * - a push that deletes a remote branch: a refspec with no source (`:x`, `+:x`), `--delete` or
 *   `-d`, and `--prune`, `--mirror`, `--all` and `--branches`, which push or delete every branch;
 * - a forced push: a `+` refspec, `--force`, `-f`, `--force-with-lease` and `--force-if-includes`;
 * - a push to the default branch: a refspec whose destination is it, as git resolves it (`main`,
 *   `heads/main`, `refs/heads/main`, `x:main`), a wildcard one, or `HEAD`, `@` or no refspec at all
 *   while on it, or when the same command line changes directory or branch first, but for a new
 *   branch whose name is written out (`git checkout -b <name> && git push -u origin HEAD`), which
 *   is judged as a push of <name>;
 * - a push whose options or refspecs aren't written out (`$var`, `$(…)`, or added by xargs), which
 *   can't be checked;
 * - `git send-pack` and `git http-push`, which push without push's options;
 * - git pointed elsewhere or reconfigured (`-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`,
 *   `--config-env`, `git config`, or GIT_DIR, GIT_CONFIG_… and the like set for the command),
 *   `gh api`, any gh command naming `merge`, and terraform;
 * - a command it can't read: quoting or a substitution not closed, nesting too deep, or too long.
 *
 * Long options count by any abbreviation git accepts. It is a fence, not a wall: a script the job
 * writes and runs (an npm script among them), a git alias, a shell function or a variable holding
 * the command itself are beyond it. Main's branch protection (D89) is what keeps a job from merging.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/** A word as the shell would pass it, and whether any of it is expanded when the command runs (`$x`, `$(…)`, a glob). */
interface Word { text: string; dynamic: boolean }
/** A simple command's words, and the operator before it (`&&`, `;`, `||`, `|`, a newline, a parenthesis, or none). */
export type Command = Word[] & { sep?: string };

/** A command the guard can't read as the shell would: denied. */
export class Unreadable extends Error {}
/** The longest command the guard reads, and the deepest nesting of substitutions. */
const MAX_LENGTH = 200_000;
const MAX_NESTING = 32;

/** A heredoc whose body follows the line it is opened on: its delimiter, whether `<<-` strips tabs, and whether it was quoted (no expansion). */
interface Heredoc { delim: string; strip: boolean; quoted: boolean }

const ANSI: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };

/**
 * Splits a command line into simple commands' words, each `$(…)`, backtick and process
 * substitution's commands among them (before the command they are in), and an unquoted heredoc's
 * substitutions; a heredoc's body is data, not commands. Throws Unreadable for quoting or a
 * substitution not closed, nesting deeper than MAX_NESTING, or a line longer than MAX_LENGTH.
 */
export function simpleCommands(line: string): Command[] {
  if (line.length > MAX_LENGTH) throw new Unreadable(`it is ${line.length} characters long, more than the guard reads`);
  const out: Command[] = [];
  readList(line, { i: 0 }, out, undefined, 0);
  return out;
}

/** Reads commands from `s` at `at.i` up to `stop` (the `)` closing a `$(` or `<(`, or a backtick) or the end. */
function readList(s: string, at: { i: number }, out: Command[], stop: ')' | '`' | undefined, depth: number): void {
  if (depth > MAX_NESTING) throw new Unreadable('its substitutions nest deeper than the guard reads');
  let cur: Word[] = [];
  let word: Word | undefined;
  let dropNext = false;
  let parens = 0;
  const heredocs: Heredoc[] = [];
  const flushWord = () => { if (word) { if (dropNext) dropNext = false; else cur.push(word); } word = undefined; };
  // The operator before the next command: `&&` runs it only if the one before succeeded.
  let sep = '';
  const flushCmd = (next = '') => {
    flushWord(); dropNext = false;
    if (cur.length) out.push(Object.assign(cur, { sep }));
    cur = [];
    sep = next;
  };
  const add = (t: string, dynamic = false) => { word ??= { text: '', dynamic: false }; word.text += t; word.dynamic ||= dynamic; };
  /** A substitution whose opener ends at `at.i`, begun at `open`: its commands read, its text the word's, expanded. */
  const substitution = (open: number, close: ')' | '`', into = true) => {
    readList(s, at, out, close, depth + 1);
    if (into) add(s.slice(open, at.i), true);
  };
  /** `${…}`: its text, to the brace that closes it, outside quotes; expanded. */
  const braced = (from: number) => {
    let k = from + 2;
    let nest = 1;
    while (k < s.length && nest) {
      if (s[k] === '\\') { k += 2; continue; }
      if (s[k] === "'") { const e = s.indexOf("'", k + 1); if (e < 0) throw new Unreadable('a \' isn\'t closed'); k = e + 1; continue; }
      if (s[k] === '$' && s[k + 1] === '(') { at.i = k + 2; readList(s, at, out, ')', depth + 1); k = at.i; continue; }
      if (s[k] === '{') nest++;
      if (s[k] === '}') nest--;
      k++;
    }
    if (nest) throw new Unreadable('a ${ isn\'t closed');
    return k;
  };
  /** The bodies of the heredocs opened on the line just ended, from `at.i`: data, but an unquoted one's substitutions run. */
  const bodies = () => {
    for (const h of heredocs.splice(0)) {
      for (;;) {
        if (at.i >= s.length) break;
        const nl = s.indexOf('\n', at.i);
        const end = nl < 0 ? s.length : nl;
        const text = s.slice(at.i, end);
        if ((h.strip ? text.replace(/^\t+/, '') : text) === h.delim) { at.i = nl < 0 ? s.length : nl + 1; break; }
        if (h.quoted) { at.i = nl < 0 ? s.length : nl + 1; continue; }
        let k = at.i;
        while (k < s.length && s[k] !== '\n') {
          if (s[k] === '\\') { k += 2; continue; }
          if (s[k] === '$' && s[k + 1] === '(') { at.i = k + 2; readList(s, at, out, ')', depth + 1); k = at.i; continue; }
          if (s[k] === '`') { at.i = k + 1; readList(s, at, out, '`', depth + 1); k = at.i; continue; }
          k++;
        }
        at.i = k < s.length ? k + 1 : s.length;
      }
    }
  };
  for (;;) {
    const i = at.i;
    if (i >= s.length) {
      if (stop) throw new Unreadable(stop === ')' ? 'a $( or ( isn\'t closed' : 'a backtick isn\'t closed');
      flushCmd();
      return;
    }
    const c = s[i];
    if (stop === '`' && c === '`') { flushCmd(); at.i = i + 1; return; }
    if (c === ')') {
      flushCmd(')'); at.i = i + 1;
      if (parens > 0) { parens--; continue; }
      if (stop === ')') return;
      continue;
    }
    if (c === '(') { flushCmd('('); parens++; at.i = i + 1; continue; }
    if (c === '\\') {
      if (s[i + 1] !== '\n') add(s[i + 1] ?? '');
      at.i = i + 2; continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new Unreadable('a \' isn\'t closed');
      add(s.slice(i + 1, e)); at.i = e + 1; continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2; let t = '';
      while (j < s.length && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < s.length) {
          const e = s[j + 1];
          if (e === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2, j + 4)); if (m) { t += String.fromCharCode(parseInt(m[0], 16)); j += 2 + m[0].length; continue; } }
          if (/[0-7]/.test(e)) { const m = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4))!; t += String.fromCharCode(parseInt(m[0], 8)); j += 1 + m[0].length; continue; }
          t += ANSI[e] ?? `\\${e}`; j += 2; continue;
        }
        t += s[j++];
      }
      if (j >= s.length) throw new Unreadable('a $\' isn\'t closed');
      add(t); at.i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        const d = s[j];
        if (d === '\\' && j + 1 < s.length) {
          if ('$`"\\'.includes(s[j + 1])) { add(s[j + 1]); j += 2; continue; }
          if (s[j + 1] === '\n') { j += 2; continue; }
          add(d); j++; continue;
        }
        if (d === '$' && s[j + 1] === '(') { at.i = j + 2; substitution(j, ')'); j = at.i; continue; }
        if (d === '$' && s[j + 1] === '{') { const e = braced(j); add(s.slice(j, e), true); j = e; continue; }
        if (d === '`') { at.i = j + 1; substitution(j, '`'); j = at.i; continue; }
        add(d, d === '$' && /[A-Za-z_0-9@*#?$!-]/.test(s[j + 1] ?? ''));
        j++;
      }
      if (j >= s.length) throw new Unreadable('a " isn\'t closed');
      add(''); at.i = j + 1; continue;
    }
    if (c === '$' && s[i + 1] === '(') { at.i = i + 2; substitution(i, ')'); continue; }
    if (c === '$' && s[i + 1] === '{') { const e = braced(i); add(s.slice(i, e), true); at.i = e; continue; }
    if (c === '`') { at.i = i + 1; substitution(i, '`'); continue; }
    if (c === '$') { add(c, /[A-Za-z_0-9@*#?$!-]/.test(s[i + 1] ?? '')); at.i = i + 1; continue; }
    if (c === '#' && !word) { const e = s.indexOf('\n', i); at.i = e < 0 ? s.length : e; continue; }
    if (c === ' ' || c === '\t') { flushWord(); at.i = i + 1; continue; }
    if (c === '\n') { flushCmd('\n'); at.i = i + 1; bodies(); continue; }
    if ((c === '&' || c === '|') && s[i + 1] === c) { flushCmd(c + c); at.i = i + 2; continue; }
    if (c === ';' || c === '|' || (c === '&' && s[i + 1] !== '>')) { flushCmd(c); at.i = i + 1; continue; }
    if (c === '<' || c === '>' || c === '&') {
      // A redirection: its operator, a file descriptor's number before it, and its target, which isn't an argument.
      if (word && /^\d+$/.test(word.text) && !word.dynamic) word = undefined; else flushWord();
      if (s.startsWith('<<<', i)) { at.i = i + 3; dropNext = true; continue; }
      if (s.startsWith('<<', i)) {
        const strip = s[i + 2] === '-';
        let j = i + 2 + (strip ? 1 : 0);
        while (s[j] === ' ' || s[j] === '\t') j++;
        let delim = '';
        let quoted = false;
        while (j < s.length && !' \t\n;&|<>()'.includes(s[j])) {
          if (s[j] === "'" || s[j] === '"') {
            const e = s.indexOf(s[j], j + 1);
            if (e < 0) throw new Unreadable(`a ${s[j]} isn't closed`);
            delim += s.slice(j + 1, e); quoted = true; j = e + 1; continue;
          }
          if (s[j] === '\\') { delim += s[j + 1] ?? ''; quoted = true; j += 2; continue; }
          delim += s[j++];
        }
        if (!delim) throw new Unreadable('a heredoc names no delimiter');
        heredocs.push({ delim, strip, quoted });
        at.i = j; continue;
      }
      let j = i + 1;
      while (j < s.length && '<>&|'.includes(s[j])) j++;
      if (s[j] === '(' && j === i + 1) { at.i = j + 1; substitution(i, ')', false); continue; }
      dropNext = true;
      at.i = j; continue;
    }
    if (c === '*' || c === '?' || c === '[') { add(c, true); at.i = i + 1; continue; }
    add(c); at.i = i + 1;
  }
}

/** Words at a command's start that aren't its program: reserved words and assignments. */
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'case', 'esac', 'in', '[[', ']]']);
/** Programs that run the command after their own options. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'builtin', 'nohup', 'nice', 'sudo', 'doas', 'xargs', 'timeout', 'gtimeout', 'stdbuf', 'caffeinate', 'chronic', 'setsid', 'ionice', 'time', 'unbuffer', 'npx', 'npm', 'run-p', 'run-s']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
/** The programs this checks, and the shells and eval it looks into. */
const CHECKED = new Set(['git', 'gh', 'terraform', 'tofu', 'eval', ...SHELLS]);
/** What changes the directory or the branch a later command in the same line runs on. */
const MOVES = new Set(['cd', 'pushd', 'popd']);
const GIT_MOVES = new Set(['checkout', 'switch', 'symbolic-ref', 'co', 'sw']);

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
  /** The command line changes directory or branch before a later command runs, so `current` may not be where a push runs from. */
  moved?: boolean;
  /** The command's arguments are added to by what runs it (xargs), so they can't all be read. */
  appended?: boolean;
}

/** Why `words`, a git command after `git`, is denied, or undefined when it isn't. */
function gitDenial(args: Word[], ctx: GuardContext): string | undefined {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a.dynamic) return 'a git command whose options aren\'t written out can\'t be checked';
    const t = a.text;
    if (!t.startsWith('-')) break;
    if (t.startsWith('-c') || t.startsWith('-C')) return `git ${t.slice(0, 2)} points git elsewhere or reconfigures it`;
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
  if (ctx.appended) return 'xargs adds a push\'s refspecs when it runs, so they can\'t be checked';
  return pushDenial(args.slice(i + 1), ctx);
}

/**
 * The branch a push's destination names on the remote, as git resolves a short one there
 * (`main` and `heads/main` are refs/heads/main), or undefined when it names no branch.
 */
function remoteBranch(dst: string): string | undefined {
  if (dst.startsWith('refs/heads/')) return dst.slice('refs/heads/'.length);
  if (dst.startsWith('refs/')) return undefined;
  if (dst.startsWith('heads/')) return dst.slice('heads/'.length);
  return dst;
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
  /** The branch checked out, or why it can't be known before the command runs. */
  const here = (): { on?: string; why?: string } => (ctx.moved
    ? { why: 'this command line changes directory or branch before it pushes HEAD (or no refspec), so the branch it pushes can\'t be known: push in a command of its own, naming the branch' }
    : { on: ctx.current() });
  // The repository, then the refspecs; with --repo, every word may be a refspec.
  const refspecs = repoOption ? positional : positional.slice(1);
  if (!refspecs.length) {
    const h = here();
    if (h.why) return h.why;
    return h.on === ctx.branch ? `git push with no refspec, on ${ctx.branch}, pushes the default branch` : undefined;
  }
  for (let k = 0; k < refspecs.length; k++) {
    const r = refspecs[k].text;
    if (r === 'tag') { k++; continue; }
    if (/^\+?:$/.test(r)) return `the refspec ${r} pushes every matching branch, the default one among them`;
    if (/^\+?:/.test(r)) return `the refspec ${r} deletes ${r.replace(/^\+?:/, '')} on the remote`;
    if (r.startsWith('+')) return `the refspec ${r} forces a push`;
    const colon = r.indexOf(':');
    const src = colon >= 0 ? r.slice(0, colon) : r;
    let dst = colon >= 0 ? r.slice(colon + 1) : r;
    if (!dst) dst = src;
    if (dst === 'HEAD' || dst === '@') {
      const h = here();
      if (h.why) return h.why;
      dst = h.on ?? '';
    }
    if (/[*?[]/.test(dst)) return `the refspec ${r} pushes by a pattern, which can reach the default branch`;
    if (remoteBranch(dst) === ctx.branch) return `the refspec ${r} pushes to the default branch, ${ctx.branch}`;
  }
  return undefined;
}

/** `s` quoted for a POSIX shell, as one word. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Why `words`, one simple command, is denied, or undefined. */
function commandDenial(words: Word[], ctx: GuardContext, depth: number): string | undefined {
  let i = 0;
  while (i < words.length && (RESERVED.has(words[i].text) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i].text))) i++;
  if (i >= words.length) return undefined;
  let appended = false;
  // A wrapper (env, xargs, timeout, npx…) runs a command after its own options and values: the
  // first word after it that names a program checked here is taken for that command.
  if (WRAPPERS.has(basename(words[i].text))) {
    const k = words.findIndex((x, n) => n > i && CHECKED.has(basename(x.text)));
    // env -S "…" (--split-string), before the command, splits its string into the command's words.
    for (let n = i + 1; n < (k < 0 ? words.length : k); n++) {
      const m = /^(?:-S|--split-string)=?(.*)$/s.exec(words[n].text);
      if (!m || !words.slice(i, n).some((w) => basename(w.text) === 'env')) continue;
      const value = m[1] || words[n + 1]?.text || '';
      const after = words.slice(m[1] ? n + 1 : n + 2).map((w) => shellQuote(w.text));
      return lineDenial([value, ...after].join(' '), ctx, depth + 1);
    }
    if (k < 0) return undefined;
    appended = words.slice(i, k).some((w) => basename(w.text) === 'xargs');
    i = k;
  }
  const prog = basename(words[i].text);
  const rest = words.slice(i + 1);
  if (prog === 'git') {
    // GIT_DIR=… git, or env GIT_CONFIG_…=… git: the environment's way of saying -C, --git-dir or -c.
    const set = words.slice(0, i).map((w) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w.text)?.[1]).find((n) => n && GIT_ENV_REDIRECTS.test(n));
    if (set) return `${set} points git elsewhere or reconfigures it`;
    return gitDenial(rest, appended ? { ...ctx, appended } : ctx);
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
    if (k < 0) return undefined;
    // bash -c -- "…": the command string comes after the end of options.
    const script = rest[k + 1]?.text === '--' ? rest[k + 2] : rest[k + 1];
    return script ? lineDenial(script.text, ctx, depth + 1) : undefined;
  }
  if (prog === 'eval') return lineDenial(rest.map((x) => x.text).join(' '), ctx, depth + 1);
  return undefined;
}

/** The options of git checkout and git switch that create a branch and switch to it, naming it next. */
const CREATES: Record<string, string[]> = { checkout: ['-b', '-B'], co: ['-b', '-B'], switch: ['-c', '-C', '--create', '--force-create'], sw: ['-c', '-C', '--create', '--force-create'] };

/**
 * How a simple command changes where later commands in the line run: not at all (undefined); onto a
 * new branch whose name is written out (`git checkout -b <name>`, `git switch -c <name>`), as
 * `{ created }`; or somewhere the guard can't know before it runs (`cd`, a checkout or switch of an
 * existing branch, `symbolic-ref`, a name not written out), as 'unknown'.
 */
function move(words: Word[]): { created: string } | 'unknown' | undefined {
  let i = 0;
  while (i < words.length && (RESERVED.has(words[i].text) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i].text))) i++;
  const prog = basename(words[i]?.text ?? '');
  if (MOVES.has(prog)) return 'unknown';
  if (prog !== 'git') return undefined;
  const at = words.findIndex((w, n) => n > i && !w.text.startsWith('-'));
  const sub = words[at]?.text;
  if (!sub || !GIT_MOVES.has(sub)) return undefined;
  const flags = CREATES[sub] ?? [];
  const args = words.slice(at + 1);
  const k = args.findIndex((w) => flags.includes(w.text));
  const name = k < 0 ? undefined : args[k + 1];
  return name && !name.dynamic && !name.text.startsWith('-') && name.text ? { created: name.text } : 'unknown';
}

/** Why a command line is denied, or undefined when nothing in it is. A line it can't read is denied. */
export function lineDenial(line: string, ctx: GuardContext, depth = 0): string | undefined {
  let commands: Command[];
  try {
    commands = simpleCommands(line);
  } catch (e) {
    return `the guard can't read this command as the shell would (${e instanceof Unreadable ? e.message : 'it is nested too deep'}), so it can't be checked`;
  }
  // Where each command runs, in the line's order: as given until something moves it. After a new
  // branch made and switched to, a command joined to it by && runs on that branch, since && runs it
  // only if the switch succeeded; after anything else that moves it, the branch isn't known.
  let where: GuardContext = ctx;
  let created = false;
  for (const words of commands) {
    if (created && words.sep !== '&&') { where = { ...ctx, moved: true }; created = false; }
    const why = commandDenial(words, where, depth);
    if (why) return why;
    const m = move(words);
    if (m === 'unknown') { where = { ...ctx, moved: true }; created = false; }
    // Wherever it was, a branch made and switched to is where the next && command runs.
    else if (m) { const on = m.created; where = { ...ctx, moved: false, current: () => on }; created = true; }
  }
  return undefined;
}

/** The branch checked out in `cwd`, or undefined when HEAD is detached or it isn't a repository. */
export function currentBranch(cwd: string | undefined): string | undefined {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || undefined;
  } catch { return undefined; }
}

/** The tools whose input's `command` is a shell command the guard checks: what its hook's matcher names. */
export const GUARDED_TOOLS = ['Bash', 'Monitor'];

/**
 * The hook itself: reads Claude Code's PreToolUse input (JSON on stdin), and for a shell command
 * this denies, says why on stderr and exits 2, which blocks the command and tells the agent why.
 * Input it can't read, and any failure of its own, is denied too: Claude Code runs a command whose
 * hook exits with anything but 2.
 */
export function guardHook(input: string, branch: string): { code: 0 | 2; message?: string } {
  const denied = (why: string) => ({ code: 2 as const, message: `Denied in a Konjir job: ${why}. A job pushes its own branch (git push -u origin <branch>), never deletes, forces or merges; a person does that.` });
  try {
    let hook: { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
    try { hook = JSON.parse(input); } catch { return denied('konjir work guard couldn\'t read the command it was asked to check'); }
    const command = hook?.tool_input?.command;
    if (command === undefined && !GUARDED_TOOLS.includes(String(hook?.tool_name))) return { code: 0 };
    if (typeof command !== 'string') return denied('konjir work guard was given no command to check');
    const cwd = typeof hook.cwd === 'string' ? hook.cwd : undefined;
    let current: string | undefined | null = null;
    const why = lineDenial(command, { branch, current: () => (current === null ? (current = currentBranch(cwd)) : current) });
    return why ? denied(why) : { code: 0 };
  } catch (e) {
    return denied(`konjir work guard failed checking it (${e instanceof Error ? e.message : String(e)})`);
  }
}
