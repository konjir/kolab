#!/bin/bash
# Starts Kolab from this release. The instance's konjir-start runs it as the konjir user, with
# /etc/konjir/env and the admin token in the environment, and passes --port and --data.
# It ships with the code, so changing how Kolab starts is a plain terraform apply.
set -euo pipefail
cd "$(dirname "$0")/../.."
# tsx compiles the source until W1.10; this tsconfig turns on the decorators NestJS needs.
export TSX_TSCONFIG_PATH="$PWD/tsconfig.json"
exec node_modules/.bin/tsx apps/cli/src/main.ts serve "$@" --quiet
