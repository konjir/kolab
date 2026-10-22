// NestJS's lines and 5xx answers as Kolab's JSON log lines (P11, D68).
import { EventEmitter } from 'node:events';
import { expect, test } from '@jest/globals';
import { createLogger, type LogLevel } from '@konjir/log';
import { JsonNestLogger, serverErrors } from '../src/json-logger.js';

function capture() {
  const lines: [LogLevel, Record<string, unknown>][] = [];
  return { lines, logger: createLogger((level, line) => lines.push([level, JSON.parse(line)])) };
}

test('Nest\'s warn and error lines are JSON, with the logger\'s name as context and the stack masked; info is not logged', () => {
  const { lines, logger } = capture();
  const nest = new JsonNestLogger(logger);
  nest.warn('a web sign-in failed: kjs_secret1', 'WebSignIn');
  nest.error('boom kjr_secret2', 'Error: boom kjr_secret2\n    at x', 'ExceptionsHandler');
  nest.error('no context');
  nest.log('info lines stay out', 'Nest');
  expect(lines.map(([level, l]) => [level, l.message, l.context, l.stack])).toStrictEqual([
    ['warn', 'a web sign-in failed: kjs_***', 'WebSignIn', undefined],
    ['error', 'boom kjr_***', 'ExceptionsHandler', 'Error: boom kjr_***\n    at x'],
    ['error', 'no context', undefined, undefined],
  ]);
});

test('a 5xx answer is an error line with its method, path and status, never its query; others log nothing', () => {
  const { lines, logger } = capture();
  const mw = serverErrors(logger);
  const answer = (status: number, path: string) => {
    const res = Object.assign(new EventEmitter(), { statusCode: status });
    let nexted = false;
    mw({ method: 'GET', path, originalUrl: `${path}?code=kjc_secret3` } as never, res as never, () => { nexted = true; });
    expect(nexted).toBe(true);
    res.emit('finish');
  };
  answer(200, '/healthz');
  answer(404, '/nowhere');
  answer(503, '/healthz');
  expect(lines).toStrictEqual([['error', {
    time: expect.any(String), level: 'error', message: 'GET /healthz answered 503', event: 'http_5xx', method: 'GET', path: '/healthz', status: 503,
  }]]);
  expect(JSON.stringify(lines)).not.toContain('kjc_');
});
