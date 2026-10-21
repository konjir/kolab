#!/usr/bin/env bash
# Checks that a packed konjir carries its licence, and only Apache-2.0 code of this repository:
# konjir is Apache-2.0 (D63), and the rest of the repository is FSL-1.1-ALv2 (D64).
#
#   apps/cli/scripts/check-licence.sh <konjir-x.y.z.tgz> [<binaries dir>]
#
# The tarball must hold LICENSE, the Apache License 2.0 text that apps/cli/LICENSE is, and
# THIRD-PARTY-NOTICES.md, and its package.json must declare "license": "Apache-2.0". The binaries
# directory, if given, must hold the same LICENSE and a THIRD-PARTY-NOTICES.md beside them.
#
# The only first-party sources konjir may bundle are apps/cli's and libs/login's, the two
# Apache-2.0 packages; package.mjs fails the build on any other. Here, both must still declare
# Apache-2.0, libs/login must carry the same LICENSE, and the notices (every package the bundle
# inlines) must name no @konjir/* package and no FSL licence.
set -euo pipefail
tarball="$1"
bins="${2:-}"
repo="$(dirname "$0")/../../.."
licence="$repo/apps/cli/LICENSE"
fail() { echo "::error::$*" >&2; exit 1; }
declared() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).license))'; }
# Notices that list a workspace package, or any FSL-licensed one, mean FSL code was bundled.
check_notices() {
  if grep -qE '^## @konjir/' <<<"$1"; then fail "$2 bundles a @konjir/* workspace package"; fi
  if grep -qiE 'FSL-|Functional Source License' <<<"$1"; then fail "$2 bundles FSL-licensed code"; fi
}

head -4 "$licence" | grep -q 'Version 2.0, January 2004' || fail "apps/cli/LICENSE isn't the Apache License"
cmp -s "$repo/libs/login/LICENSE" "$licence" || fail "libs/login has no LICENSE, or not apps/cli/LICENSE"
for pkg in apps/cli libs/login; do
  [ "$(declared <"$repo/$pkg/package.json")" = Apache-2.0 ] || fail "$pkg/package.json doesn't declare Apache-2.0"
done
files=$(tar -tzf "$tarball")
for f in package/LICENSE package/THIRD-PARTY-NOTICES.md package/package.json package/konjir.mjs; do
  grep -qx "$f" <<<"$files" || fail "$tarball has no $f"
done
tar -xOzf "$tarball" package/LICENSE | cmp -s - "$licence" || fail "$tarball's LICENSE isn't apps/cli/LICENSE"
declared=$(tar -xOzf "$tarball" package/package.json | declared)
[ "$declared" = Apache-2.0 ] || fail "$tarball declares the licence '$declared', not Apache-2.0"
check_notices "$(tar -xOzf "$tarball" package/THIRD-PARTY-NOTICES.md)" "$tarball"

if [ -n "$bins" ]; then
  cmp -s "$bins/LICENSE" "$licence" || fail "$bins has no LICENSE, or not apps/cli/LICENSE"
  [ -s "$bins/THIRD-PARTY-NOTICES.md" ] || fail "$bins has no THIRD-PARTY-NOTICES.md"
  check_notices "$(cat "$bins/THIRD-PARTY-NOTICES.md")" "$bins"
fi
echo "$tarball${bins:+ and $bins} carry LICENSE (Apache-2.0) and THIRD-PARTY-NOTICES.md, and bundle no FSL code"
