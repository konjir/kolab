// Every konnect test file runs from an empty folder of its own, outside any repository, with no
// KONNECT_ variable of the person's and none of their logins: konnect's config folder is one of
// the test's own. A test that needs a folder file makes one.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from '@jest/globals';

const from = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'konnect-test-cwd-')));
process.chdir(dir);
for (const k of Object.keys(process.env)) if (k.startsWith('KONNECT_')) delete process.env[k];
process.env.KONNECT_CONFIG_DIR = join(dir, '.config-konnect');
afterAll(() => {
  process.chdir(from);
  rmSync(dir, { recursive: true, force: true });
});
