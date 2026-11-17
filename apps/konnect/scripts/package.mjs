#!/usr/bin/env node
// Builds the published konnect, @konjir/konnect on npm, as one file:
//
//   node apps/konnect/scripts/package.mjs     -> apps/konnect/dist-npm/: the npm package
//
// One bundle, konnect.mjs, of the client and everything it imports (scripts/bundle.mjs, with the Bun
// apps/cli/bun-runtimes.json pins, which `node apps/cli/scripts/package.mjs bun <dir>` installs),
// with no dependencies, so npx @konjir/konnect works without this workspace. The version is
// apps/konnect/package.json's; the build defines KONNECT_VERSION with it, for `konnect --version`.
//
// konnect is licensed Apache-2.0, as konjir is (D63): apps/konnect/LICENSE is the full text, the
// same as apps/cli/LICENSE. The only first-party code the bundle may inline is apps/konnect/src,
// libs/login/src, libs/brand/src and apps/channel-bridge/src (the subscription that wakes an
// agent: bridge.ts and messages.ts, never its NestJS server), each declaring Apache-2.0: the rest of the repository is
// FSL-1.1-ALv2 (D64), and above all no server, engine, db or address code may ship in konnect. The
// build fails on anything else, and on a bundled package that is FSL-licensed. LICENSE and
// THIRD-PARTY-NOTICES.md, which lists every package the bundle inlines with its licence text, ship
// in the package. scripts/check-licence.sh checks the packed tarball.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledPackages, checkBun, fslPackages, notices, strayFirstParty } from '../../../tools/npm-bundle.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '../..');
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const pinned = JSON.parse(readFileSync(join(root, 'apps/cli/bun-runtimes.json'), 'utf8'));
if (manifest.license !== 'Apache-2.0') throw new Error(`apps/konnect/package.json declares the licence ${manifest.license}, but konnect is Apache-2.0`);

/** The packages whose source konnect.mjs may carry. */
const FIRST_PARTY = ['apps/konnect', 'libs/login', 'libs/brand', 'apps/channel-bridge'].map((dir) => join(root, dir));

checkBun(pinned.version);
const out = join(app, 'dist-npm');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync('bun', [join(app, 'scripts/bundle.mjs'), out, manifest.version], { stdio: 'inherit', cwd: app });
const file = join(out, 'konnect.mjs');
const metafile = join(out, '.metafile.json');
const inputs = Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs);

const stray = strayFirstParty(inputs, { app, firstParty: FIRST_PARTY, root });
const packages = bundledPackages(inputs, app);
const fsl = fslPackages(packages);
// Nothing is left behind from a build that fails.
if (stray.length || fsl.length) rmSync(out, { recursive: true, force: true });
if (stray.length) throw new Error(`the bundle inlines first-party code outside the Apache-2.0 apps/konnect/src, libs/login/src, libs/brand/src and apps/channel-bridge/src: ${stray.join(', ')}`);
if (fsl.length) throw new Error(`the bundle inlines FSL-licensed packages, which the Apache-2.0 konnect can't carry: ${fsl.map((p) => p.name).join(', ')}`);

chmodSync(file, 0o755);
writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), notices(packages, {
  title: 'Third-party notices for konnect',
  intro: `@konjir/konnect ${manifest.version} is licensed under the Apache License 2.0 (see LICENSE). It bundles the following packages into konnect.mjs. Their licences follow.`,
}));
rmSync(metafile);
// The published manifest: no dependencies (they're bundled) and nothing private.
const published = {
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  keywords: ['konnect', 'konjir', 'chat', 'agents', 'mcp', 'cli'],
  homepage: 'https://github.com/konjir/kolab#readme',
  bugs: 'https://github.com/konjir/kolab/issues',
  repository: { type: 'git', url: 'git+https://github.com/konjir/kolab.git', directory: 'apps/konnect' },
  license: manifest.license,
  type: 'module',
  bin: { konnect: 'konnect.mjs' },
  files: ['konnect.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  engines: manifest.engines,
  publishConfig: manifest.publishConfig,
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
copyFileSync(join(app, 'README.npm.md'), join(out, 'README.md'));
copyFileSync(join(app, 'LICENSE'), join(out, 'LICENSE'));
