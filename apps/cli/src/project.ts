/**
 * The project's `.konjir.json` (W9.2, API26): the kolab a project works in and Kolab's MCP URL,
 * which `konjir connect` writes, so later commands run in the project, or in a folder below it,
 * need no --kolab, --url or KONJIR_URL. It never holds a token, and names no absolute path, so it
 * may be committed.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readConfigText } from './connect.js';

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

/** A `.konjir.json`'s kolab and URL, checked: a kolab's name, and an http(s) URL with no user, password, query or fragment. */
export const readProject = (path: string): Project => parseProject(path, readConfigText(path));

function parseProject(path: string, text: string): Project {
  const bad = (why: string) => new Error(`${path} ${why}: it names the kolab and Kolab's URL, {"kolab": "<name>", "url": "https://…/mcp"}, as konjir connect writes it. Fix it, or run konjir connect again`);
  let raw: unknown;
  try { raw = JSON.parse(text || 'null'); } catch { throw bad('isn\'t JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('isn\'t a JSON object');
  const { kolab, url } = raw as { kolab?: unknown; url?: unknown };
  if (kolab !== undefined && (typeof kolab !== 'string' || !KOLAB.test(kolab) || kolab.length > 100)) throw bad('names a kolab badly');
  if (url !== undefined && (typeof url !== 'string' || !projectUrl(url))) throw bad('names Kolab\'s URL badly');
  return { path, ...(kolab !== undefined ? { kolab } : {}), ...(url !== undefined ? { url } : {}) };
}

/** Whether `url` is one a `.konjir.json` may name: http(s), with no credentials, query or fragment in it. */
function projectUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash;
}

/**
 * The text of `.konjir.json` with `kolab` and `url` set: `before`'s other keys kept, in their order,
 * and two-space indentation. A `before` that isn't a JSON object is refused (readProject's error).
 */
export function projectText(path: string, before: string, kolab: string, url: string): string {
  let was: Record<string, unknown> = {};
  if (before.trim()) {
    parseProject(path, before);
    was = JSON.parse(before) as Record<string, unknown>;
  }
  return `${JSON.stringify({ ...was, kolab, url }, null, 2)}\n`;
}
