#!/usr/bin/env bash
# Run the M1 walkthrough against a fresh, throwaway Kolab started from this checkout, then stop it.
#
#   deploy/demo/run-local.sh              # embedded Postgres (PGlite) in a temporary directory
#   deploy/demo/run-local.sh --postgres   # Postgres 18 in a Docker container, removed afterwards
#
# It restarts Kolab once mid-walkthrough, while a version waits in review, to show the wait survives
# (KONJIR_DEMO_RESTART), and cleans up at the end (KONJIR_DEMO_CLEANUP=1). Nothing here talks to any
# other Kolab. KONJIR_DEMO_PORT (default 7431) and KONJIR_DEMO_TMP (default: a new temporary
# directory, removed afterwards) change where it runs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# ---- internal: start or restart the server described by $TMPD/env -----------------------------------
start_kolab() {
  # shellcheck disable=SC1091
  . "$1/env"
  (
    cd "$ROOT"
    if [ -n "${DB_URL:-}" ]; then
      KONJIR_ADMIN_TOKEN="$ADMIN" exec bin/konjir serve --port "$PORT" --database-url "$DB_URL"
    else
      KONJIR_ADMIN_TOKEN="$ADMIN" exec bin/konjir serve --port "$PORT" --data "$1/data"
    fi
  ) >>"$1/kolab.log" 2>&1 &
  echo $! >"$1/pid"
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0
    kill -0 "$(cat "$1/pid")" 2>/dev/null || { echo "Kolab exited while starting; see $1/kolab.log" >&2; tail -20 "$1/kolab.log" >&2; return 1; }
    sleep 0.5
  done
  echo "Kolab didn't answer /healthz within 60 s; see $1/kolab.log" >&2
  return 1
}

stop_kolab() {
  local pid
  pid="$(cat "$1/pid" 2>/dev/null || true)"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1/pid"
}

case "${1:-}" in
  _restart) stop_kolab "$2"; start_kolab "$2"; exit ;;
  --postgres|"") ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac

[ -d "$ROOT/node_modules" ] || { echo "run npm install in $ROOT first" >&2; exit 1; }
PORT="${KONJIR_DEMO_PORT:-7431}"
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "something already answers on port $PORT; set KONJIR_DEMO_PORT" >&2; exit 1
fi
if [ -n "${KONJIR_DEMO_TMP:-}" ]; then TMPD="$KONJIR_DEMO_TMP"; KEEP_TMP=1; mkdir -p "$TMPD"; else TMPD="$(mktemp -d)"; KEEP_TMP=; fi
[ ! -e "$TMPD/data" ] || { echo "$TMPD/data exists; use a fresh KONJIR_DEMO_TMP" >&2; exit 1; }
chmod 700 "$TMPD"
ADMIN="$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')"
CONTAINER=
DB_URL=

cleanup() {
  stop_kolab "$TMPD"
  [ -z "$CONTAINER" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -n "$KEEP_TMP" ] || rm -rf "$TMPD"
}
trap cleanup EXIT

if [ "${1:-}" = "--postgres" ]; then
  command -v docker >/dev/null || { echo "--postgres needs Docker" >&2; exit 1; }
  CONTAINER="konjir-demo-pg-$$"
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=demo -e POSTGRES_DB=konjir -p 127.0.0.1::5432 postgres:18 >/dev/null
  PGPORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
  for _ in $(seq 1 60); do docker exec "$CONTAINER" pg_isready -U postgres -d konjir >/dev/null 2>&1 && break; sleep 0.5; done
  sleep 1
  DB_URL="postgres://postgres:demo@127.0.0.1:$PGPORT/konjir"
  echo "Postgres 18 in container $CONTAINER, port $PGPORT"
else
  echo "PGlite in $TMPD/data"
fi

umask 077
{ printf 'PORT=%q\nADMIN=%q\nDB_URL=%q\n' "$PORT" "$ADMIN" "$DB_URL"; } >"$TMPD/env"
start_kolab "$TMPD"
echo "Kolab from $ROOT on http://127.0.0.1:$PORT/mcp (log: $TMPD/kolab.log)"
echo

KONJIR_URL="http://127.0.0.1:$PORT/mcp" KONJIR_TOKEN="$ADMIN" \
  KONJIR_DEMO_STATE="$TMPD/demo-state.json" KONJIR_DEMO_CLEANUP=1 \
  KONJIR_DEMO_RESTART="$(printf '%q _restart %q' "$HERE/run-local.sh" "$TMPD")" \
  node "$HERE/m1-walkthrough.mjs"
