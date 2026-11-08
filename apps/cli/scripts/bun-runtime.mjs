// The pinned Bun runtimes package.mjs compiles on and installs (W7.17, W7.18). Each comes from Bun's
// GitHub release zip, checked against its sha256 in apps/cli/bun-runtimes.json. github.com sometimes
// answers a release download with a 5xx for hours, so when the zip still fails after download's
// retries, the same build comes from npm instead: @oven/<name>'s tarball for the pinned version,
// from registry.npmjs.org, checked against its pinned integrity (sha512). A file that doesn't match
// its pin is refused, from either source, and never falls back. Each line it logs says which source
// it used.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { download } from './download.mjs';

export const GITHUB = 'https://github.com/oven-sh/bun/releases/download';
export const NPM = 'https://registry.npmjs.org';

/** The file a download writes, kept only once it is whole. */
function keep(file, body, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.part`, body);
  renameSync(`${file}.part`, file);
}

/**
 * The bun executable of the pinned Bun build `name` (bun-linux-aarch64, say), under cache: from a
 * zip or tarball already there, else the release zip from github, else the npm tarball from npm.
 * pinned is bun-runtimes.json's content. download's options (backoff, timeout, log) pass through.
 */
export async function runtime(name, { pinned, cache, github = GITHUB, npm = NPM, log = (line) => console.error(line), ...options }) {
  const zip = `${name}.zip`;
  const pkg = `@oven/${name}`;
  const tgz = `${name}-${pinned.version}.tgz`;
  const sha256 = pinned.sha256?.[zip];
  const integrity = pinned.integrity?.[pkg];
  if (!sha256) throw new Error(`apps/cli/bun-runtimes.json has no sha256 for ${zip}`);
  if (!integrity) throw new Error(`apps/cli/bun-runtimes.json has no integrity for ${pkg}`);
  const bin = name.startsWith('bun-windows') ? 'bun.exe' : 'bun';
  const zipFile = join(cache, zip);
  const tgzFile = join(cache, tgz);
  const what = `Bun ${pinned.version} (${name})`;

  let source;
  if (existsSync(zipFile)) source = 'zip';
  else if (existsSync(tgzFile)) source = 'tgz';
  else {
    const url = `${github}/bun-v${pinned.version}/${zip}`;
    try {
      keep(zipFile, await download(url, { log, ...options }), cache);
      source = 'zip';
    } catch (err) {
      log(`${what}: the release zip didn't download (${err instanceof Error ? err.message : String(err)}); taking ${pkg}@${pinned.version} from npm instead`);
      keep(tgzFile, await download(`${npm}/${pkg}/-/${tgz}`, { log, ...options }), cache);
      source = 'tgz';
    }
  }

  if (source === 'zip') {
    const got = createHash('sha256').update(readFileSync(zipFile)).digest('hex');
    if (got !== sha256) {
      rmSync(zipFile, { force: true });
      throw new Error(`${zip} has sha256 ${got}, but apps/cli/bun-runtimes.json pins ${sha256}; refusing to use it`);
    }
    rmSync(join(cache, name), { recursive: true, force: true });
    execFileSync('unzip', ['-q', '-o', zipFile, '-d', cache]);
    log(`${what}: the release zip from ${new URL(github).host}, sha256 as pinned`);
    return join(cache, name, bin);
  }
  const got = `sha512-${createHash('sha512').update(readFileSync(tgzFile)).digest('base64')}`;
  if (got !== integrity) {
    rmSync(tgzFile, { force: true });
    throw new Error(`${tgz} (${pkg}) has integrity ${got}, but apps/cli/bun-runtimes.json pins ${integrity}; refusing to use it`);
  }
  // Only the executable comes out of the tarball, into a directory of its own.
  const out = join(cache, `${name}-npm`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xzf', tgzFile, '-C', out, `package/bin/${bin}`]);
  const exe = join(out, 'package/bin', bin);
  chmodSync(exe, 0o755);
  log(`${what}: the npm tarball ${pkg}@${pinned.version} from ${new URL(npm).host}, integrity as pinned`);
  return exe;
}

/**
 * Install the pinned Bun build `name` in dir, as dir/bun, and run it: it must say it is the pinned
 * version. Returns its path.
 */
export async function installBun(name, dir, options) {
  const exe = await runtime(name, options);
  mkdirSync(dir, { recursive: true });
  const bun = join(dir, 'bun');
  copyFileSync(exe, bun);
  chmodSync(bun, 0o755);
  const have = execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim();
  if (have !== options.pinned.version) throw new Error(`${bun} says it is Bun ${have}, but apps/cli/bun-runtimes.json pins ${options.pinned.version}`);
  return bun;
}
