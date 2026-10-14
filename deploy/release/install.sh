#!/bin/bash
# Installs this release in place. The instance's konjir-update runs it as root from the
# unpacked release, then switches to the release and restarts Kolab. It ships with the code,
# so changing how Kolab installs is a plain terraform apply, not a new instance.
set -euo pipefail
cd "$(dirname "$0")/../.."
# --omit=dev: production needs tsx, not the build tools (Nx, TypeScript), or their install scripts.
HOME=/tmp npm ci --omit=dev --no-audit --no-fund --loglevel=error
