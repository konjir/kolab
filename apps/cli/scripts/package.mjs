#!/usr/bin/env node
// Builds the published konjir (W2.6, binding element API6): the client alone, as one file.
//
//   node scripts/package.mjs npm                 -> dist-npm/: the npm package
//   node scripts/package.mjs binaries [target…]  -> dist-bin/: single-file executables, bun build --compile
//   node scripts/package.mjs bun <dir>           -> installs the pinned Bun for this machine in <dir>, verified
//
// Both builds bundle the CLI and everything it imports (the MCP client SDK) with Bun, so the npm
// package has no dependencies and npx konjir works without this workspace. @konjir/server is left
// out: it brings NestJS and the database, and only `konjir serve` loads it, so the
// published konjir has no serve (the CLI says so). The @konjir/* libraries reach the CLI as types only.
//
// The version is apps/cli/package.json's, which nx release sets; the build defines KONJIR_VERSION
// with it, for `konjir --version`.
//
// Bun is pinned in apps/cli/bun-runtimes.json: its version, and the sha256 of each release zip this
// script uses. Every build checks that the bun on PATH is that version. The binaries are compiled on
// runtimes this script downloads from Bun's GitHub release and checks against those hashes
// (--compile-executable-path), not on runtimes bun fetches itself. A new Bun means new hashes there:
// take them from the release's SHASUMS256.txt.
//
// THIRD-PARTY-NOTICES.md lists every package the bundle inlines (from Bun's metafile), with its
// licence text, and the Bun runtime the binaries embed. It ships in the npm package and with the
// binaries.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '../..');
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const pinned = JSON.parse(readFileSync(join(app, 'bun-runtimes.json'), 'utf8'));
const entry = join(app, 'src/main.ts');
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

/** Download a pinned Bun release zip, check its sha256, unzip it and return the bun executable's path. */
async function runtime(name) {
  const zip = `${name}.zip`;
  const want = pinned.sha256[zip];
  if (!want) throw new Error(`apps/cli/bun-runtimes.json has no sha256 for ${zip}`);
  const exe = join(cache, name, name.startsWith('bun-windows') ? 'bun.exe' : 'bun');
  const file = join(cache, zip);
  if (!existsSync(file)) {
    const url = `https://github.com/oven-sh/bun/releases/download/bun-v${pinned.version}/${zip}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`downloading ${url}: HTTP ${res.status}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    execFileSync('mv', [`${file}.part`, file]);
  }
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (got !== want) {
    rmSync(file, { force: true });
    throw new Error(`${zip} has sha256 ${got}, but apps/cli/bun-runtimes.json pins ${want}; refusing to use it`);
  }
  rmSync(join(cache, name), { recursive: true, force: true });
  execFileSync('unzip', ['-q', '-o', file, '-d', cache]);
  return exe;
}

function checkBun() {
  let have;
  try {
    have = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`no bun on PATH; install Bun ${pinned.version} (node apps/cli/scripts/package.mjs bun <dir> installs a verified one)`);
  }
  if (have !== pinned.version) throw new Error(`bun on PATH is ${have}, but apps/cli/bun-runtimes.json pins ${pinned.version}`);
}

const bun = (args) => execFileSync('bun', ['build', entry, '--external', '@konjir/server',
  '--define', `KONJIR_VERSION=${JSON.stringify(manifest.version)}`, ...args], { stdio: 'inherit', cwd: app });

/** The packages the bundle inlines, from Bun's metafile: the last node_modules/<name> of each input. */
function bundledPackages(metafile) {
  const dirs = new Map();
  for (const input of Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs)) {
    const path = resolve(app, input);
    const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (m) dirs.set(m[1], true);
  }
  return [...dirs.keys()].map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // The licence, and a NOTICE file where there is one (Apache-2.0 asks for it to be passed on).
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f)).sort();
    const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n') || undefined;
    return { name: pkg.name, version: pkg.version, license: pkg.license ?? 'see the package', text };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function notices(packages) {
  const parts = [
    '# Third-party notices for konjir',
    '',
    `konjir ${manifest.version} bundles the following packages into konjir.mjs and into each single-file binary. Their licences follow.`,
    '',
    ...packages.flatMap((p) => [
      `## ${p.name} ${p.version} (${p.license})`,
      '',
      p.text ? '```\n' + p.text + '\n```' : `No licence file ships with ${p.name}; its package.json declares ${p.license}.`,
      '',
    ]),
    `## Bun ${pinned.version} (binaries only)`,
    '',
    'Each single-file binary (konjir-<os>-<arch>) embeds the Bun runtime. Bun is MIT-licensed. It statically links',
    'JavaScriptCore and WebKit under the LGPL-2, and other libraries under their own licences, all listed in',
    `https://github.com/oven-sh/bun/blob/bun-v${pinned.version}/LICENSE.md, with how to relink Bun. The application`,
    'code each binary embeds is konjir.mjs, the same bundle the npm package ships.',
    '',
  ];
  return parts.join('\n');
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'bun') {
  // The pinned Bun for this machine, for CI, which runs on linux-arm64.
  if (!rest[0]) throw new Error('usage: node scripts/package.mjs bun <dir>');
  const host = `${process.platform}-${process.arch}`;
  const name = TARGETS[host];
  if (!name) throw new Error(`no pinned Bun for ${host}`);
  const exe = await runtime(name);
  mkdirSync(rest[0], { recursive: true });
  copyFileSync(exe, join(rest[0], 'bun'));
  chmodSync(join(rest[0], 'bun'), 0o755);
  console.log(join(rest[0], 'bun'));
} else if (mode === 'npm') {
  checkBun();
  const out = join(app, 'dist-npm');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const metafile = join(out, '.metafile.json');
  bun(['--target=node', '--format=esm', '--minify-syntax', '--minify-whitespace', `--metafile=${metafile}`, '--outfile', join(out, 'konjir.mjs')]);
  chmodSync(join(out, 'konjir.mjs'), 0o755);
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), notices(bundledPackages(metafile)));
  rmSync(metafile);
  // The published manifest: no dependencies (they're bundled) and nothing private.
  const published = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    keywords: ['konjir', 'kolab', 'mcp', 'cli', 'agents', 'specs'],
    homepage: 'https://github.com/konjir/kolab#readme',
    bugs: 'https://github.com/konjir/kolab/issues',
    repository: { type: 'git', url: 'git+https://github.com/konjir/kolab.git', directory: 'apps/cli' },
    license: manifest.license,
    type: 'module',
    bin: { konjir: 'konjir.mjs' },
    files: ['konjir.mjs', 'THIRD-PARTY-NOTICES.md'],
    engines: manifest.engines,
    publishConfig: manifest.publishConfig,
  };
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
  copyFileSync(join(app, 'README.npm.md'), join(out, 'README.md'));
} else if (mode === 'binaries') {
  checkBun();
  const targets = rest.length ? rest : Object.keys(TARGETS);
  for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}; use one of ${Object.keys(TARGETS).join(', ')}`);
  const out = join(app, 'dist-bin');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const metafile = join(out, '.metafile.json');
  for (const t of targets) {
    const file = join(out, `konjir-${t}${t.startsWith('windows') ? '.exe' : ''}`);
    // No .env or bunfig.toml autoloading: the binary reads its environment as the npm package does.
    bun(['--compile', `--target=${TARGETS[t].replace(/-aarch64$/, '-arm64')}`, `--compile-executable-path=${await runtime(TARGETS[t])}`,
      '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', `--metafile=${metafile}`, '--outfile', file]);
  }
  writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), notices(bundledPackages(metafile)));
  rmSync(metafile);
} else {
  throw new Error('usage: node scripts/package.mjs npm | binaries [target…] | bun <dir>');
}
