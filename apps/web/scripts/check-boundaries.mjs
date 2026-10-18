// The web interface's lint (IMP2): Nx module boundaries keep the web app from importing the
// database or the engine. The rule is by Nx project tag: a project tagged scope:web may depend
// only on projects tagged scope:shared (@konjir/types), through its package.json (from which Nx
// builds the project graph) and through its source's imports. Its source imports no Node module
// either (by `node:` or bare name), nor any package its package.json doesn't declare (pg, say),
// and no relative import leaves apps/web/src (into libs/, say). Exits non-zero, naming each breach.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(web, '..', '..');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Every workspace project, by package name, with its Nx tags.
const tags = new Map();
for (const dir of ['apps', 'libs']) {
  for (const name of readdirSync(join(root, dir))) {
    try { const pkg = read(join(root, dir, name, 'package.json')); tags.set(pkg.name, pkg.nx?.tags ?? []); } catch { /* not a project */ }
  }
}
const allowed = (name) => (tags.get(name) ?? []).includes('scope:shared');

const breaches = [];
const pkg = read(join(web, 'package.json'));
for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) {
  if (tags.has(dep) && !allowed(dep)) breaches.push(`package.json depends on ${dep}, which is not tagged scope:shared`);
}

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
walk(join(web, 'src'));
const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
const builtins = new Set(builtinModules);
const src = join(web, 'src') + sep;
const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const at = relative(root, f);
    if (spec.startsWith('.')) {
      if (!resolve(dirname(f), spec).startsWith(src)) breaches.push(`${at} imports ${spec}, outside apps/web/src`);
      continue;
    }
    const project = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (spec.startsWith('node:') || builtins.has(project)) { breaches.push(`${at} imports ${spec}, a Node module: the page runs in a browser`); continue; }
    if (tags.has(project) && !allowed(project)) breaches.push(`${at} imports ${spec}, which is not tagged scope:shared`);
    else if (!declared.has(project)) breaches.push(`${at} imports ${spec}, which apps/web/package.json doesn't declare`);
  }
}

if (breaches.length) {
  for (const b of breaches) console.error(`boundary: ${b}`);
  process.exit(1);
}
console.log(`boundaries hold: ${files.length} source files of @konjir/web import only projects tagged scope:shared`);
