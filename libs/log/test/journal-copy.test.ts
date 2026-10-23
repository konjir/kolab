import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@jest/globals';

/**
 * The instance's journal copy (deploy/release/journal-copy.py) masks Caddy's and Kolab's lines as
 * this library does. Its Python tests run here, so `npm test` holds both maskings to the same
 * vectors (test/mask-vectors.json), and covers the copy's capping, forging and nesting cases.
 */
test('journal-copy.py passes its tests, the shared masking vectors among them', () => {
  const script = fileURLToPath(new URL('../../../deploy/release/test_journal_copy.py', import.meta.url));
  const r = spawnSync('python3', [script, '-v'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  expect(r.error).toBeUndefined();
  expect({ status: r.status, output: r.status === 0 ? '' : r.stderr }).toStrictEqual({ status: 0, output: '' });
});
