/**
 * Kolab's log lines (P11, D68): one JSON object per line, `{"time", "level", "message", ...fields}`,
 * so CloudWatch Logs can count them by field (deploy/terraform/modules/monitoring). A field
 * such as `kolab`, `actor` or `event` goes beside the message where the caller knows it.
 *
 * No secret reaches a line: every string in it, the message included, has Kolab's and GitHub's
 * tokens masked (maskTokens), and any password in a URL, OAuth code or state in a query string, and
 * bearer or basic credential too; and a field whose name says it holds a secret (token, secret,
 * password, authorization, cookie, privateKey, an OAuth code or state…) is written as `***`
 * whatever it holds.
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/**
 * The patterns of Kolab's secrets, `kj<letter>_…`: a session's bearer token (an OAuth access token
 * is one too), a refresh token and an authorization code (D55), an invite (W3.4) and the admin
 * token (`kja_`), and any prefix Kolab adds later.
 */
const TOKENS = /(kj[a-z])_[A-Za-z0-9_-]+/g;
/** GitHub's tokens: OAuth (`gho_`), user-to-server (`ghu_`), server-to-server (`ghs_`), refresh (`ghr_`) and personal (`ghp_`, `github_pat_`). */
const GITHUB_TOKENS = /\b(gh[opusr]|github_pat)_[A-Za-z0-9_]+/g;
/** A URL's password: `postgres://kolab:<password>@host`. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*):[^@/\s]*@/gi;
/** An OAuth code or state in a query string: `?code=…&state=…`. */
const QUERY_SECRET = /([?&](?:code|state)=)[^&#"'\s]+/g;
/**
 * A credential in an Authorization header's words: `Bearer <token>`, `Basic <token>`, as HTTP spells
 * them (case-sensitive), and only when what follows looks like a credential, so "a basic check" and
 * "Bearer of bad news" stay as they are.
 */
const AUTH_SCHEME = /\b(Bearer|Basic) +([A-Za-z0-9_.~+/-]+=*)/g;
/** A field whose name says it holds a secret is never written, nor an OAuth `code` or `state`. */
const SECRET_FIELD = /token|secret|passw(or)?d|authorization|cookie|credential|api[-_]?key|private[-_]?key|code_verifier|^code$|^state$/i;
/** The keys every line starts with, which no field may replace. */
const RESERVED = new Set(['time', 'level', 'message']);
const MAX_DEPTH = 4;

/**
 * Whether the word after `Bearer` or `Basic` looks like a credential: at least 12 characters with a
 * digit or a symbol in them, as random tokens and base64 have, or at least 24 of anything.
 */
function credentialLike(word: string): boolean {
  return word.length >= 24 || (word.length >= 12 && /[0-9_.~+/=-]/.test(word));
}

/** An error's message, fit to log or return: any of Kolab's tokens (session, refresh, code, invite, admin) or GitHub's in it is masked. */
export function maskTokens(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e).replace(TOKENS, '$1_***').replace(GITHUB_TOKENS, '$1_***');
}

/** Text fit for a log line: Kolab's and GitHub's tokens, a URL's password, an OAuth code or state in a query, and a bearer or basic credential masked. */
export function maskSecrets(text: string): string {
  return maskTokens(text
    .replace(AUTH_SCHEME, (all, scheme: string, word: string) => (credentialLike(word) ? `${scheme} ***` : all))
    .replace(URL_PASSWORD, '$1:***@')
    .replace(QUERY_SECRET, '$1***'));
}

function clean(v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string') return maskSecrets(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Error) return maskSecrets(maskTokens(v));
  if (typeof v !== 'object') return undefined;   // undefined, a function, a symbol
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1) ?? null);
  return cleanFields(v as LogFields, depth + 1);
}

function cleanFields(fields: LogFields, depth: number): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SECRET_FIELD.test(k)) { out[k] = '***'; continue; }
    const c = clean(v, depth);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** One log line: the time, the level and the message first, then the fields, as one line of JSON. */
export function logLine(level: LogLevel, message: unknown, fields: LogFields = {}, now: Date = new Date()): string {
  const line: LogFields = { time: now.toISOString(), level, message: maskSecrets(message instanceof Error ? maskTokens(message) : String(message)) };
  for (const [k, v] of Object.entries(cleanFields(fields, 0))) if (!RESERVED.has(k)) line[k] = v;
  // A line is one line whatever it holds: JSON.stringify escapes every newline in a string.
  return JSON.stringify(line);
}

export interface Logger {
  info(message: unknown, fields?: LogFields): void;
  warn(message: unknown, fields?: LogFields): void;
  error(message: unknown, fields?: LogFields): void;
  /** A logger that adds these fields to every line, under any the line gives itself. */
  with(fields: LogFields): Logger;
}

/** Where a line goes: by default, info to stdout, warn and error to stderr (journald takes both). */
export type LogSink = (level: LogLevel, line: string) => void;

export const consoleSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function createLogger(sink: LogSink = consoleSink, base: LogFields = {}): Logger {
  const at = (level: LogLevel) => (message: unknown, fields?: LogFields) => sink(level, logLine(level, message, { ...base, ...fields }));
  return { info: at('info'), warn: at('warn'), error: at('error'), with: (fields) => createLogger(sink, { ...base, ...fields }) };
}

/** Kolab's logger. */
export const log: Logger = createLogger();
