/**
 * Where konnect keeps its sign-ins, and the folder's `.konnect.json`.
 *
 * konnect keeps one sign-in per team, each in a file of its own, `teams/<team>.json` in konnect's
 * config folder (KONNECT_CONFIG_DIR, else `konnect` in $XDG_CONFIG_HOME, ~/.config by default),
 * never in konjir's. Each file is @konjir/login's credentials store, keyed by Kolab's MCP URL, under
 * its lock: a team is a kolab, and a Kolab session works in one kolab, so several teams are several
 * sign-ins. The folders are the person's alone (0700) and the files too (0600).
 *
 * `.konnect.json` in a folder remembers the team konnect works in there, and Kolab's URL when it
 * isn't the hosted one. It holds no token. konnect reads it as konjir reads `.konjir.json`: in a git
 * repository, the nearest from the folder up to the repository's root; outside one, the folder's
 * own alone. Its URL is followed unasked only to the hosted Kolab, to a Kolab on this machine, or to
 * one konnect keeps a sign-in for, which the person once gave it themselves: a cloned repository's
 * file can't send konnect, or the browser it opens, anywhere else.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkKolabUrl, keptSignIns, safeUrl } from '@konjir/login';
import { TEAM, printable } from './names.js';

/** Konjir's hosted Kolab: where konnect talks by default. */
export const HOSTED_URL = 'https://kolab.konjir.com/mcp';

/** The folder's file. */
export const PROJECT_FILE = '.konnect.json';

const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code;

/** konnect's config folder. */
export function configDir(env: Record<string, string | undefined> = process.env): string {
  if (env.KONNECT_CONFIG_DIR) return env.KONNECT_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'konnect');
}

/** Refuses a team name that isn't a kolab's, before it names a file or reaches Kolab. */
export function checkTeam(team: string): string {
  if (!TEAM.test(team)) throw new Error(`${printable(team)} isn't a team's name: lowercase letters, digits and -, at most 40 characters`);
  return team;
}

/** The file one team's sign-in is kept in. */
export function teamFile(team: string, env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), 'teams', `${checkTeam(team)}.json`);
}

/**
 * The team's file, its folders made ready. Each folder is refused if it is a symbolic link, isn't a
 * folder, or belongs to someone else (who could then swap the file). The config folder is made
 * 0700 when konnect makes it; one that was there already (KONNECT_CONFIG_DIR may name any folder)
 * is never changed, and refused if others may write in it. `teams/` inside it is konnect's own,
 * so it is kept at 0700.
 */
export function teamFileReady(team: string, env: Record<string, string | undefined> = process.env): string {
  return fileReady(teamFile(team, env), env);
}

/**
 * `file`'s folders made ready, from konnect's config folder down: each refused if it is a symbolic
 * link, isn't a folder, or belongs to someone else; the config folder never changed when konnect
 * didn't make it, and refused if others may write in it; konnect's own folders below it kept at 0700.
 */
function fileReady(file: string, env: Record<string, string | undefined>): string {
  const config = configDir(env);
  const dirs: string[] = [];
  for (let d = dirname(file); d.startsWith(config) && d !== config; d = dirname(d)) dirs.unshift(d);
  for (const dir of [config, ...dirs]) {
    let made = false;
    try { mkdirSync(dir, { mode: 0o700 }); made = true; } catch (e) {
      if (codeOf(e) === 'ENOENT') { mkdirSync(dir, { recursive: true, mode: 0o700 }); made = true; } else if (codeOf(e) !== 'EEXIST') throw e;
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} isn't a folder of konnect's (it is a symbolic link, or not a folder), so konnect won't keep a sign-in there: remove it`);
    if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to someone else, so konnect won't keep a sign-in there: remove it, or set KONNECT_CONFIG_DIR to a folder of your own`);
    if (made || dir !== config) {
      if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    } else if (st.mode & 0o022) {
      throw new Error(`others may write in ${dir}, so konnect won't keep a sign-in there, and leaves the folder as it is: set KONNECT_CONFIG_DIR to a folder only you can write in`);
    }
  }
  return file;
}

/**
 * The file an agent's sign-in to a team is kept in: `agents/<team>/<label>.json` in konnect's config
 * folder, apart from the person's own (`teams/<team>.json`), so an agent's session never uses the
 * person's. `konnect mcp` reads it (KONNECT_CREDENTIALS names another), and `konnect claude <label>`
 * is to write it, as konjir connect claude keeps each agent's sign-in apart.
 */
export function agentFile(team: string, label: string, env: Record<string, string | undefined> = process.env): string {
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(label)) throw new Error(`${printable(label)} isn't an agent's label: lowercase letters, digits and -, at most 24 characters`);
  return join(configDir(env), 'agents', checkTeam(team), `${label}.json`);
}

/** The agent's file, its folders made ready as a team's are (teamFileReady). */
export function agentFileReady(team: string, label: string, env: Record<string, string | undefined> = process.env): string {
  return fileReady(agentFile(team, label, env), env);
}

/** The teams konnect keeps a sign-in for at `url`, by name. */
export function teamsAt(url: string, env: Record<string, string | undefined> = process.env): string[] {
  return allTeams(env).filter((t) => t.urls.includes(url)).map((t) => t.team);
}

/** Every team konnect keeps a sign-in for, at any Kolab, with the URLs it keeps one for. */
export function allTeams(env: Record<string, string | undefined> = process.env): { team: string; urls: string[] }[] {
  const dir = join(configDir(env), 'teams');
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && TEAM.test(f.slice(0, -5))).sort(); } catch { /* none */ }
  return files.map((f) => ({ team: f.slice(0, -5), urls: keptSignIns(join(dir, f)) })).filter((t) => t.urls.length);
}

/** What a `.konnect.json` says: the team, and Kolab's URL, each when it says it. */
export interface Project { path: string; team?: string; url?: string }

/** The `.konnect.json` a command run in `cwd` takes, or undefined when there is none. */
export function findProject(cwd: string): Project | undefined {
  const repo = inRepository(cwd);
  for (let dir = cwd; ; dir = dirname(dir)) {
    const path = join(dir, PROJECT_FILE);
    if (existsSync(path)) return readProject(path);
    if (!repo || existsSync(join(dir, '.git')) || dirname(dir) === dir) return undefined;
  }
}

function inRepository(cwd: string): boolean {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** A `.konnect.json`'s team and URL, checked; refused, never passed over, when it isn't what konnect writes. */
export function readProject(path: string): Project {
  const bad = (why: string) => new Error(`${printable(path)} ${why}: it names a team, {"team": "<name>"}, as konnect team <name> writes it. Fix it, or run konnect team <name> here to write it again`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8') || 'null'); } catch { throw bad('isn\'t JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('isn\'t a JSON object');
  const { team, url } = raw as { team?: unknown; url?: unknown };
  if (team !== undefined && (typeof team !== 'string' || !TEAM.test(team))) throw bad('names a team badly');
  if (url !== undefined && (typeof url !== 'string' || !wellFormedUrl(url))) throw bad('names Kolab\'s URL badly');
  return { path, ...(team !== undefined ? { team } : {}), ...(url !== undefined ? { url: url as string } : {}) };
}

/** A URL written as it reads back: http(s), nothing hidden in it, no credentials, query or fragment. */
export function wellFormedUrl(url: string): boolean {
  if (/[\p{Cc}\p{Z}]/u.test(url)) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash && u.toString() === url;
  } catch { return false; }
}

/** Whether a URL's host is this machine. */
const loopback = (url: string) => { try { return /^(localhost|127(\.\d+){3}|\[::1\])$/.test(new URL(url).hostname); } catch { return false; } };

/**
 * Whether konnect follows `url`, which only a `.konnect.json` names: the hosted Kolab, one on this
 * machine, or one konnect keeps a sign-in for.
 */
export function trustedUrl(url: string, env: Record<string, string | undefined> = process.env): boolean {
  return url === HOSTED_URL || loopback(url) || allTeams(env).some((t) => t.urls.includes(url));
}

/**
 * Writes the folder's `.konnect.json`: the team, and the URL when it isn't the hosted one. Other
 * keys already there are kept. Written whole to a new file, then moved into place.
 */
export function rememberTeam(dir: string, team: string, url: string): string {
  const path = join(dir, PROJECT_FILE);
  let was: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) was = raw as Record<string, unknown>;
  } catch { /* none, or not JSON: replaced */ }
  const { url: _, ...rest } = was;
  // Only what readProject reads back is written: never a URL it would refuse, or one with credentials.
  if (!TEAM.test(team) || (url !== HOSTED_URL && !wellFormedUrl(url))) throw new Error(`konnect won't write ${printable(path)} naming ${safeUrl(url)}: it couldn't read it back`);
  const next = { ...rest, team, ...(url !== HOSTED_URL ? { url } : {}) };
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
  renameSync(tmp, path);
  return path;
}

/** Kolab's URL, checked as a sign-in needs it, said in konnect's words. */
export function checkUrl(url: string, from: string): string {
  try { checkKolabUrl(url); } catch {
    throw new Error(`${from} names ${safeUrl(url)}, which konnect can't sign in to: give Kolab's https URL, such as ${HOSTED_URL}`);
  }
  return url;
}
