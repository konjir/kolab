#!/usr/bin/env bash
# Checks that a packed konnect carries its licence, and only Apache-2.0 code of this repository:
# konnect is Apache-2.0, as konjir is (D63), and the rest of the repository is FSL-1.1-ALv2 (D64).
#
#   apps/konnect/scripts/check-licence.sh <konjir-konnect-x.y.z.tgz>
#
# The tarball must hold LICENSE, the Apache License 2.0 text that apps/konnect/LICENSE and
# apps/cli/LICENSE are, THIRD-PARTY-NOTICES.md and konnect.mjs, and its package.json must declare
# "license": "Apache-2.0". The only first-party sources konnect may bundle are apps/konnect's,
# libs/login's, libs/brand's and apps/channel-bridge's; scripts/package.mjs fails the build on any other. Here, each must
# still declare Apache-2.0 and carry the licence, and the notices (every package the bundle inlines)
# must name no @konjir/* package and no FSL licence.
set -euo pipefail
tarball="$1"
repo="$(dirname "$0")/../../.."
licence="$repo/apps/konnect/LICENSE"
fail() { echo "::error::$*" >&2; exit 1; }
declared() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).license))'; }

head -4 "$licence" | grep -q 'Version 2.0, January 2004' || fail "apps/konnect/LICENSE isn't the Apache License"
for pkg in apps/cli libs/login libs/brand apps/channel-bridge; do
  cmp -s "$repo/$pkg/LICENSE" "$licence" || fail "$pkg has no LICENSE, or not apps/konnect/LICENSE"
done
for pkg in apps/konnect libs/login libs/brand apps/channel-bridge; do
  [ "$(declared <"$repo/$pkg/package.json")" = Apache-2.0 ] || fail "$pkg/package.json doesn't declare Apache-2.0"
done
files=$(tar -tzf "$tarball")
for f in package/LICENSE package/THIRD-PARTY-NOTICES.md package/package.json package/konnect.mjs; do
  grep -qx "$f" <<<"$files" || fail "$tarball has no $f"
done
tar -xOzf "$tarball" package/LICENSE | cmp -s - "$licence" || fail "$tarball's LICENSE isn't apps/konnect/LICENSE"
declared=$(tar -xOzf "$tarball" package/package.json | declared)
[ "$declared" = Apache-2.0 ] || fail "$tarball declares the licence '$declared', not Apache-2.0"
notices=$(tar -xOzf "$tarball" package/THIRD-PARTY-NOTICES.md)
if grep -qE '^## @konjir/' <<<"$notices"; then fail "$tarball bundles a @konjir/* workspace package"; fi
if grep -qiE 'FSL-|Functional Source License' <<<"$notices"; then fail "$tarball bundles FSL-licensed code"; fi
echo "$tarball carries LICENSE (Apache-2.0) and THIRD-PARTY-NOTICES.md, and bundles no FSL code"
