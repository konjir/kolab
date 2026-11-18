/**
 * konnect's command line, read: its options, and the words that aren't options, in order.
 *
 * Options may go anywhere, with two exceptions where what follows belongs to someone else:
 *   konnect send <to> <message…>             everything after <to> is the message, as written
 *   konnect agent run <name> <harness> …     everything after <name> is the harness and its arguments
 * `--` ends konnect's options wherever it stands.
 */
import { UsageError } from './errors.js';

/** Whose messages an agent carries out (`--act-for`). */
export type ActFor = 'nobody' | 'me' | 'team';
export const ACT_FOR: readonly ActFor[] = ['nobody', 'me', 'team'];

export interface Args {
  words: string[];
  json: boolean; help: boolean; version: boolean;
  team?: string; agent?: string;
  /** -n, --limit: receive, history. */
  limit?: number;
  /** --wait, in milliseconds: receive. */
  wait?: number;
  /** --wake-on, --act-for, --system-prompt: agent add, agent run. */
  wakeOn: string[]; actFor?: ActFor; systemPrompt?: string;
  /** Plumbing: konnect logout --forget. */
  forget: boolean;
  /** Names from 0.1.0, still read for one release (aliases in konnect.ts). */
  history?: true; list?: true; withdraw?: string; noStart?: true; listen?: string; reply?: string;
}

/** `30s`, `5m`, `1h` as milliseconds. */
export function duration(given: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(given);
  if (!m) throw new UsageError(`--wait takes a number and a unit, such as 30s, 5m or 1h (${given} isn't one)`);
  return Math.round(Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h']);
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { words: [], json: false, help: false, version: false, wakeOn: [], forget: false };
  const value = (i: number, what: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${argv[i]} needs ${what}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '--') { a.words.push(...argv.slice(i + 1)); break; }
    // The message, or the harness's own command line: taken as written from its first word.
    const theirs = (a.words[0] === 'send' && a.words.length >= 2) || (a.words[0] === 'agent' && a.words[1] === 'run' && a.words.length >= 3);
    if (theirs) { a.words.push(...argv.slice(i)); break; }
    if (w === '--json') { a.json = true; continue; }
    if (w === '--help' || w === '-h') { a.help = true; continue; }
    if (w === '--version' || w === '-V') { a.version = true; continue; }
    if (w === '--team') { a.team = value(i, 'a team\'s name'); i++; continue; }
    if (w === '--agent') { a.agent = value(i, 'an agent\'s name'); i++; continue; }
    if (w === '--limit' || w === '-n') {
      const n = Number(value(i, 'a number'));
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new UsageError(`${w} is a whole number from 1 to 200`);
      a.limit = n; i++; continue;
    }
    if (w === '--wait') { a.wait = duration(value(i, 'how long to wait, such as 30s')); i++; continue; }
    if (w === '--wake-on') { a.wakeOn.push(value(i, 'a channel')); i++; continue; }
    if (w === '--act-for') {
      const v = value(i, 'nobody, me or team');
      if (!ACT_FOR.includes(v as ActFor)) throw new UsageError(`--act-for is nobody, me or team (${v} isn't one)`);
      a.actFor = v as ActFor; i++; continue;
    }
    if (w === '--system-prompt') {
      // The one value that may start with dashes: it is the person's own words.
      if (argv[i + 1] === undefined) throw new UsageError('--system-prompt needs the words to add');
      a.systemPrompt = argv[i + 1]; i++; continue;
    }
    if (w === '--forget') { a.forget = true; continue; }
    // 0.1.0's options.
    if (w === '--history') { a.history = true; continue; }
    if (w === '--list') { a.list = true; continue; }
    if (w === '--no-start') { a.noStart = true; continue; }
    if (w === '--withdraw') { a.withdraw = value(i, 'a GitHub username'); i++; continue; }
    if (w === '--listen') { a.listen = value(i, 'channels, as \'#a,#b\''); i++; continue; }
    if (w === '--reply') { a.reply = value(i, 'the id of the message it answers'); i++; continue; }
    if (/^-[A-Za-z-]/.test(w)) throw new UsageError(`konnect has no option ${w}: run konnect --help`);
    a.words.push(w);
  }
  return a;
}
