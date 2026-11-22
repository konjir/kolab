#!/bin/bash
# Packs a release: the tracked files of one commit, never anything else (D55 review). Terraform's
# release module runs it as an external data source, at plan time:
#   pack.sh <checkout> <zip to write>
# and reads back {"path": <the zip>, "release": <the commit's tree id>}.
#
# - Only what git tracks ships, from `git archive` of HEAD: no untracked or ignored file can be in
#   it, such as .env, a .claude/ worktree, a nested .konjir data directory or a *.tfvars file.
# - A tracked change not yet committed is refused, so every deploy is exactly a commit; only
#   Terraform's provider lock may differ: `terraform init` rewrites it, and it never ships changed.
# - A tracked file that must never ship (.env, .claude/, .playwright-mcp/, .konjir/, *.tfvars,
#   Terraform state) is refused, should one ever be committed.
# - The release id is the commit's tree id, so it changes only when tracked content does: two
#   commits with the same tree are one release.
# - site/, konjir.com's files (D81), is no part of Kolab, and nor is konnect's phone app,
#   apps/konnect-mobile, which EAS builds: .gitattributes marks both export-ignore, so neither is in
#   the zip, and the release id is the tree id without them and the app's own workflows
#   (.github/workflows/mobile*.yml), so a change to the site or the app alone is the same release
#   and doesn't reinstall Kolab. Without any of them the id is the tree id. A change to the app's
#   dependencies changes package-lock.json, which the release installs from, and so is a release.
set -euo pipefail
fail() { echo "pack.sh: $*" >&2; exit 1; }
[ $# -eq 2 ] || fail "usage: pack.sh <checkout> <zip>"
src=$1; out=$2
cat >/dev/null || true   # the external data source's query, which carries nothing more
cd "$src" 2>/dev/null || fail "no directory $src"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$src is not a git checkout: a release is a commit"
top=$(git rev-parse --show-toplevel)
[ "$(pwd -P)" = "$(cd "$top" && pwd -P)" ] || fail "$src is not the top of its checkout ($top)"
# Terraform's provider lock is left out: `terraform init` may rewrite it (it adds a provider the
# state still names, such as hashicorp/archive from releases before pack.sh), the zip is
# `git archive HEAD` whatever the working tree holds, and Kolab never reads it, so a release
# still equals a commit.
dirty=$(git status --porcelain --untracked-files=no -- . ':(exclude)deploy/terraform/.terraform.lock.hcl')
[ -z "$dirty" ] || fail "tracked changes aren't committed, and a release is exactly a commit: commit or stash them first:
$dirty"
forbidden=$(git ls-tree -r --name-only HEAD | grep -E '(^|/)(\.env(\.[^/]*)?|\.claude|\.playwright-mcp|\.konjir|\.konjir-demo)(/|$)|\.tfvars(\.json)?$|(^|/)terraform\.tfstate(\.backup)?$' || true)
[ -z "$forbidden" ] || fail "these tracked files must never ship; remove them from git:
$forbidden"
# The commit's tree without site/, the app and its workflows, through an index of its own: with
# none of them, HEAD^{tree} itself.
index=$(mktemp "${TMPDIR:-/tmp}/konjir-pack-index.XXXXXX")
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE=$index git read-tree HEAD
GIT_INDEX_FILE=$index git rm -r -q -f --cached --ignore-unmatch -- site apps/konnect-mobile ':(glob).github/workflows/mobile*.yml' >/dev/null
tree=$(GIT_INDEX_FILE=$index git write-tree)
mkdir -p "$(dirname "$out")"
git archive --format=zip -o "$out.tmp" HEAD
mv -f "$out.tmp" "$out"
printf '{"path":"%s","release":"%s"}\n' "$out" "$tree"
