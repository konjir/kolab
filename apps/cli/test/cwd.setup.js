// Every CLI test file runs from an empty folder of its own, outside any repository, so nothing
// kolab reads from the folder it is run in, above all a .konjir.json at this checkout's root
// (W9.2, API26), reaches a test. A test that needs a project makes one and goes there itself.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from '@jest/globals';

const from = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'konjir-test-cwd-')));
process.chdir(dir);
afterAll(() => {
  process.chdir(from);
  rmSync(dir, { recursive: true, force: true });
});
