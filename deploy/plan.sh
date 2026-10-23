#!/usr/bin/env bash
# Plans production and says what would change without printing a value (W2.23), since the deploy
# workflow's logs are public. .github/workflows/deploy.yml runs it in deploy/terraform after
# terraform init; it works the same locally.
#
#   deploy/plan.sh [terraform plan options…]
#
# Writes, in deploy/terraform:
#   tfplan                  the saved plan, for terraform apply tfplan (it holds secrets: never upload it)
#   .build/plan.log         terraform plan's own output, values and all; printed only in part
#   .build/changes.txt      one line per changed resource: its actions, its address, and the names
#                           of the attributes that change. Printed, and put in the run's summary.
#   .build/plan-digest      the sha256 of every change in full, before and after, with each sensitive
#                           value replaced by "(sensitive)": what the apply job checks it is applying
#   .build/replacements.txt the instance, data volume or database the plan would replace, if any
set -euo pipefail
TF="$(cd "$(dirname "${BASH_SOURCE[0]}")/terraform" && pwd)"
cd "$TF"
mkdir -p .build
rm -f tfplan .build/changes.txt .build/plan-digest .build/replacements.txt

if ! terraform plan -input=false -no-color -out=tfplan "$@" > .build/plan.log; then
  # Terraform writes its errors to stderr, which is already above.
  echo "::error::terraform plan failed (its errors are above)"
  exit 1
fi

# Warnings, such as a check that failed (kolab_is_live), with the lines that explain them.
grep -A4 -E '^Warning:' .build/plan.log || true
grep -E '^(Plan:|No changes\.)' .build/plan.log || true

terraform show -json tfplan > .build/plan.json

# Each change, reduced to what changes: for an update, the attributes whose value differs (or is
# unknown until apply); for a create, every attribute; for a delete, nothing more. Values Terraform
# marks sensitive become "(sensitive)". Attributes that merely refresh (a database's latest
# restorable time, say) are equal before and after within one plan, so they don't count.
jq -S '
  def redact($s):
    if $s == true then "(sensitive)"
    elif ($s | type) == "object" and type == "object" then with_entries(.key as $k | .value |= redact($s[$k] // false))
    elif ($s | type) == "array" and type == "array" then [to_entries[] | .key as $i | .value | redact($s[$i] // false)]
    else . end;
  [ .resource_changes[]
    | select(.change.actions != ["no-op"] and .change.actions != ["read"])
    | .change as $c
    | ($c.before // {}) as $b
    | ($c.after // {}) as $a
    | ($c.after_unknown // {}) as $u
    | { address, actions: $c.actions,
        # Compared before redacting, so a sensitive value that changes still counts, as "(sensitive)".
        changed: ((if ($a | type) == "object" then ($a | with_entries(select(.value != $b[.key]))) else $a end)
                  | redact($c.after_sensitive // false)),
        unknown: (if ($u | type) == "object" then [$u | to_entries[] | select(.value != false) | .key] else [] end) } ]
' .build/plan.json > .build/changes.json
rm -f .build/plan.json

sha256sum < .build/changes.json | cut -d' ' -f1 > .build/plan-digest
jq -r '.[] | "\(.actions | join("+")) \(.address)\(([.changed | keys[]] + .unknown | unique) as $k | if ($k | length) > 0 and .actions == ["update"] then ": " + ($k | join(", ")) else "" end)"' \
  .build/changes.json | sort > .build/changes.txt
jq -r '.[] | select((.actions | index("delete")) and (.actions | index("create")))
  | .address | select(test("aws_instance\\.|aws_db_instance\\.|aws_ebs_volume\\."))' .build/changes.json > .build/replacements.txt

if [ -s .build/changes.txt ]; then
  echo "Changes (actions, address, and for an update the attributes that change):"
  sed 's/^/  /' .build/changes.txt
else
  echo "No resource changes."
fi
echo "Plan digest: $(cat .build/plan-digest)"
