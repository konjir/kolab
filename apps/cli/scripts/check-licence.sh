#!/usr/bin/env bash
# Checks that a packed konjir carries its licence: konjir is Apache-2.0 (D63).
#
#   apps/cli/scripts/check-licence.sh <konjir-x.y.z.tgz> [<binaries dir>]
#
# The tarball must hold LICENSE, the Apache License 2.0 text that apps/cli/LICENSE is, and
# THIRD-PARTY-NOTICES.md, and its package.json must declare "license": "Apache-2.0". The binaries
# directory, if given, must hold the same LICENSE and a THIRD-PARTY-NOTICES.md beside them.
set -euo pipefail
tarball="$1"
bins="${2:-}"
licence="$(dirname "$0")/../LICENSE"
fail() { echo "::error::$*" >&2; exit 1; }

head -4 "$licence" | grep -q 'Version 2.0, January 2004' || fail "apps/cli/LICENSE isn't the Apache License"
files=$(tar -tzf "$tarball")
for f in package/LICENSE package/THIRD-PARTY-NOTICES.md package/package.json package/konjir.mjs; do
  grep -qx "$f" <<<"$files" || fail "$tarball has no $f"
done
tar -xOzf "$tarball" package/LICENSE | cmp -s - "$licence" || fail "$tarball's LICENSE isn't apps/cli/LICENSE"
declared=$(tar -xOzf "$tarball" package/package.json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).license))')
[ "$declared" = Apache-2.0 ] || fail "$tarball declares the licence '$declared', not Apache-2.0"

if [ -n "$bins" ]; then
  cmp -s "$bins/LICENSE" "$licence" || fail "$bins has no LICENSE, or not apps/cli/LICENSE"
  [ -s "$bins/THIRD-PARTY-NOTICES.md" ] || fail "$bins has no THIRD-PARTY-NOTICES.md"
fi
echo "$tarball${bins:+ and $bins} carry LICENSE (Apache-2.0) and THIRD-PARTY-NOTICES.md"
