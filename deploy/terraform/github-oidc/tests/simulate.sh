#!/usr/bin/env bash
# Asks IAM's policy simulator whether the deploy role is refused production's break-glass admin
# token, /konjir/konjir-test/admin-token, and still may use another production parameter (W2.23a).
# roles.tftest.hcl checks the deny's text offline; this checks what IAM makes of it.
#
#   AWS_PROFILE=icedlee337 deploy/terraform/github-oidc/tests/simulate.sh             # before an apply
#   AWS_PROFILE=icedlee337 deploy/terraform/github-oidc/tests/simulate.sh --deployed  # after one
#
# Without --deployed it simulates the policies this checkout renders: it plans github-oidc on its
# own state (-lock=false), reads the planned policies of the deploy role and runs
# simulate-custom-policy on them. With --deployed it runs simulate-principal-policy on the role as
# AWS has it. Read-only either way: no apply, no lock, no change to any policy or parameter. Lee's
# credentials, since the deploy role can read neither github-oidc's state nor IAM's simulator.
# Its working data is in deploy/terraform/.build/github-oidc-simulate, which git ignores.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
build="$here/../.build/github-oidc-simulate"
deployed=false
case "${1:-}" in
  "") ;;
  --deployed) deployed=true ;;
  *) echo "usage: simulate.sh [--deployed]" >&2; exit 2 ;;
esac

region=us-east-1
account="$(aws sts get-caller-identity --query Account --output text)"
parameter="arn:aws:ssm:$region:$account:parameter/konjir/konjir-test"
token="$parameter/admin-token"
other="$parameter/database-url"
key="$(aws kms describe-key --region "$region" --key-id alias/aws/ssm --query KeyMetadata.Arn --output text)"

if $deployed; then
  simulate() { aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$account:role/konjir/konjir-deploy-production" "$@"; }
else
  mkdir -p "$build"
  trap 'rm -f "$build/plan"' EXIT
  export TF_DATA_DIR="$build/terraform"
  terraform -chdir="$here" init -input=false >"$build/init.log"
  terraform -chdir="$here" plan -lock=false -input=false -out="$build/plan" >"$build/plan.log"
  # The policies attached to the role, as the plan leaves them (boundaries aside: they bound the
  # other two roles, not this one).
  terraform -chdir="$here" show -json "$build/plan" | jq -c '
    [.planned_values.root_module.resources[] | select(.type == "aws_iam_policy" and (.name | IN("read", "ec2", "write", "site", "roles", "not_admin_token"))) | .values.policy]
    | if length == 6 and all(type == "string") then . else error("expected the role'"'"'s 6 policies, known at plan time") end' >"$build/policies.json"
  policies=()
  while IFS= read -r p; do policies+=("$p"); done < <(jq -r '.[]' "$build/policies.json")
  simulate() { aws iam simulate-custom-policy --policy-input-list "${policies[@]}" "$@"; }
fi

failed=0
# expect <decision> <action> <resource> [<encryption context's PARAMETER_ARN>]; decision denied takes either deny
expect() {
  local want="$1" action="$2" resource="$3" context=()
  if [ -n "${4:-}" ]; then
    context=(--context-entries "$(jq -nc --arg via "ssm.$region.amazonaws.com" --arg arn "$4" '[
      {ContextKeyName: "kms:ViaService", ContextKeyValues: [$via], ContextKeyType: "string"},
      {ContextKeyName: "kms:EncryptionContext:PARAMETER_ARN", ContextKeyValues: [$arn], ContextKeyType: "string"}]')")
  fi
  local got
  got="$(simulate --action-names "$action" --resource-arns "$resource" ${context[@]+"${context[@]}"} --query 'EvaluationResults[0].EvalDecision' --output text)"
  if [ "$got" = "$want" ] || { [ "$want" = denied ] && { [ "$got" = implicitDeny ] || [ "$got" = explicitDeny ]; }; }; then
    echo "ok    $action ${4:-$resource}: $got"
  else
    echo "FAIL  $action ${4:-$resource}: $got, wanted $want"
    failed=1
  fi
}

for action in GetParameter GetParameters GetParameterHistory PutParameter DeleteParameter DeleteParameters \
  LabelParameterVersion UnlabelParameterVersion AddTagsToResource RemoveTagsFromResource; do
  expect explicitDeny "ssm:$action" "$token"
done
expect explicitDeny ssm:GetParametersByPath "$parameter"
expect explicitDeny kms:Decrypt "$key" "$token"
expect explicitDeny kms:Encrypt "$key" "$token"

# Production's other parameters stay the role's: the plan reads them and the apply writes them.
for action in GetParameter GetParameters PutParameter DeleteParameter AddTagsToResource; do
  expect allowed "ssm:$action" "$other"
done
expect allowed kms:Decrypt "$key" "$other"
expect allowed kms:Encrypt "$key" "$other"

# The role can't undo the deny: not on itself (detach it, put or attach another policy, change its
# boundary) nor on the deny policy (delete it, re-version it, make an older version the default).
role="arn:aws:iam::$account:role/konjir/konjir-deploy-production"
deny="arn:aws:iam::$account:policy/konjir/konjir-deploy-production-not-admin-token"
for action in DetachRolePolicy AttachRolePolicy PutRolePolicy DeleteRolePolicy PutRolePermissionsBoundary \
  DeleteRolePermissionsBoundary UpdateAssumeRolePolicy TagRole; do
  expect denied "iam:$action" "$role"
done
for action in DeletePolicy CreatePolicy CreatePolicyVersion SetDefaultPolicyVersion DeletePolicyVersion TagPolicy; do
  expect denied "iam:$action" "$deny"
done

exit "$failed"
