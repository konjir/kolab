#!/usr/bin/env bash
# Checks that a published konjir reaches a Kolab (W2.6: "npx konjir and a downloaded binary both
# reach the test server"). CI runs it against a Kolab it starts from the checkout, never production.
#
#   KONJIR_URL=… KONJIR_ADMIN_TOKEN=… apps/cli/scripts/smoke.sh <actor id> <konjir command…>
#
# e.g. smoke.sh smoke-bin apps/cli/dist-bin/konjir-linux-arm64
#      smoke.sh smoke-npm npm exec --yes --package=/tmp/konjir-0.6.0.tgz -- konjir
#
# It adds a person with the given id (which must be new to that Kolab), opens a session for it,
# and checks that whoami names it. Tokens stay in variables; nothing prints them.
set -euo pipefail
actor="$1"; shift
: "${KONJIR_URL:?set KONJIR_URL}" "${KONJIR_ADMIN_TOKEN:?set KONJIR_ADMIN_TOKEN}"
json() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

"$@" --version
"$@" --help >/dev/null
KONJIR_TOKEN="$KONJIR_ADMIN_TOKEN" "$@" admin_add_actor id="$actor" >/dev/null
token=$(KONJIR_TOKEN="$KONJIR_ADMIN_TOKEN" "$@" admin_open_session actor="$actor" role=engineer | json token)
who=$(KONJIR_TOKEN="$token" "$@" whoami | json actor)
if [ "$who" != "$actor" ]; then
  echo "whoami named '$who', expected '$actor'" >&2
  exit 1
fi
echo "konjir reached $KONJIR_URL as $who"
