#!/bin/bash
# Packs a release: the tracked files of one commit, never anything else (D55 review). Terraform's
# release module runs it as an external data source, at plan time:
#   pack.sh <checkout> <zip to write>
# and reads back {"path": <the zip>, "release": <the commit's tree id>}.
#
# - Only what git tracks ships, from `git archive` of HEAD: no untracked or ignored file can be in
#   it, such as .env, a .claude/ worktree, a nested .konjir data directory or a *.tfvars file.
# - A tracked change not yet committed is refused, so every deploy is exactly a commit.
# - A tracked file that must never ship (.env, .claude/, .playwright-mcp/, .konjir/, *.tfvars,
#   Terraform state) is refused, should one ever be committed.
# - The release id is the commit's tree id, so it changes only when tracked content does: two
#   commits with the same tree are one release.
set -euo pipefail
fail() { echo "pack.sh: $*" >&2; exit 1; }
[ $# -eq 2 ] || fail "usage: pack.sh <checkout> <zip>"
src=$1; out=$2
cat >/dev/null || true   # the external data source's query, which carries nothing more
cd "$src" 2>/dev/null || fail "no directory $src"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$src is not a git checkout: a release is a commit"
top=$(git rev-parse --show-toplevel)
[ "$(pwd -P)" = "$(cd "$top" && pwd -P)" ] || fail "$src is not the top of its checkout ($top)"
dirty=$(git status --porcelain --untracked-files=no)
[ -z "$dirty" ] || fail "tracked changes aren't committed, and a release is exactly a commit: commit or stash them first:
$dirty"
forbidden=$(git ls-tree -r --name-only HEAD | grep -E '(^|/)(\.env(\.[^/]*)?|\.claude|\.playwright-mcp|\.konjir|\.konjir-demo)(/|$)|\.tfvars(\.json)?$|(^|/)terraform\.tfstate(\.backup)?$' || true)
[ -z "$forbidden" ] || fail "these tracked files must never ship; remove them from git:
$forbidden"
tree=$(git rev-parse 'HEAD^{tree}')
mkdir -p "$(dirname "$out")"
git archive --format=zip -o "$out.tmp" HEAD
mv -f "$out.tmp" "$out"
printf '{"path":"%s","release":"%s"}\n' "$out" "$tree"
