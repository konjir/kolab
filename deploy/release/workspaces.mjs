#!/usr/bin/env node
// The workspaces a Kolab release installs and builds: `kolab serve`'s, the @konjir/kolab package
// (apps/cli) and every workspace it depends on, from the package.json files the release holds.
// Nothing else: not konnect's phone app (apps/konnect-mobile, which the release doesn't even
// carry, .gitattributes), nor the konnect CLI, which production never runs. install.sh reads it.
//
//   node deploy/release/workspaces.mjs          one name a line
//
// Run from the release's top. A workspace the closure names that isn't there fails, so a release
// never builds half of what it runs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_PACKAGE = '@konjir/kolab';
const byName = new Map();
for (const dir of ['apps', 'libs']) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'package.json');
    if (!existsSync(file)) continue;
    const p = JSON.parse(readFileSync(file, 'utf8'));
    byName.set(p.name, Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies }).filter((d) => d.startsWith('@konjir/')));
  }
}
const seen = [];
const visit = (name) => {
  if (seen.includes(name)) return;
  const deps = byName.get(name);
  if (!deps) {
    console.error(`workspaces.mjs: ${name} is no workspace this release holds`);
    process.exit(1);
  }
  seen.push(name);
  for (const d of deps) visit(d);
};
visit(ROOT_PACKAGE);
console.log(seen.sort().join('\n'));
