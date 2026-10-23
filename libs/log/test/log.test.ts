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
  expect(maskSecrets('Authorization: Bearer abc.def-ghi.jkl')).toBe('Authorization: Bearer ***');
  expect(maskSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Authorization: Basic ***');
  expect(maskSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl')).toBe('Authorization: Bearer ***');
  expect(maskSecrets('https://kolab.konjir.com/healthz')).toBe('https://kolab.konjir.com/healthz');
});

test('Bearer and Basic are matched as HTTP spells them, and only before a credential-like word', () => {
  for (const plain of ['a basic check failed', 'Basic check failed', 'Bearer of bad news', 'the Bearer token was missing', 'bearer abcdefgh12345678', 'Basic authentication failed'])
    expect(maskSecrets(plain)).toBe(plain);
  expect(maskSecrets('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Bearer ***');
});

test('every kj<letter>_ token is masked, the admin token (kja_) among them', () => {
  const admin = 'kja_Q2xIb3dTZWNyZXRBZG1pblRva2VuMTIzNDU2';
  expect(maskTokens(new Error(`admin ${admin} rejected`))).toBe('admin kja_*** rejected');
  expect(maskSecrets(`admin ${admin} rejected`)).toBe('admin kja_*** rejected');
  expect(maskTokens('kjs_a kjr_b kjc_c kji_d kjz_e')).toBe('kjs_*** kjr_*** kjc_*** kji_*** kjz_***');
  expect(logLine('error', `admin ${admin} rejected`, { detail: [admin] }, NOW)).not.toContain('Q2xIb3dT');
});

test('GitHub\'s tokens are masked', () => {
  const tokens = ['gho_16C7e42F292c6912E7710c838347Ae178B4a', 'ghu_16C7e42F292c6912E7710c838347Ae178B4a', 'ghs_16C7e42F292c6912E7710c838347Ae178B4a',
    'ghr_1B4a2e77838347a7E420ce178F2E7c6912E169246c34E1ccbF66C46812d16D5B1A9Dc86A1498', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  for (const t of tokens) {
    const prefix = t.startsWith('github_pat_') ? 'github_pat' : t.slice(0, 3);
    expect(maskTokens(new Error(`GitHub refused ${t}`))).toBe(`GitHub refused ${prefix}_***`);
    expect(logLine('warn', `GitHub refused ${t}`, { error: new Error(t) }, NOW)).not.toContain(t.slice(-12));
  }
  expect(maskSecrets('the ghost_town and a ghoul stay')).toBe('the ghost_town and a ghoul stay');
});

test('an OAuth code or state in a query string is masked', () => {
  expect(maskSecrets('GET /api/session/oauth/callback?code=kjc_abc&state=xyz123 answered 502'))
    .toBe('GET /api/session/oauth/callback?code=***&state=*** answered 502');
  expect(maskSecrets('/oauth/callback/github?state=s1&code=3584d83530557fdd1f46')).toBe('/oauth/callback/github?state=***&code=***');
  expect(maskSecrets('/path?other=1&encode=x')).toBe('/path?other=1&encode=x');
});

test('a field whose name says it holds a secret is never written, whatever it holds', () => {
  const parsed = JSON.parse(logLine('info', 'signed in', {
    token: 'anything', adminToken: 'plain', client_secret: 'x', password: 'y', Authorization: 'z', cookie: 'c',
    code_verifier: 'v', apiKey: 'k', nested: { refreshToken: 'r' }, actor: 'lee',
    code: 'oauth-code', state: 'oauth-state', privateKey: '-----BEGIN', private_key: 'pk', secret: 's',
    event: 'kept', status: 500, codeName: 'kept too',
  }, NOW));
  expect(parsed).toStrictEqual({
    time: '2026-10-22T12:00:00.000Z', level: 'info', message: 'signed in',
    token: '***', adminToken: '***', client_secret: '***', password: '***', Authorization: '***', cookie: '***',
    code_verifier: '***', apiKey: '***', nested: { refreshToken: '***' }, actor: 'lee',
    code: '***', state: '***', privateKey: '***', private_key: '***', secret: '***',
    event: 'kept', status: 500, codeName: 'kept too',
  });
});

test('no field replaces the time, the level or the message; undefined fields are left out', () => {
  const parsed = JSON.parse(logLine('warn', 'the real message', { time: 'then', level: 'error', message: 'fake', gone: undefined, n: Number.NaN, big: 10n }, NOW));
  expect(parsed).toStrictEqual({ time: '2026-10-22T12:00:00.000Z', level: 'warn', message: 'the real message', n: 'NaN', big: '10' });
});

test('an Error as the message is its masked message', () => {
  expect(JSON.parse(logLine('error', new Error('lost kjs_tok'), {}, NOW)).message).toBe('lost kjs_***');
});

test('maskTokens keeps its meaning: Kolab\'s and GitHub\'s tokens only', () => {
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
