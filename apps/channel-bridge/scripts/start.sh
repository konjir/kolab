#!/usr/bin/env sh
# Starts the channel bridge from this checkout. Claude Code runs it through the
# plugin's .mcp.json. The bridge's packages are the workspace's, so run
# `npm install` at the repository root first. The root tsconfig keeps tsx from
# picking up a tsconfig in the directory Claude Code was started in.
DIR="$(cd -P "$(dirname "$0")/.." && pwd -P)"
ROOT="$(cd -P "$DIR/../.." && pwd -P)"
TSX="$ROOT/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "konjir channel: $TSX is missing; run npm install in $ROOT" >&2
  exit 1
fi
TSX_TSCONFIG_PATH="$ROOT/tsconfig.json" exec "$TSX" "$DIR/src/main.ts" "$@"
