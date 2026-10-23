#!/bin/bash
# Installs this release in place. The instance's konjir-update runs it as root from the
# unpacked release, then switches to the release and restarts Kolab. It ships with the code,
# so changing how Kolab installs is a plain terraform apply, not a new instance.
set -euo pipefail
cd -P "$(dirname "$0")/../.."
REL="$PWD"
export HOME=/tmp NX_DAEMON=false NX_NO_CLOUD=true NX_TUI=false
# The caches go inside the release, not in /tmp, which is a tmpfs (memory) and may be noexec.
# Both are removed once the install is done.
export npm_config_cache="$REL/.npm" NX_NATIVE_FILE_CACHE_DIRECTORY="$REL/.nx/native"
# On failure konjir-update stops before switching to this release or pruning old ones. So that
# a failed release doesn't take a rollback slot or show up as the newest release, remove it,
# but only an unpacked release under /opt/konjir/releases, never a checkout. Bash has already
# read the trap, and the script stays readable while open, so removing it from here is safe.
# The exit code stays non-zero.
on_exit() {
  local status=$?
  [ "$status" -eq 0 ] && return
  rm -rf "$REL/node_modules" "$REL/.nx" "$REL/.npm"
  case "$REL" in /opt/konjir/releases/?*) cd / && rm -rf "$REL" ;; esac
}
trap on_exit EXIT
# 1. Build: every project's Nx build target compiles it with tsc into its dist/. The build
#    needs the dev dependencies (Nx, TypeScript); none of them needs its install script.
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
node_modules/.bin/nx run-many -t build --skip-nx-cache --output-style=static
rm -rf .nx
# 2. Run: reinstall only the production dependencies, so the release holds no build tools.
#    npm ci replaces node_modules and leaves each project's dist/ in place.
npm ci --omit=dev --no-audit --no-fund --loglevel=error
rm -rf .npm
# 3. Observe (P11, D68): ship Kolab's and Caddy's journal to CloudWatch Logs, where the alarms
#    count it. On anything but a Kolab instance, it does nothing. A failure only warns: shipping
#    logs never stops a release, or a new instance's first boot; the no-logs alarm says so.
/bin/bash deploy/release/observe.sh \
  || echo '{"level":"warn","message":"observe.sh failed, so the logs may not reach CloudWatch; the release goes on, and the no-logs alarm fires within 30 minutes","event":"observe_failed"}' >&2
