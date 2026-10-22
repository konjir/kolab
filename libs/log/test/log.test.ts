import { expect, test } from '@jest/globals';
import { createLogger, logLine, maskSecrets, maskTokens, type LogLevel } from '../src/index.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');

test('a line is one JSON object: time, level and message first, then the fields', () => {
  const line = logLine('error', 'outbox job is dead', { event: 'outbox_job_dead', kolab: 'kolab', actor: 'lee', attempts: 10 }, NOW);
  expect(line).not.toContain('\n');
  expect(Object.keys(JSON.parse(line))).toStrictEqual(['time', 'level', 'message', 'event', 'kolab', 'actor', 'attempts']);
  expect(JSON.parse(line)).toStrictEqual({
    time: '2026-10-22T12:00:00.000Z', level: 'error', message: 'outbox job is dead',
    event: 'outbox_job_dead', kolab: 'kolab', actor: 'lee', attempts: 10,
  });
});

test('a message or field with newlines stays on one line', () => {
  const line = logLine('warn', 'two\nlines', { stack: 'Error: x\n    at y' }, NOW);
  expect(line.split('\n')).toHaveLength(1);
  expect(JSON.parse(line)).toMatchObject({ message: 'two\nlines', stack: 'Error: x\n    at y' });
});

test('every token in the message and in the fields is masked, however deep', () => {
  const token = 'kjs_AbC123-_secretPart';
  const line = logLine('error', `could not check ${token}`, {
    error: new Error(`refused kjr_refresh0 and kjc_code1 and kji_invite2 for ${token}`),
    detail: { nested: [`Bearer ${token}`, { deeper: 'kjs_deep' }] },
  }, NOW);
  for (const secret of ['AbC123', 'secretPart', 'refresh0', 'code1', 'invite2', 'kjs_deep']) expect(line).not.toContain(secret);
  expect(JSON.parse(line)).toStrictEqual({
    time: '2026-10-22T12:00:00.000Z', level: 'error', message: 'could not check kjs_***',
    error: 'refused kjr_*** and kjc_*** and kji_*** for kjs_***',
    detail: { nested: ['Bearer ***', { deeper: 'kjs_***' }] },
  });
});

test('a password in a URL and a bearer or basic credential are masked', () => {
  expect(maskSecrets('connect postgres://kolab:s3cr3t@db.internal:5432/kolab?sslmode=verify-full failed'))
    .toBe('connect postgres://kolab:***@db.internal:5432/kolab?sslmode=verify-full failed');
  expect(maskSecrets('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer ***');
  expect(maskSecrets('Authorization: basic dXNlcjpwYXNz')).toBe('Authorization: basic ***');
  expect(maskSecrets('https://kolab.konjir.com/healthz')).toBe('https://kolab.konjir.com/healthz');
});

test('a field whose name says it holds a secret is never written, whatever it holds', () => {
  const parsed = JSON.parse(logLine('info', 'signed in', {
    token: 'anything', adminToken: 'plain', client_secret: 'x', password: 'y', Authorization: 'z', cookie: 'c',
    code_verifier: 'v', apiKey: 'k', nested: { refreshToken: 'r' }, actor: 'lee',
  }, NOW));
  expect(parsed).toStrictEqual({
    time: '2026-10-22T12:00:00.000Z', level: 'info', message: 'signed in',
    token: '***', adminToken: '***', client_secret: '***', password: '***', Authorization: '***', cookie: '***',
    code_verifier: '***', apiKey: '***', nested: { refreshToken: '***' }, actor: 'lee',
  });
});

test('no field replaces the time, the level or the message; undefined fields are left out', () => {
  const parsed = JSON.parse(logLine('warn', 'the real message', { time: 'then', level: 'error', message: 'fake', gone: undefined, n: Number.NaN, big: 10n }, NOW));
  expect(parsed).toStrictEqual({ time: '2026-10-22T12:00:00.000Z', level: 'warn', message: 'the real message', n: 'NaN', big: '10' });
});

test('an Error as the message is its masked message', () => {
  expect(JSON.parse(logLine('error', new Error('lost kjs_tok'), {}, NOW)).message).toBe('lost kjs_***');
});

test('maskTokens keeps its meaning: Kolab\'s tokens only', () => {
  expect(maskTokens(new Error('kjs_abc postgres://u:p@h/d'))).toBe('kjs_*** postgres://u:p@h/d');
  expect(maskTokens('plain')).toBe('plain');
});

test('a logger writes each line to its sink at its level, with its base fields under the line\'s own', () => {
  const lines: [LogLevel, Record<string, unknown>][] = [];
  const logger = createLogger((level, line) => lines.push([level, JSON.parse(line)]));
  const scoped = logger.with({ kolab: 'kolab', actor: 'lee' });
  scoped.info('one');
  scoped.warn('two', { actor: 'eng-1' });
  logger.error('three', { event: 'x' });
  expect(lines.map(([level, l]) => [level, l.level, l.message, l.kolab, l.actor, l.event])).toStrictEqual([
    ['info', 'info', 'one', 'kolab', 'lee', undefined],
    ['warn', 'warn', 'two', 'kolab', 'eng-1', undefined],
    ['error', 'error', 'three', undefined, undefined, 'x'],
  ]);
});
