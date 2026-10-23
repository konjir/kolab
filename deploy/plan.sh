#!/usr/bin/env bash
# Plans one environment and prints only what would change (W2.23): one line per resource, its
# actions and its address, never a value, since the deploy workflow's logs are public.
# .github/workflows/deploy.yml runs it in deploy/terraform after terraform init.
#
#   deploy/plan.sh [terraform plan options…]       e.g. deploy/plan.sh -lock=false
#
# Writes, in deploy/terraform:
#   tfplan               the saved plan, for terraform apply tfplan (it holds secrets: never upload it)
#   .build/plan.log      terraform plan's own output, values and all; printed only in part
#   .build/changes.txt   the change list, sorted: what Lee approves, and what the apply job re-plans to
set -euo pipefail
TF="$(cd "$(dirname "${BASH_SOURCE[0]}")/terraform" && pwd)"
cd "$TF"
mkdir -p .build
rm -f tfplan .build/changes.txt

if ! terraform plan -input=false -no-color -out=tfplan "$@" > .build/plan.log; then
  # Terraform writes its errors to stderr, which is already in the log; say where they came from.
  echo "::error::terraform plan failed (its errors are above)"
  exit 1
fi

# Warnings, such as a check that failed (kolab_is_live), with the lines that explain them.
grep -A4 -E '^Warning:' .build/plan.log || true
grep -E '^(Plan:|No changes\.|Changes to Outputs:)' .build/plan.log || true

terraform show -json tfplan | jq -r '
  .resource_changes[]
  | select(.change.actions != ["no-op"] and .change.actions != ["read"])
  | "\(.change.actions | join("+")) \(.address)"' | sort > .build/changes.txt

if [ -s .build/changes.txt ]; then
  echo "Changes (actions, address):"
  sed 's/^/  /' .build/changes.txt
else
  echo "No resource changes."
fi
