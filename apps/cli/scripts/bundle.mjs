// Bundles the published konjir into one file, konjir.mjs (package.mjs runs this with the pinned Bun):
//
//   bun scripts/bundle.mjs <out dir> <version>   -> <out dir>/konjir.mjs and <out dir>/.metafile.json
//
// The npm package ships that file, and each binary is compiled from it, so both carry the same code.
//
// The bundle resolves nothing when it runs. A binary resolves what its bundle leaves out from the
// folder it is run in, and Claude Code starts `konjir bridge` in the project: a repository that
// committed node_modules/@nestjs/websockets, or an @nestjs/core/package.json that is a folder of
// code, would run its own code as the person, with the agent's sign-in in reach (W9.5; the reviews
// of #144). So:
//
// - Packages the published konjir doesn't carry are bundled as ABSENT: a module that throws, as a
//   missing one does.
// - The bundle's own `require`, which Bun leaves for what it couldn't inline (Node's built-ins, and
//   any name computed as it runs, such as @onivoro/server-mcp's look for @nestjs/core/package.json
//   from the working folder), is replaced by one that loads Node's built-ins and nothing else.
// - load-esm, NestJS's way to `import()` a name computed as it runs, is bundled as one that refuses.
// - The build fails if the finished file still has a require of its own or a computed import().
//
//   @konjir/server                 Kolab itself, with the database: only `konjir serve` loads it,
//                                  and the published konjir has no serve (the CLI says so)
//   @nestjs/microservices, @nestjs/websockets, class-transformer, class-validator
//                                  NestJS loads each only if it is installed, and passes over one
//                                  that isn't; none is installed here and the bridge wants none
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const [out, version] = process.argv.slice(2);
if (!out || !version) throw new Error('usage: bun scripts/bundle.mjs <out dir> <version>');

const ABSENT = /^(@konjir\/server|@nestjs\/microservices|@nestjs\/websockets|class-transformer|class-validator)(\/.*)?$/;
const absent = {
  name: 'absent',
  setup(build) {
    build.onResolve({ filter: ABSENT }, (args) => ({ path: args.path, namespace: 'absent' }));
    // Node's own words and codes for a missing package, which the CLI's `serve` and NestJS each read.
    build.onLoad({ filter: /.*/, namespace: 'absent' }, (args) => ({
      loader: 'js',
      contents: `throw Object.assign(new Error(${JSON.stringify(`Cannot find package '${args.path}': the published konjir doesn't carry it`)}), { code: ${JSON.stringify(args.path.startsWith('@konjir/') ? 'ERR_MODULE_NOT_FOUND' : 'MODULE_NOT_FOUND')} });`,
    }));
  },
};

/** NestJS's `loadEsm(name)`, an import() of a name computed as it runs: the published konjir imports none. */
const noImport = {
  name: 'no-import',
  setup(build) {
    build.onResolve({ filter: /^load-esm$/ }, (args) => ({ path: args.path, namespace: 'no-import' }));
    build.onLoad({ filter: /.*/, namespace: 'no-import' }, () => ({
      loader: 'js',
      contents: 'exports.loadEsm = (name) => Promise.reject(Object.assign(new Error(`Cannot find package \'${name}\': the published konjir doesn\'t carry it`), { code: \'ERR_MODULE_NOT_FOUND\' }));',
    }));
  },
};

/** What Bun writes for the bundle's own require, and what takes its place: Node's built-ins, and nothing else. */
const REQUIRE = 'var __require=createRequire(import.meta.url);';
const BUILTINS_ONLY = 'var __require=(()=>{const real=createRequire(import.meta.url),builtin=process.getBuiltinModule,'
  + 'only=(name)=>{if(typeof name!=="string"||!builtin(name))throw Object.assign(new Error(`Cannot find module \'${name}\': the published konjir doesn\'t carry it`),{code:"MODULE_NOT_FOUND"});return name},'
  + 'load=(name)=>real(only(name));load.resolve=(name)=>real.resolve(only(name));return load})();';

mkdirSync(out, { recursive: true });
// The @konjir/source condition bundles @konjir/login and the bridge from their source, as tsx runs
// them, so the bundle needs no tsc build of either first.
const built = await Bun.build({
  entrypoints: [join(app, 'src/main.ts')],
  root: app,
  outdir: out,
  naming: 'konjir.mjs',
  target: 'node',
  format: 'esm',
  conditions: ['@konjir/source'],
  define: { KONJIR_VERSION: JSON.stringify(version) },
  minify: { syntax: true, whitespace: true },
  metafile: true,
  plugins: [absent, noImport],
});
for (const log of built.logs) console.error(String(log));
if (!built.success || built.outputs.length !== 1) throw new Error(`the bundle is not one file: ${built.outputs.map((o) => o.path).join(', ') || 'nothing was written'}`);
const file = join(out, 'konjir.mjs');
const text = readFileSync(file, 'utf8');
if (text.split(REQUIRE).length !== 2 || text.split('createRequire(').length !== 2) throw new Error(`the bundle doesn't define its require once, as ${REQUIRE}: Bun changed how it writes it, so bundle.mjs must change with it`);
const guarded = text.replace(REQUIRE, () => BUILTINS_ONLY);
// An import() of anything but a literal would be resolved as it runs.
const computed = guarded.match(/(?<![\w$.])import\(\s*(?!["'`])[^)]{0,60}/);
if (computed) throw new Error(`the bundle imports a name computed as it runs (${computed[0]}…): bundle what it loads, or carry it as absent`);
writeFileSync(file, guarded);
writeFileSync(join(out, '.metafile.json'), JSON.stringify(built.metafile));
