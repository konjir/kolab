#!/usr/bin/env node
// Sets the version of a kolab release (W2.6), for the Release CLI workflow (.github/workflows/release-cli.yml).
//
//   node apps/cli/scripts/release-version.mjs <patch|minor|major|X.Y.Z> [--dry-run]
//
// Run from the workspace root. nx release computes the version (nx.json's release): a bump goes
// from the semver-highest kolab@* tag on any branch, or from apps/cli/package.json's version
// before the first such tag. The version is then refused unless it is above every kolab@* tag,
// every konjir@* tag (@konjir/kolab continues konjir's versions) and every version of
// @konjir/kolab on npm, so no bump or exact version can publish one at or below a release
// already made. Only then is it written to apps/cli/package.json; with --dry-run nothing is.
// It prints the version, and the last line of its output is that version alone.
import { execFileSync, spawnSync } from 'node:child_process';
import { releaseVersion } from 'nx/release';

const PROJECT = '@konjir/kolab';
const annotate = process.env.GITHUB_ACTIONS === 'true';

function fail(message) {
  console.error(annotate ? `::error::${message}` : `error: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const specifier = args.filter((a) => a !== '--dry-run');
if (specifier.length !== 1 || !/^(patch|minor|major|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.test(specifier[0])) {
  fail(`usage: release-version.mjs <patch|minor|major|X.Y.Z> [--dry-run] (got '${args.join(' ')}'); no prereleases, and no leading zeros`);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

// Semver precedence: negative when a < b. Build metadata doesn't count.
function compare(a, b) {
  const [, ...pa] = SEMVER.exec(a);
  const [, ...pb] = SEMVER.exec(b);
  for (let i = 0; i < 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  const [qa, qb] = [pa[3], pb[3]];
  if (qa === qb) return 0;
  if (qa === undefined) return 1; // a release is above its prereleases
  if (qb === undefined) return -1;
  const [ia, ib] = [qa.split('.'), qb.split('.')];
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const [na, nb] = [/^\d+$/.test(ia[i]), /^\d+$/.test(ib[i])];
    if (na && nb && Number(ia[i]) !== Number(ib[i])) return Math.sign(Number(ia[i]) - Number(ib[i]));
    if (na !== nb) return na ? -1 : 1;
    if (!na && ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1;
  }
  return 0;
}

const highest = (versions) => versions.filter((v) => SEMVER.test(v)).reduce((max, v) => (max === null || compare(v, max) > 0 ? v : max), null);

function tagged(prefix) {
  const tags = execFileSync('git', ['tag', '--list', `${prefix}@*`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return highest(tags.map((t) => t.slice(prefix.length + 1)));
}

// @konjir/kolab is on npm, so npm must name at least one version. E404 can only mean a registry
// other than npm's (npm_config_registry, an .npmrc): like any other failure, it stops the release
// rather than dropping npm's versions from the floor.
function published() {
  const npm = spawnSync('npm', ['view', PROJECT, 'versions', '--json'], { encoding: 'utf8' });
  const registry = () => spawnSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8' }).stdout?.trim() || 'the configured registry';
  if (npm.status !== 0) {
    process.stderr.write(npm.stderr);
    if (/E404/.test(`${npm.stdout}${npm.stderr}`)) {
      fail(`npm says ${PROJECT} doesn't exist (E404) at ${registry()}, but it is published on npm: check the registry (npm_config_registry, .npmrc) and run again`);
    }
    fail(`couldn't ask npm which versions of ${PROJECT} it has`);
  }
  let versions;
  try {
    versions = JSON.parse(npm.stdout);
  } catch {
    fail(`npm view ${PROJECT} versions --json didn't print JSON: ${npm.stdout.slice(0, 200)}`);
  }
  const version = highest(Array.isArray(versions) ? versions : [versions]);
  if (version === null) fail(`npm named no version of ${PROJECT} at ${registry()}, but it is published on npm: check the registry and run again`);
  return version;
}

const floors = [
  { what: 'the newest kolab@* tag', version: tagged('kolab'), show: (v) => `kolab@${v}` },
  { what: 'the newest konjir@* tag', version: tagged('konjir'), show: (v) => `konjir@${v}` },
  { what: `the newest version of ${PROJECT} on npm`, version: published(), show: (v) => `${PROJECT}@${v}` },
].filter((f) => f.version !== null);

function refuseUnlessAbove(version) {
  const above = floors.filter((f) => compare(version, f.version) <= 0);
  if (above.length) {
    fail(`${version} isn't above ${above.map((f) => `${f.what}, ${f.show(f.version)}`).join(', or ')}: a kolab release must be above every kolab@* and konjir@* tag and every version on npm. Give a higher version.`);
  }
}

// An exact version is refused before nx release runs at all.
if (SEMVER.test(specifier[0])) refuseUnlessAbove(specifier[0]);

const computed = await releaseVersion({ specifier: specifier[0], dryRun: true, verbose: false });
const data = computed.projectsVersionData[PROJECT];
if (!data?.newVersion) fail(`nx release computed no version for ${PROJECT}`);
const version = data.newVersion;
refuseUnlessAbove(version);

if (!dryRun) {
  const written = await releaseVersion({ specifier: version, dryRun: false, verbose: false });
  if (written.projectsVersionData[PROJECT]?.newVersion !== version) fail(`nx release didn't write ${version} to apps/cli/package.json`);
}

const from = data.currentVersion ? ` (from ${data.currentVersion})` : '';
const bars = floors.map((f) => f.show(f.version)).join(', ') || 'no earlier release';
console.log(`kolab ${version}${from}, above ${bars}${dryRun ? '; dry run, nothing written' : ''}`);
console.log(version);
