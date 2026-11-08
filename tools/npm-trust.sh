#!/usr/bin/env bash
# Makes konjir on npm trust .github/workflows/release-cli.yml in konjir/kolab, run in the npm-release
# environment, so GitHub Actions can publish it with provenance and no npm token (W7.16). The environment's
# deployment branches are main only, so only a run from main can publish.
# Then sets konjir to require two-factor authentication and disallow tokens (mfa=publish), so a leaked npm
# token can't publish it; trusted publishing still works.
# Lee runs it once after `npm login` (npm run release:trust); if konjir already trusts the workflow, that is
# skipped. Then it lists who can publish konjir, and your npm tokens, for you to review.
#
# A new trust expires unless a publish uses it within about 48 hours, and `npm trust list` doesn't show that
# it expired (konjir's settings page on npmjs.com does). The release's publish job then fails with "OIDC token
# exchange error - package not found". --renew replaces konjir's trust of the workflow with a new one; release
# right after.
#
#   npm run release:trust                    # trust the workflow, set mfa=publish, list for review
#   npm run release:trust -- --dry-run       # say what it would do, change nothing
#   npm run release:trust -- --renew         # replace expired trust
#
# Every npm call needs a one-time password. The script asks for one from your authenticator app and reuses it
# until npm rejects it, then asks for the next, so a run takes a code about every 30 seconds rather than one
# per call. Other arguments starting with - go to npm.
set -euo pipefail

PACKAGE=konjir
REPO=konjir/kolab
WORKFLOW=release-cli.yml
ENVIRONMENT=npm-release

cd "$(dirname "$0")/.."
[ -t 0 ] && [ -t 1 ] || { echo 'ERROR: run this in an interactive terminal, so it can ask for one-time passwords' >&2; exit 1; }
npm whoami > /dev/null || { echo 'ERROR: not logged in to npm. Run npm login first' >&2; exit 1; }

log=$(mktemp)
errors=$(mktemp)
trap 'rm -f "$log" "$errors"' EXIT

otp=''
ask_otp() {
  read -r -p 'One-time password: ' otp < /dev/tty
}

# Runs npm with the current one-time password, asking for a new one while npm rejects it.
# Without a terminal on stdin npm fails instead of prompting, so the script owns every prompt.
npm_otp() {
  local attempt
  for attempt in 1 2 3; do
    if npm "$@" --otp="$otp" < /dev/null 2> "$errors"; then
      return 0
    fi
    if ! grep -qiE 'EOTP|one-time pass' "$errors"; then
      break
    fi
    ask_otp
  done
  cat "$errors" >&2
  return 1
}

# Prints the id of each entry in a recorded `npm trust list` that trusts $WORKFLOW
trust_ids() {
  tr -d '\r' < "$1" | awk -v file="$WORKFLOW" -v RS= '$0 ~ "file: " file "(\n|$)" { match($0, /id: [^\n]+/); print substr($0, RSTART + 4, RLENGTH - 4) }'
}

dry_run=false
renew=false
flags=()
for arg in "$@"; do
  case $arg in
    --renew) renew=true ;;
    --dry-run) dry_run=true; flags+=("$arg") ;;
    -*) flags+=("$arg") ;;
    *) echo "ERROR: $PACKAGE is the only package; unexpected argument: $arg" >&2; exit 1 ;;
  esac
done

ask_otp
# Reading trust needs two-factor authentication too, so a failure here must stop rather than count as untrusted
npm_otp trust list "$PACKAGE" > "$log" || { echo "ERROR: couldn't read the trust settings of $PACKAGE" >&2; exit 1; }
if $renew; then
  for id in $(trust_ids "$log"); do
    if $dry_run; then
      echo "would revoke: $PACKAGE trust $id"
    else
      echo "revoke: $PACKAGE trust $id"
      npm_otp trust revoke "$PACKAGE" --id="$id" ${flags[@]+"${flags[@]}"}
    fi
  done
  : > "$log"
fi
if [ -n "$(trust_ids "$log")" ]; then
  echo "skip: $PACKAGE already trusts $WORKFLOW"
else
  echo "trust: $PACKAGE trusts $REPO's $WORKFLOW in the $ENVIRONMENT environment"
  npm_otp trust github "$PACKAGE" --repository "$REPO" --file "$WORKFLOW" --environment "$ENVIRONMENT" --allow-publish --yes ${flags[@]+"${flags[@]}"}
fi
if $dry_run; then
  echo "would set: $PACKAGE mfa=publish"
else
  echo "set: $PACKAGE mfa=publish (require two-factor authentication and disallow tokens)"
  npm_otp access set mfa=publish "$PACKAGE" ${flags[@]+"${flags[@]}"}
fi

echo
echo "Review who can publish or change $PACKAGE and its trust settings:"
npm_otp access list collaborators "$PACKAGE" || true
echo
echo 'Your npm tokens (revoke any you no longer need with npm token revoke <id>):'
npm_otp token list || true
