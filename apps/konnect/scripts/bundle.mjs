// Bundles the published konnect into one file, konnect.mjs (package.mjs runs this with the pinned Bun):
//
//   bun scripts/bundle.mjs <out dir> <version>   -> <out dir>/konnect.mjs and <out dir>/.metafile.json
//
// konnect is an MCP client of Kolab: its own source, @konjir/login (the OAuth client and its
// credentials store) with @konjir/brand (the sign-in page's tokens), and the MCP client SDK. It
// resolves nothing as it runs: a require of its own loads Node's built-ins alone, and the build
// fails on an import() of a name computed as it runs (tools/npm-bundle.mjs), so a folder konnect is
// run in can't put its own code in konnect's place. The @konjir/source condition bundles the
// workspace packages from their source, so no tsc build is needed first.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardBundle } from '../../../tools/npm-bundle.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const [out, version] = process.argv.slice(2);
if (!out || !version) throw new Error('usage: bun scripts/bundle.mjs <out dir> <version>');

mkdirSync(out, { recursive: true });
const built = await Bun.build({
  entrypoints: [join(app, 'src/main.ts')],
  root: app,
  outdir: out,
  naming: 'konnect.mjs',
  target: 'node',
  format: 'esm',
  conditions: ['@konjir/source'],
  define: { KONNECT_VERSION: JSON.stringify(version) },
  minify: { syntax: true, whitespace: true },
  metafile: true,
});
for (const log of built.logs) console.error(String(log));
if (!built.success || built.outputs.length !== 1) throw new Error(`the bundle is not one file: ${built.outputs.map((o) => o.path).join(', ') || 'nothing was written'}`);
const file = join(out, 'konnect.mjs');
writeFileSync(file, guardBundle(readFileSync(file, 'utf8'), 'konnect', { required: false }));
writeFileSync(join(out, '.metafile.json'), JSON.stringify(built.metafile));
