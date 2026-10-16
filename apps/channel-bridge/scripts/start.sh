#!/usr/bin/env sh
# Starts the channel bridge from a Kolab checkout. Claude Code runs it through the
# plugin's .mcp.json. The bridge's packages are the workspace's, so the plugin must
# run in place from a checkout where `npm install` has been run: load it with
# --plugin-dir, or from a marketplace added from the checkout's local path. A
# marketplace added from GitHub copies the plugin into Claude Code's cache, away
# from the workspace, and can't run it. The root tsconfig keeps tsx from picking
# up a tsconfig in the directory Claude Code was started in.
DIR="$(cd -P "$(dirname "$0")/.." && pwd -P)"
ROOT="$(cd -P "$DIR/../.." && pwd -P)"
TSX="$ROOT/node_modules/.bin/tsx"
if [ ! -f "$ROOT/package.json" ] || [ ! -d "$ROOT/apps/channel-bridge" ]; then
  echo "konjir channel: the plugin must run from a Kolab checkout, but it is at $DIR. Install it with --plugin-dir or from a marketplace added from a checkout's local path, not from GitHub." >&2
  exit 1
fi
if [ ! -x "$TSX" ]; then
  echo "konjir channel: $TSX is missing; run npm install in the Kolab checkout at $ROOT" >&2
  exit 1
fi
TSX_TSCONFIG_PATH="$ROOT/tsconfig.json" exec "$TSX" --conditions=@konjir/source "$DIR/src/main.ts" "$@"
