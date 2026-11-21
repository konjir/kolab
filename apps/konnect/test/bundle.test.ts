// konnect is Apache-2.0 (as kolab is, D63) and the rest of this repository FSL-1.1-ALv2 (D64): the
// published konnect.mjs may carry the first-party source of apps/konnect, libs/login, libs/brand
// and the channel bridge's subscription alone (scripts/package.mjs fails the build on anything else, through tools/npm-bundle.mjs). The
// check is tested here on inputs a bundle could have, and, where the pinned Bun is installed, on the
// real bundle's (CI's "Build konnect" job always builds it).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from '@jest/globals';
// @ts-expect-error: a plain .mjs module of the workspace's tools, with no types
import { guardBundle, strayFirstParty } from '../../../tools/npm-bundle.mjs';

const root = resolve(import.meta.dirname, '../../..');
const app = join(root, 'apps/konnect');
const FIRST_PARTY = ['apps/konnect', 'libs/login', 'libs/brand', 'apps/channel-bridge'].map((d) => join(root, d));
const stray = (inputs: string[]) => strayFirstParty(inputs, { app, firstParty: FIRST_PARTY, root }) as string[];
const tmp = mkdtempSync(join(tmpdir(), 'konnect-bundle-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('the bundle may carry konnect\'s, @konjir/login\'s and @konjir/brand\'s source and npm packages; any other first-party code fails the build', () => {
  expect(stray(['src/main.ts', 'src/konnect.ts', '../../libs/login/src/index.ts', '../../libs/brand/src/index.ts', '../../node_modules/zod/index.js', '../../node_modules/@modelcontextprotocol/client/dist/index.js'])).toStrictEqual([]);
  for (const input of ['../../apps/server/src/agent-tools.ts', '../../libs/engine/src/kolab.ts', '../../libs/types/src/limits.ts', '../../apps/cli/src/cli.ts', 'scripts/bundle.mjs', '../../tools/npm-bundle.mjs']) {
    expect(stray([input])).toHaveLength(1);
  }
  // Through node_modules/@konjir/…, a workspace link, it is the same code.
  expect(stray(['../../node_modules/@konjir/engine/src/kolab.ts'])).toHaveLength(1);
});

test('the bundle\'s require loads Node\'s built-ins alone, and an import() of a computed name fails the build', () => {
  const guarded = guardBundle('import{createRequire}from"node:module";var __require=createRequire(import.meta.url);__require("node:fs");', 'konnect', { required: false });
  expect(guarded).toContain('the published konnect doesn\'t carry it');
  expect(guardBundle('console.log(1)', 'konnect', { required: false })).toBe('console.log(1)');
  expect(() => guardBundle('const m = import(name)', 'konnect', { required: false })).toThrow(/imports a name computed as it runs/);
  expect(() => guardBundle('console.log(1)', 'konjir')).toThrow(/doesn't define its require once/);
});

const pinned = JSON.parse(readFileSync(join(root, 'apps/cli/bun-runtimes.json'), 'utf8')).version as string;
let bun: string | undefined;
try { bun = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* none */ }

(bun === pinned ? test : test.skip)(`the real bundle (Bun ${pinned}) carries only that first-party code, and no server, engine or database code`, () => {
  execFileSync('bun', [join(app, 'scripts/bundle.mjs'), tmp, '0.0.0-test'], { cwd: app, stdio: 'pipe' });
  const inputs = Object.keys(JSON.parse(readFileSync(join(tmp, '.metafile.json'), 'utf8')).inputs);
  expect(stray(inputs)).toStrictEqual([]);
  expect(inputs.some((i) => i.endsWith('apps/konnect/src/konnect.ts') || i === 'src/konnect.ts')).toBe(true);
  expect(inputs.some((i) => i.includes('libs/login/src/'))).toBe(true);
  expect(inputs.filter((i) => /apps\/(server|cli)\/|libs\/(engine|db|address|types|log)\//.test(i))).toStrictEqual([]);
  // Of the channel bridge, the subscription and its messages alone: never its NestJS server.
  expect(inputs.map((i) => resolve(app, i)).filter((i) => i.startsWith(join(root, 'apps/channel-bridge') + '/')).map((i) => i.slice(join(root, 'apps/channel-bridge').length + 1)).sort()).toStrictEqual(['src/bridge.ts', 'src/messages.ts', 'src/version.ts']);
  const text = readFileSync(join(tmp, 'konnect.mjs'), 'utf8');
  expect(text).toContain('"0.0.0-test"');
}, 120_000);
