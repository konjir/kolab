#!/usr/bin/env node
// Builds the published konjir (W2.6, binding element API6): the client alone, as one file.
//
//   node scripts/package.mjs npm                 -> dist-npm/: the npm package (konjir.mjs, package.json, README.md)
//   node scripts/package.mjs binaries [target…]  -> dist-bin/: single-file executables, bun build --compile
//
// Both bundle the CLI and everything it imports (the MCP client SDK) with Bun, so the npm package has
// no dependencies and npx konjir works without this workspace. @konjir/server is left out: it brings
// NestJS, the database and the Bedrock SDK, and only `konjir serve` loads it, so the published konjir
// has no serve (the CLI says so). The @konjir/* libraries reach the CLI as types only.
//
// The version is apps/cli/package.json's, which nx release sets; the build defines KONJIR_VERSION
// with it, for `konjir --version`. Bun's version is pinned in apps/cli/.bun-version.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const entry = join(app, 'src/main.ts');
// Every target Bun can compile for that we ship. `binaries` with no arguments builds them all.
const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64'];

const bun = (args) => execFileSync('bun', ['build', entry, '--external', '@konjir/server',
  '--define', `KONJIR_VERSION=${JSON.stringify(manifest.version)}`, ...args], { stdio: 'inherit', cwd: app });

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'npm') {
  const out = join(app, 'dist-npm');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  bun(['--target=node', '--format=esm', '--minify-syntax', '--minify-whitespace', '--outfile', join(out, 'konjir.mjs')]);
  chmodSync(join(out, 'konjir.mjs'), 0o755);
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
    files: ['konjir.mjs'],
    engines: manifest.engines,
    publishConfig: manifest.publishConfig,
  };
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
  copyFileSync(join(app, 'README.npm.md'), join(out, 'README.md'));
} else if (mode === 'binaries') {
  const targets = rest.length ? rest : TARGETS;
  for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}; use one of ${TARGETS.join(', ')}`);
  const out = join(app, 'dist-bin');
  mkdirSync(out, { recursive: true });
  for (const t of targets) {
    const file = join(out, `konjir-${t}${t.startsWith('windows') ? '.exe' : ''}`);
    rmSync(file, { force: true });
    // No .env or bunfig.toml autoloading: the binary reads its environment as the npm package does.
    // x64 builds use Bun's baseline runtime, which runs on CPUs without AVX2.
    bun(['--compile', `--target=bun-${t}${t.endsWith('x64') ? '-baseline' : ''}`, '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--outfile', file]);
  }
} else {
  throw new Error('usage: node scripts/package.mjs npm | binaries [target…]');
}
