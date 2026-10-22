import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { log, type LogFields, type Logger } from '@konjir/log';

/**
 * NestJS's log lines, Kolab's own included (`new Logger('Push')` and the like), as Kolab's JSON
 * lines (P11, D68): `context` is the logger's name, and an error's stack rides as `stack`, masked
 * like everything else. Warn and error only, as before.
 *
 * Nest calls `error(message, stack?, context?)` and `warn(message, context?)`: the last string is
 * the context, and with two, the first is the stack.
 */
export class JsonNestLogger implements LoggerService {
  constructor(private readonly logger: Logger = log) {}

  error(message: unknown, ...params: unknown[]) { this.logger.error(message, fieldsOf(params, true)); }
  warn(message: unknown, ...params: unknown[]) { this.logger.warn(message, fieldsOf(params, false)); }
  fatal(message: unknown, ...params: unknown[]) { this.logger.error(message, { ...fieldsOf(params, true), fatal: true }); }
  log() { /* info: not logged, as before (warn and error only) */ }
  debug() { /* not logged */ }
  verbose() { /* not logged */ }
}

function fieldsOf(params: unknown[], withStack: boolean): LogFields {
  const p = [...params];
  const context = p.length && typeof p[p.length - 1] === 'string' ? String(p.pop()) : undefined;
  const fields: LogFields = { context };
  const first = p[0];
  if (withStack && typeof first === 'string' && first) fields.stack = first;
  else if (first !== undefined) fields.detail = first;
  return fields;
}

/**
 * Logs every response with a 5xx status, at error level, as `event: http_5xx`, with its method,
 * path (never its query, which may carry an authorization code) and status: the deployed stack's
 * server-error alarm counts error lines (README: Alarms).
 */
export function serverErrors(logger: Logger = log) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (res.statusCode < 500) return;
      logger.error(`${req.method} ${req.path} answered ${res.statusCode}`, { event: 'http_5xx', method: req.method, path: req.path, status: res.statusCode });
    });
    next();
  };
}
