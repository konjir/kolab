// What the published one-file packages share: konjir (apps/cli) and konnect (apps/konnect). Each
// bundles its client into one .mjs with Bun, checks it carries only the Apache-2.0 code of this
// repository it may, and lists every package it inlines, with its licence, beside it. The two
// packages' scripts (apps/cli/scripts/bundle.mjs and package.mjs, apps/konnect/scripts/bundle.mjs
// and package.mjs) say what each bundles; this file is how.
//
// Pure functions over files and text, with no Bun API, so both Node (package.mjs) and Bun
// (bundle.mjs) load it, and tests call it.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The workspace's root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What Bun writes for a bundle's own require. */
export const REQUIRE = 'var __require=createRequire(import.meta.url);';

/**
 * What takes the place of a bundle's own require: Node's built-ins, and nothing else, so a bundle
 * never resolves a package from the folder it is run in. `product` names it in the error.
 */
export const builtinsOnly = (product) => 'var __require=(()=>{const real=createRequire(import.meta.url),builtin=process.getBuiltinModule,'
  + `only=(name)=>{if(typeof name!=="string"||!builtin(name))throw Object.assign(new Error(\`Cannot find module '\${name}': the published ${product} doesn't carry it\`),{code:"MODULE_NOT_FOUND"});return name},`
  + 'load=(name)=>real(only(name));load.resolve=(name)=>real.resolve(only(name));return load})();';

/**
 * A finished bundle's text, its require replaced by builtinsOnly's. `required`: the bundle must
 * define its require exactly once (konjir's always does); otherwise it may define none, and never
 * more than one. Throws on an import() of anything but a literal, which would be resolved as it runs.
 */
export function guardBundle(text, product, { required = true } = {}) {
  const defined = text.split(REQUIRE).length - 1;
  const created = text.split('createRequire(').length - 1;
  if (required ? defined !== 1 || created !== 1 : defined > 1 || created !== defined) {
    throw new Error(`the bundle doesn't define its require ${required ? 'once' : 'once at most'}, as ${REQUIRE}: Bun changed how it writes it, so the bundle script must change with it`);
  }
  const guarded = defined ? text.replace(REQUIRE, () => builtinsOnly(product)) : text;
  const computed = guarded.match(/(?<![\w$.])import\(\s*(?!["'`])[^)]{0,60}/);
  if (computed) throw new Error(`the bundle imports a name computed as it runs (${computed[0]}…): bundle what it loads, or carry it as absent`);
  return guarded;
}

/** The workspace package a path belongs to: the nearest directory above it with a package.json. */
export function owningPackage(path, root = ROOT) {
  for (let dir = dirname(path); dir.startsWith(root + '/'); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return root;
}

/**
 * The bundle's inputs that are first-party code it may not carry: anything of the workspace's but
 * the `src/` of the packages `firstParty` names (directories), each declaring Apache-2.0. `inputs`
 * are Bun's metafile's, relative to `app`. What a bundle carries as absent is no one's source.
 */
export function strayFirstParty(inputs, { app, firstParty, root = ROOT }) {
  const stray = [];
  for (const input of inputs) {
    if (input.startsWith('absent:') || input.startsWith('no-import:')) continue;
    const path = resolve(app, input);
    if (/\/node_modules\//.test(path) && !/\/node_modules\/@konjir\//.test(path)) continue;
    const pkg = owningPackage(path, root);
    const { license } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    if (!firstParty.includes(pkg) || !path.startsWith(join(pkg, 'src') + '/') || license !== 'Apache-2.0') {
      stray.push(`${path} (${pkg === root ? 'the workspace root' : pkg.slice(root.length + 1)}, licensed ${license ?? 'nothing'})`);
    }
  }
  return stray;
}

/** The packages a bundle inlines, from its metafile's inputs: the last node_modules/<name> of each, with its licence and NOTICE. */
export function bundledPackages(inputs, app) {
  const dirs = new Map();
  for (const input of inputs) {
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
  // By name, then version: two copies of one package are listed in the same order every build.
  }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The packages among `packages` that are FSL-licensed, as the rest of this workspace is (D64): none may be bundled. */
export const fslPackages = (packages) => packages.filter((p) => /\bFSL-|Functional Source License/i.test(`${p.license}\n${p.text ?? ''}`));

/** THIRD-PARTY-NOTICES.md: `intro`, then each bundled package with its licence text, then `after`'s lines. */
export function notices(packages, { title, intro, after = [] }) {
  return [
    `# ${title}`,
    '',
    intro,
    '',
    ...packages.flatMap((p) => [
      `## ${p.name} ${p.version} (${p.license})`,
      '',
      p.text ? '```\n' + p.text + '\n```' : `No licence file ships with ${p.name}; its package.json declares ${p.license}.`,
      '',
    ]),
    ...after,
  ].join('\n');
}

/** Refuses a bun on PATH that isn't the pinned version (apps/cli/bun-runtimes.json). */
export function checkBun(version) {
  let have;
  try {
    have = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`no bun on PATH; install Bun ${version} (node apps/cli/scripts/package.mjs bun <dir> installs a verified one)`);
  }
  if (have !== version) throw new Error(`bun on PATH is ${have}, but apps/cli/bun-runtimes.json pins ${version}`);
}
