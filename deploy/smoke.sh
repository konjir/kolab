#!/usr/bin/env bash
# Checks that a deployed Kolab answers (W2.23): .github/workflows/deploy.yml runs it after each
# apply, and anyone can run it by hand. It needs no token and sends none.
#
#   deploy/smoke.sh https://kolab.konjir.com
#
# - /healthz answers 200 "ok", which needs Kolab, its database and Caddy. A fresh environment waits
#   for DNS and its first certificate, so it retries for up to SMOKE_WAIT seconds (default 600).
# - /mcp, asked to initialize with no token, answers 401 with a WWW-Authenticate header naming its
#   protected-resource metadata (RFC 9728): Kolab's MCP endpoint itself, not a page in front of it.
set -euo pipefail
fail() { echo "smoke: $*" >&2; exit 1; }
[ $# -eq 1 ] || fail "usage: smoke.sh <https://host>"
site=${1%/}
[[ "$site" =~ ^https://[a-z0-9.-]+$ ]] || fail "$site is not https://<host>"

deadline=$((SECONDS + ${SMOKE_WAIT:-600}))
while :; do
  body=$(curl -sS --max-time 10 "$site/healthz" 2>/dev/null) && [ "$body" = ok ] && break
  [ "$SECONDS" -lt "$deadline" ] || fail "$site/healthz didn't answer ok within ${SMOKE_WAIT:-600} s (last answer: ${body:-none})"
  sleep 10
done
echo "smoke: $site/healthz answers ok"

headers=$(curl -sS --max-time 10 -o /dev/null -D - -X POST "$site/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"konjir-smoke","version":"1"}}}') \
  || fail "$site/mcp didn't answer"
status=$(printf '%s\n' "$headers" | awk 'toupper($1) ~ /^HTTP\// { code = $2 } END { print code }')
[ "$status" = 401 ] || fail "$site/mcp answered $status to a request with no token, not 401"
printf '%s\n' "$headers" | grep -qiE '^www-authenticate:.*resource_metadata=' \
  || fail "$site/mcp's 401 names no protected-resource metadata (WWW-Authenticate)"
echo "smoke: $site/mcp asks for a token, as it should"
