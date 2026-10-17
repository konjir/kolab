// The review settings W1.7 retired (REV5): konjir serve refuses one that asks for a model reviewer,
// and still starts with what the deployed boot script writes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@jest/globals';
import { retiredReviewSettings } from '../src/cli.js';

const KOLAB_MODULE = join(dirname(fileURLToPath(import.meta.url)), '../../../deploy/terraform/modules/kolab');

test('a review mode other than structural is refused, from the environment or --review', () => {
  expect(retiredReviewSettings({ KONJIR_REVIEW: 'bedrock' }).refuse).toMatch(/review mode "bedrock" \(KONJIR_REVIEW\) is no longer supported \(W1\.7\)/);
  expect(retiredReviewSettings({}, 'bedrock').refuse).toMatch(/\(--review\) is no longer supported/);
  expect(retiredReviewSettings({ KONJIR_REVIEW: 'structural' }, 'bedrock').refuse).toBeDefined();
  expect(retiredReviewSettings({ KONJIR_REVIEW: 'bedrock', KONJIR_REVIEW_MODEL: 'anthropic.claude-haiku-5-5' }).refuse).toBeDefined();
  expect(retiredReviewSettings({})).toStrictEqual({});
  expect(retiredReviewSettings({ KONJIR_REVIEW: 'structural' })).toStrictEqual({});
});

test('a review model named on its own is ignored, and said so', () => {
  expect(retiredReviewSettings({ KONJIR_REVIEW_MODEL: 'anthropic.claude-haiku-5-5' })).toStrictEqual({
    warn: expect.stringMatching(/^ignoring KONJIR_REVIEW_MODEL=anthropic\.claude-haiku-5-5: Kolab has no model reviewer/),
  });
});

test('what the deployed boot script writes starts Kolab without a word', () => {
  // The boot script's /etc/konjir/env, with the values modules/kolab passes it.
  const template = readFileSync(join(KOLAB_MODULE, 'userdata.sh.tftpl'), 'utf8');
  const module = readFileSync(join(KOLAB_MODULE, 'main.tf'), 'utf8');
  const value = (v: string) => module.match(new RegExp(`^\\s*${v}\\s*=\\s*"([^"]*)"`, 'm'))![1];
  const env = Object.fromEntries([...template.matchAll(/^(KONJIR_REVIEW\w*)=\$\{(\w+)\}$/gm)].map(([, k, v]) => [k, value(v)]));
  expect(env).toStrictEqual({ KONJIR_REVIEW: 'structural', KONJIR_REVIEW_MODEL: 'anthropic.claude-haiku-5-5' });
  expect(retiredReviewSettings(env)).toStrictEqual({});
});
