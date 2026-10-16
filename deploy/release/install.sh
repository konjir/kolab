#!/bin/bash
# Installs this release in place. The instance's konjir-update runs it as root from the
# unpacked release, then switches to the release and restarts Kolab. It ships with the code,
# so changing how Kolab installs is a plain terraform apply, not a new instance.
set -euo pipefail
cd "$(dirname "$0")/../.."
export HOME=/tmp NX_DAEMON=false NX_NO_CLOUD=true NX_TUI=false
# 1. Build: every project's Nx build target compiles it with tsc into its dist/. The build
#    needs the dev dependencies (Nx, TypeScript); none of them needs its install script.
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
npx nx run-many -t build --skip-nx-cache --output-style=static
rm -rf .nx
# 2. Run: reinstall only the production dependencies, so the release holds no build tools.
#    npm ci replaces node_modules and leaves each project's dist/ in place.
npm ci --omit=dev --no-audit --no-fund --loglevel=error
