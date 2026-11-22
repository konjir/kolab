import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** scripts/eas.mjs, as the Nx targets run it, with `env` added to (or taken from) this process's. */
const eas = (args: string[], env: Record<string, string | undefined>) => {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v;
  return spawnSync('node', [join(__dirname, '..', 'scripts', 'eas.mjs'), ...args], { encoding: 'utf8', env: merged });
};

describe('eas update', () => {
  test('is refused unless it is built as its channel\'s variant, before anything reaches EAS', () => {
    for (const [channel, variant] of [['preview', undefined], ['preview', 'development'], ['production', 'preview']] as const) {
      const r = eas(['update', '--channel', channel, '--message', 'x'], { APP_VARIANT: variant });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`must be built with APP_VARIANT=${channel}`);
    }
  });

  test('is refused with no channel, and unsigned', () => {
    expect(eas(['update', '--message', 'x'], { APP_VARIANT: 'preview' }).stderr).toContain('name the channel');
    const r = eas(['update', '--channel', 'preview', '--message', 'x'], { APP_VARIANT: 'preview', KONNECT_UPDATES_PRIVATE_KEY_PATH: '/nonexistent' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('updates are signed');
  });
});
