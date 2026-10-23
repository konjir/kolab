# Applies the CI roles offline, against a mocked AWS provider, and checks who may assume each and
# that every policy fits IAM's limit (W2.23). Nothing reaches AWS. Run from deploy/terraform/github-oidc:
#   terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "747533038441" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::747533038441:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::747533038441:policy/konjir/mock" }
  }
}

run "roles" {
  assert {
    condition     = jsondecode(aws_iam_role.ci["konjir-deploy-staging"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:konjir/kolab:ref:refs/heads/main"
    error_message = "only a job on main of konjir/kolab may deploy staging"
  }
  assert {
    condition     = jsondecode(aws_iam_role.ci["konjir-plan-production"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:konjir/kolab:ref:refs/heads/main"
    error_message = "only a job on main may plan production"
  }
  assert {
    condition     = jsondecode(aws_iam_role.ci["konjir-deploy-production"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:konjir/kolab:environment:production"
    error_message = "only a job in the production environment, which Lee approves, may deploy production"
  }
  assert {
    condition     = alltrue([for r in aws_iam_role.ci : jsondecode(r.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"])
    error_message = "every role is for AWS STS's audience only"
  }
  assert {
    condition     = length([for k, a in aws_iam_role_policy_attachment.ci : a if a.role == "konjir-plan-production"]) == 1
    error_message = "the production plan role reads, and writes nothing"
  }
  # A managed policy holds at most 6,144 characters, whitespace aside.
  assert {
    condition     = alltrue([for p in concat(values(aws_iam_policy.boundary), values(aws_iam_policy.read), values(aws_iam_policy.write), values(aws_iam_policy.roles)) : length(replace(p.policy, "/\\s/", "")) <= 6144])
    error_message = "a policy is over IAM's 6,144-character limit"
  }
  # deploy/terraform attaches the boundary by this ARN (environments.tf).
  assert {
    condition     = aws_iam_policy.boundary["staging"].name == "konjir-staging-boundary" && aws_iam_policy.boundary["staging"].path == "/konjir/"
    error_message = "deploy/terraform expects staging's boundary at policy/konjir/konjir-staging-boundary"
  }
  assert {
    condition     = aws_iam_policy.boundary["production"].name == "konjir-test-boundary"
    error_message = "deploy/terraform expects production's boundary at policy/konjir/konjir-test-boundary"
  }
}
