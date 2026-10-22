/**
 * Kolab's log lines (P11, D68): one JSON object per line, `{"time", "level", "message", ...fields}`,
 * so CloudWatch Logs can count them by field (deploy/terraform/modules/monitoring). A field
 * such as `kolab`, `actor` or `event` goes beside the message where the caller knows it.
 *
 * No secret reaches a line: every string in it, the message included, has Kolab's tokens masked
 * (maskTokens), and any password in a URL and any bearer credential too, and a field whose name
 * says it holds a secret (token, secret, password, authorization, cookie…) is written as `***`
 * whatever it holds.
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/**
 * The patterns of Kolab's secrets: a session's bearer token (an OAuth access token is one too),
 * a refresh token and an authorization code (D55), and an invite (W3.4).
 */
const TOKENS = /(kj[srci])_[A-Za-z0-9_-]+/g;
/** A URL's password: `postgres://kolab:<password>@host`. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*):[^@/\s]*@/gi;
/** A credential in an Authorization header's words: `Bearer <anything>`, `Basic <anything>`. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/** A field whose name says it holds a secret is never written. */
const SECRET_FIELD = /token|secret|passw(or)?d|authorization|cookie|credential|api[-_]?key|code_verifier/i;
/** The keys every line starts with, which no field may replace. */
const RESERVED = new Set(['time', 'level', 'message']);
const MAX_DEPTH = 4;

/** An error's message, fit to log or return: any session token, refresh token, code or invite in it is masked. */
export function maskTokens(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e).replace(TOKENS, '$1_***');
}

/** Text fit for a log line: Kolab's tokens, a URL's password and a bearer credential masked. */
export function maskSecrets(text: string): string {
  return text.replace(AUTH_SCHEME, '$1 ***').replace(URL_PASSWORD, '$1:***@').replace(TOKENS, '$1_***');
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
