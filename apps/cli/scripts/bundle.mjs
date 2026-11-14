// Bundles the published konjir into one file, konjir.mjs (package.mjs runs this with the pinned Bun):
//
//   bun scripts/bundle.mjs <out dir> <version>   -> <out dir>/konjir.mjs and <out dir>/.metafile.json
//
// The npm package ships that file, and each binary is compiled from it, so both carry the same code.
//
// Packages the published konjir doesn't carry are bundled as ABSENT: a module that throws, as a
// missing one does. They are never left for the runtime to resolve. A binary resolves what its
// bundle leaves out from the folder it is run in, and Claude Code starts `konjir bridge` in the
// project: left out, a repository that committed node_modules/@nestjs/websockets would run its own
// code as the person, with the agent's sign-in in reach (W9.5; the review of #144).
//
//   @konjir/server                 Kolab itself, with the database: only `konjir serve` loads it,
//                                  and the published konjir has no serve (the CLI says so)
//   @nestjs/microservices, @nestjs/websockets, class-transformer, class-validator
//                                  NestJS loads each only if it is installed, and passes over one
//                                  that isn't; none is installed here and the bridge wants none
import { mkdirSync, writeFileSync } from 'node:fs';
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
  plugins: [absent],
});
for (const log of built.logs) console.error(String(log));
if (!built.success || built.outputs.length !== 1) throw new Error(`the bundle is not one file: ${built.outputs.map((o) => o.path).join(', ') || 'nothing was written'}`);
writeFileSync(join(out, '.metafile.json'), JSON.stringify(built.metafile));
