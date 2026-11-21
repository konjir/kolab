#!/usr/bin/env node
// Builds the published kolab (W2.6, binding element API6): the client and the channel bridge
// (`kolab bridge`, W9.5, API29), as one file.
//
//   node scripts/package.mjs npm                 -> dist-npm/: the npm package
//   node scripts/package.mjs binaries [target…]  -> dist-bin/: single-file executables, bun build --compile
//   node scripts/package.mjs bun <dir>           -> installs the pinned Bun for this machine in <dir>, verified
//
// Both builds are one bundle, kolab.mjs, of the CLI and everything it imports (scripts/bundle.mjs,
// with Bun): the npm package ships it, with no dependencies, so npx @konjir/kolab works without this
// workspace, and each binary is compiled from it. @konjir/server isn't in it: it brings the
// database, and only `kolab serve` loads it, so the published kolab has no serve (the CLI says
// so). Of the @konjir/* packages only @konjir/login, the OAuth client and credentials store `kolab
// login` uses, and @konjir/channel-bridge, which `kolab bridge` runs, are bundled; the others
// reach the CLI as types only. What the bundle doesn't carry is bundled as absent, never left for
// the runtime to find in whatever folder kolab is run in (bundle.mjs says why).
//
// The version is apps/cli/package.json's, which nx release sets; the build defines KONJIR_VERSION
// with it, for `kolab --version`. It also defines KONJIR_DEFAULT_URL as the hosted Kolab (API25;
// bundle.mjs's HOSTED_URL): the Kolab a published kolab talks to with no --url, KONJIR_URL or
// project file, where a checkout, which can serve, talks to the local one.
//
// Bun is pinned in apps/cli/bun-runtimes.json: its version, the sha256 of each release zip this
// script uses, and the integrity of the same build's npm tarball (@oven/<the zip's name>). Every
// build checks that the bun on PATH is that version. The binaries are compiled on runtimes this
// script downloads and checks against those pins (--compile-executable-path), not on runtimes bun
// fetches itself: from Bun's GitHub release, retrying a 5xx or a network error a few times
// (scripts/download.mjs), or, when the zip still fails, from npm (scripts/bun-runtime.mjs, W7.18).
// A new Bun means new pins there: take the sha256s from the release's SHASUMS256.txt, and each
// integrity from `npm view @oven/<name>@<version> dist.integrity`.
//
// kolab is licensed Apache-2.0 (D63; apps/cli/LICENSE, the full licence text). LICENSE, and
// THIRD-PARTY-NOTICES.md, which lists every package the bundle inlines (from Bun's metafile) with
// its licence text, and the Bun runtime the binaries embed, ship in the npm package and with the
// binaries. The build refuses a manifest that declares any other licence.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBun, runtime as fetchRuntime } from './bun-runtime.mjs';
import { bundledPackages as packagesIn, checkBun as checkPinnedBun, fslPackages, notices as noticesOf, strayFirstParty } from '../../../tools/npm-bundle.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '../..');
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const pinned = JSON.parse(readFileSync(join(app, 'bun-runtimes.json'), 'utf8'));
if (manifest.license !== 'Apache-2.0') throw new Error(`apps/cli/package.json declares the licence ${manifest.license}, but kolab is Apache-2.0`);
// The targets we ship, and the Bun release zip each compiles on. x64 uses Bun's baseline
// runtime, which runs on CPUs without AVX2. `binaries` with no arguments builds them all.
const TARGETS = {
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-aarch64',
  'darwin-arm64': 'bun-darwin-aarch64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'windows-x64': 'bun-windows-x64-baseline',
};
const cache = join(root, 'node_modules/.cache/konjir-bun', pinned.version);

/** A pinned Bun build's executable, checked against its pin (scripts/bun-runtime.mjs). */
const runtime = (name) => fetchRuntime(name, { pinned, cache });

const checkBun = () => checkPinnedBun(pinned.version);

/** Bundles kolab into `out`/kolab.mjs, with Bun's metafile beside it (scripts/bundle.mjs); returns both paths. */
function bundle(out) {
  execFileSync('bun', [join(app, 'scripts/bundle.mjs'), out, manifest.version], { stdio: 'inherit', cwd: app });
  return { file: join(out, 'kolab.mjs'), metafile: join(out, '.metafile.json') };
}

/**
 * The first-party code the bundle may inline: the CLI's own source, @konjir/login's, @konjir/brand's
 * (the tokens its sign-in page is drawn with) and the channel bridge's (W9.5), nothing else of the
 * workspace's (no server, engine, db or address code). Those four are the workspace's only
 * Apache-2.0 packages: the rest of the repository is FSL-1.1-ALv2
 * (D64), which the Apache-2.0 kolab (D63) must never carry. The build fails on anything else,
 * since the @konjir/source condition would otherwise inline it from TypeScript unseen, and on any of
 * the four if its package.json stops declaring Apache-2.0.
 */
const FIRST_PARTY = ['apps/cli', 'libs/login', 'libs/brand', 'apps/channel-bridge'].map((dir) => join(root, dir));
const inputs = (metafile) => Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs);
function checkFirstParty(metafile, out) {
  const stray = strayFirstParty(inputs(metafile), { app, firstParty: FIRST_PARTY, root });
  // Nothing is left behind from a build that fails it.
  if (stray.length) rmSync(out, { recursive: true, force: true });
  if (stray.length) throw new Error(`the bundle inlines first-party code outside the Apache-2.0 apps/cli/src, libs/login/src, libs/brand/src and apps/channel-bridge/src: ${stray.join(', ')}`);
}

/** No package the bundle inlines may be FSL-licensed, as the rest of this workspace is (D64). */
function checkBundledLicences(packages, out) {
  const fsl = fslPackages(packages);
  if (fsl.length) rmSync(out, { recursive: true, force: true });
  if (fsl.length) throw new Error(`the bundle inlines FSL-licensed packages, which the Apache-2.0 kolab can't carry: ${fsl.map((p) => p.name).join(', ')}`);
  return packages;
}

/** The packages the bundle inlines, from Bun's metafile: the last node_modules/<name> of each input. */
const bundledPackages = (metafile) => packagesIn(inputs(metafile), app);

function notices(packages) {
  return noticesOf(packages, {
    title: 'Third-party notices for kolab',
    intro: `kolab ${manifest.version} is licensed under the Apache License 2.0 (see LICENSE). It bundles the following packages into kolab.mjs and into each single-file binary. Their licences follow.`,
    after: [
      `## Bun ${pinned.version} (binaries only)`,
      '',
      'Each single-file binary (kolab-<os>-<arch>) embeds the Bun runtime. Bun is MIT-licensed. It statically links',
      'JavaScriptCore and WebKit under the LGPL-2, and other libraries under their own licences, all listed in',
      `https://github.com/oven-sh/bun/blob/bun-v${pinned.version}/LICENSE.md, with how to relink Bun. The application`,
      'code each binary embeds is kolab.mjs, the same bundle the npm package ships.',
      '',
    ],
  });
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'bun') {
  // The pinned Bun for this machine, for CI, which runs on linux-arm64.
  if (!rest[0]) throw new Error('usage: node scripts/package.mjs bun <dir>');
  const host = `${process.platform}-${process.arch}`;
  const name = TARGETS[host];
  if (!name) throw new Error(`no pinned Bun for ${host}`);
  console.log(await installBun(name, rest[0], { pinned, cache }));
} else if (mode === 'npm') {
  checkBun();
  const out = join(app, 'dist-npm');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const { file, metafile } = bundle(out);
  checkFirstParty(metafile, out);
  chmodSync(file, 0o755);
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), notices(checkBundledLicences(bundledPackages(metafile), out)));
  rmSync(metafile);
  // The published manifest: no dependencies (they're bundled) and nothing private.
  const published = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    keywords: ['konjir', 'kolab', 'mcp', 'cli', 'agents', 'specs'],
    homepage: 'https://www.konjir.com/kolab/',
    bugs: 'https://github.com/konjir/kolab/issues',
    repository: { type: 'git', url: 'git+https://github.com/konjir/kolab.git', directory: 'apps/cli' },
    license: manifest.license,
    type: 'module',
    bin: { kolab: 'kolab.mjs' },
    files: ['kolab.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
    engines: manifest.engines,
    publishConfig: manifest.publishConfig,
  };
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
  copyFileSync(join(app, 'README.npm.md'), join(out, 'README.md'));
  copyFileSync(join(app, 'LICENSE'), join(out, 'LICENSE'));
} else if (mode === 'binaries') {
  checkBun();
  const targets = rest.length ? rest : Object.keys(TARGETS);
  for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}; use one of ${Object.keys(TARGETS).join(', ')}`);
  const out = join(app, 'dist-bin');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The one bundle, the npm package's own, in a folder of its own; each binary embeds it.
  const { file: bundled, metafile } = bundle(join(out, '.bundle'));
  checkFirstParty(metafile, out);
  for (const t of targets) {
    const file = join(out, `kolab-${t}${t.startsWith('windows') ? '.exe' : ''}`);
    // No .env or bunfig.toml autoloading: the binary reads its environment as the npm package does.
    execFileSync('bun', ['build', bundled, '--compile', `--target=${TARGETS[t].replace(/-aarch64$/, '-arm64')}`, `--compile-executable-path=${await runtime(TARGETS[t])}`,
      '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--outfile', file], { stdio: 'inherit', cwd: app });
  }
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), notices(checkBundledLicences(bundledPackages(metafile), out)));
  rmSync(join(out, '.bundle'), { recursive: true });
  copyFileSync(join(app, 'LICENSE'), join(out, 'LICENSE'));
} else {
  throw new Error('usage: node scripts/package.mjs npm | binaries [target…] | bun <dir>');
}
