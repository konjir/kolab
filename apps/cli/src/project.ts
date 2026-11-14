/**
 * The project's `.konjir.json` (W9.2, API26): the kolab a project works in and Kolab's MCP URL,
 * which `konjir connect` writes, so later commands run in the project, or in a folder below it,
 * need no --kolab, --url or KONJIR_URL. It never holds a token, and names no absolute path, so it
 * may be committed.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mcpUrl, readConfigText } from './connect.js';

export const PROJECT_FILE = '.konjir.json';

/** What a project's `.konjir.json` says: the kolab, and Kolab's MCP URL, each when it says it. */
export interface Project { path: string; kolab?: string; url?: string }

const KOLAB = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The `.konjir.json` a command run in `cwd` takes: in a repository, the nearest from `cwd` up to its
 * root (the folder holding .git), as konjir claude finds its project; outside one, `cwd`'s alone, so
 * a file in a folder above, which nobody chose for this one, is never read. Undefined when there is
 * none. One that isn't what konjir connect writes is refused, never passed over for the default.
 */
export function findProject(cwd: string): Project | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const path = join(dir, PROJECT_FILE);
    if (existsSync(path)) return readProject(path);
    if (dir === cwd && !inRepository(cwd)) return undefined;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return undefined;
  }
}

/** Whether `cwd` is inside a git repository: a folder from it up holds .git. */
function inRepository(cwd: string): boolean {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Text fit to print to a terminal: a path, or a name Kolab or a file gave, with every control
 * character (an escape sequence's, a line break) shown as `?`, so nothing a repository names can
 * move the cursor or rewrite what konjir said.
 */
export const shown = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?');

/**
 * A `.konjir.json`'s kolab and URL, checked: a kolab's name, and Kolab's URL as `konjir connect`
 * takes one (projectUrl), given back as connect writes it.
 */
export const readProject = (path: string): Project => parseProject(path, readConfigText(path));

/** What `text`, a `.konjir.json`'s, says; refused if it isn't what konjir connect writes. */
export function parseProject(path: string, text: string): Project {
  const bad = (why: string) => new Error(`${shown(path)} ${why}: it names the kolab and Kolab's URL, {"kolab": "<name>", "url": "https://…/mcp"}, as konjir connect writes it. Fix it, or write it again: konjir connect opencode|claude --kolab <name> --url <Kolab's URL>, which shows what it replaces first`);
  let raw: unknown;
  try { raw = JSON.parse(text || 'null'); } catch { throw bad('isn\'t JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('isn\'t a JSON object');
  const { kolab, url } = raw as { kolab?: unknown; url?: unknown };
  if (kolab !== undefined && (typeof kolab !== 'string' || !KOLAB.test(kolab) || kolab.length > 100)) throw bad('names a kolab badly');
  const named = url === undefined ? undefined : typeof url === 'string' ? projectUrl(url) : null;
  if (named === null) throw bad('names Kolab\'s URL badly');
  return { path, ...(kolab !== undefined ? { kolab } : {}), ...(named !== undefined ? { url: named } : {}) };
}

/**
 * The URL a `.konjir.json` names, as konjir uses it, or null if it may not name it: konjir connect's
 * own rule (mcpUrl: http(s), no user name or password, no query or fragment, `/mcp` for no path),
 * and written as a URL is: one with a control character or a space in it, or that reads back any
 * other way (another case, an escape, a host in another script), is refused, so what konjir prints
 * and keeps a sign-in under is the text the file holds.
 */
function projectUrl(url: string): string | null {
  if (/[\p{Cc}\p{Z}]/u.test(url)) return null;
  let as: string;
  try { as = mcpUrl(url); } catch { return null; }
  return as === url || as === `${url.replace(/\/$/, '')}/mcp` ? as : null;
}

/**
 * The text of `.konjir.json` with `kolab` and `url` set: `before`'s other keys kept, in their order,
 * and two-space indentation. A `before` that isn't a JSON object is replaced whole.
 */
export function projectText(before: string, kolab: string, url: string): string {
  let was: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(before || 'null');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) was = raw as Record<string, unknown>;
  } catch { /* not JSON: replaced */ }
  return `${JSON.stringify({ ...was, kolab, url }, null, 2)}\n`;
}

/** Whether `host`, a URL's hostname, is this machine: localhost, 127.0.0.0/8 or [::1]. */
export const loopbackHost = (host: string): boolean => /^(localhost|127(\.\d+){3}|\[::1\])$/.test(host);

/**
 * Whether konjir uses `url`, which only a project's `.konjir.json` names, without the person having
 * named it (API26). A cloned repository's file could aim konjir, and the browser konjir login and
 * connect open, anywhere, so only when it is `hosted` (Konjir's own Kolab), a Kolab on this machine,
 * or one konjir keeps a sign-in for (`kept`: the CLI's and each agent's), which the person once
 * signed in to having given the URL themselves.
 */
export function trustedProjectUrl(url: string, hosted: string, kept: () => string[]): boolean {
  if (url === hosted) return true;
  try { if (loopbackHost(new URL(url).hostname)) return true; } catch { return false; }
  return kept().some((k) => sameKolab(k, url));
}

/** Whether two URLs name the same Kolab, each read as konjir connect reads one. */
export function sameKolab(a: string, b: string): boolean {
  const as = (u: string) => { try { return mcpUrl(u); } catch { return u; } };
  return as(a) === as(b);
}
