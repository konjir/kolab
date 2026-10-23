# Applies the deploy role offline, against a mocked AWS provider, and checks who may assume it and
# that every policy fits IAM's limit (W2.23). Nothing reaches AWS. Run from
# deploy/terraform/github-oidc:
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

run "role" {
  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:konjir/kolab:environment:production:job_workflow_ref:konjir/kolab/.github/workflows/deploy.yml@refs/heads/main"
    error_message = "only deploy.yml on main, in the production environment Lee approves, may assume the role"
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "the role is for AWS STS's audience only"
  }
  assert {
    condition     = length(jsondecode(aws_iam_role.deploy.assume_role_policy).Statement) == 1
    error_message = "the role has one way in"
  }
  # A managed policy holds at most 6,144 characters, whitespace aside.
  assert {
    condition     = alltrue([for p in [aws_iam_policy.instance_boundary, aws_iam_policy.dlm_boundary, aws_iam_policy.read, aws_iam_policy.write, aws_iam_policy.roles] : length(replace(p.policy, "/\\s/", "")) <= 6144])
    error_message = "a policy is over IAM's 6,144-character limit"
  }
  # deploy/terraform attaches the boundaries by these names (main.tf, boundary_prefix).
  assert {
    condition     = aws_iam_policy.instance_boundary.name == "konjir-test-instance-boundary" && aws_iam_policy.dlm_boundary.name == "konjir-test-dlm-boundary" && aws_iam_policy.instance_boundary.path == "/konjir/"
    error_message = "deploy/terraform expects the boundaries at policy/konjir/konjir-test-{instance,dlm}-boundary"
  }
  # No account-wide EC2 setting, and no EC2 wildcard.
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_policy.write.policy).Statement : anytrue([for a in flatten([s.Action]) : a == "ec2:*" || startswith(a, "ec2:Enable") || startswith(a, "ec2:Disable") || startswith(a, "ec2:ModifyEbsDefault") || a == "ec2:CreateReplaceRootVolumeTask" || a == "ec2:ModifySnapshotAttribute"]) if s.Effect == "Allow"])
    error_message = "the deploy role must not get ec2:*, account-wide EC2 settings, root-volume replacement or snapshot sharing"
  }
  # A trust is never changed after the role is made.
  assert {
    condition     = !strcontains(aws_iam_policy.roles.policy, "UpdateAssumeRolePolicy")
    error_message = "the deploy role must not change a role's trust"
  }
}
