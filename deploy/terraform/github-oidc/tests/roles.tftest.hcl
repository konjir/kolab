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
  mock_data "aws_kms_alias" {
    defaults = { target_key_arn = "arn:aws:kms:us-east-1:747533038441:key/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::747533038441:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::747533038441:policy/konjir/mock" }
  }
  mock_resource "aws_ssm_document" {
    defaults = { arn = "arn:aws:ssm:us-east-1:747533038441:document/konjir-test-install-release" }
  }
}

variables {
  trust = "token.actions.githubusercontent.com"
}

run "role" {
  # The subject GitHub gives a job in the production environment of konjir/kolab, which has immutable
  # subjects and no custom template: the owner's and repository's ids, then the environment.
  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["${var.trust}:sub"] == "repo:konjir@340888484/kolab@1414997919:environment:production"
    error_message = "the role trusts the production environment's immutable subject, repo:konjir@340888484/kolab@1414997919:environment:production"
  }
  assert {
    condition = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals == {
      "${var.trust}:aud"                 = "sts.amazonaws.com"
      "${var.trust}:sub"                 = "repo:konjir@340888484/kolab@1414997919:environment:production"
      "${var.trust}:repository_id"       = "1414997919"
      "${var.trust}:repository_owner_id" = "340888484"
      "${var.trust}:job_workflow_ref"    = "konjir/kolab/.github/workflows/deploy.yml@refs/heads/main"
      "${var.trust}:ref"                 = "refs/heads/main"
    }
    error_message = "only deploy.yml on main, in the production environment Lee approves, of this repository by id, may assume the role, for STS"
  }
  assert {
    condition     = length(jsondecode(aws_iam_role.deploy.assume_role_policy).Statement) == 1
    error_message = "the role has one way in"
  }
  # A managed policy holds at most 6,144 characters, whitespace aside.
  assert {
    condition     = alltrue([for p in [aws_iam_policy.instance_boundary, aws_iam_policy.dlm_boundary, aws_iam_policy.read, aws_iam_policy.ec2, aws_iam_policy.write, aws_iam_policy.site, aws_iam_policy.roles] : length(replace(p.policy, "/\\s/", "")) <= 6144])
    error_message = "a policy is over IAM's 6,144-character limit"
  }
  # deploy/terraform attaches the boundaries by these names (main.tf, boundary_prefix).
  assert {
    condition     = aws_iam_policy.instance_boundary.name == "konjir-test-instance-boundary" && aws_iam_policy.dlm_boundary.name == "konjir-test-dlm-boundary" && aws_iam_policy.instance_boundary.path == "/konjir/"
    error_message = "deploy/terraform expects the boundaries at policy/konjir/konjir-test-{instance,dlm}-boundary"
  }
  # No account-wide EC2 setting, no EC2 wildcard, and nothing the review found unneeded.
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_policy.ec2.policy).Statement : anytrue([for a in flatten([s.Action]) : a == "ec2:*" || startswith(a, "ec2:Enable") || startswith(a, "ec2:Disable") || startswith(a, "ec2:ModifyEbsDefault") || contains(["ec2:CreateReplaceRootVolumeTask", "ec2:ModifySnapshotAttribute", "ec2:CopySnapshot", "ec2:MonitorInstances", "ec2:UnmonitorInstances"], a)]) if s.Effect == "Allow"])
    error_message = "the deploy role must not get ec2:*, account-wide EC2 settings, root-volume replacement, snapshot copying or sharing, or detailed monitoring"
  }
  # Every EC2 allow is tied to production's Stack tag, on what exists or what is created, except
  # the network interfaces and rules a launch or a rule makes, and Amazon's images.
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_policy.ec2.policy).Statement :
      try(s.Condition.StringEquals["aws:ResourceTag/Stack"], s.Condition.StringEquals["aws:RequestTag/Stack"], s.Condition.StringEquals["ec2:Owner"], "") != "" || s.Sid == "LaunchParts" || s.Sid == "SnapshotOfOwnVolume" || try(length(s.Condition.StringEquals["ec2:CreateAction"]) > 0, false)
    if s.Effect == "Allow"])
    error_message = "an EC2 allow isn't tied to production's tag"
  }
  # CreateTags without a create call, or DeleteTags, never touches the Stack tag.
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.ec2.policy).Statement : s.Condition if s.Sid == "NeverMoveStack" && s.Effect == "Deny"]) == { "ForAnyValue:StringEquals" = { "aws:TagKeys" = ["Stack"] }, Null = { "ec2:CreateAction" = "true" } }
    error_message = "the Stack tag must not be added to or removed from a resource that exists"
  }
  # The snapshot role tags snapshots only as it makes them, or ones already production's.
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.dlm_boundary.policy).Statement : can(s.Condition) if s.Effect == "Allow" && contains(flatten([s.Action]), "ec2:CreateTags")])
    error_message = "the snapshot boundary must not allow CreateTags without a condition"
  }
  # The install runs only the fixed document, never AWS-RunShellScript.
  assert {
    condition     = !strcontains(aws_iam_policy.write.policy, "AWS-RunShellScript") && strcontains(jsonencode(one([for s in jsondecode(aws_iam_policy.write.policy).Statement : s.Resource if s.Sid == "InstallAssociation"])), "document/konjir-test-install-release")
    error_message = "the role may associate only the install document"
  }
  assert {
    condition     = jsondecode(aws_ssm_document.install.content).parameters.release.allowedPattern == "^[0-9a-f]{40}([0-9a-f]{24})?$"
    error_message = "the install document's one parameter is a release id, hex only"
  }
  # CloudFront and ACM: other projects' by ARN, and a backstop on anything not tagged as production's.
  assert {
    condition     = contains(one([for s in jsondecode(aws_iam_policy.site.policy).Statement : s.Resource if s.Sid == "NotOtherProjects" && s.Effect == "Deny"]), "arn:aws:cloudfront::747533038441:distribution/E3LXY6CF24V3AR")
    error_message = "onivoro's distribution must be denied outright"
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.site.policy).Statement : s.Condition if s.Sid == "NotUntagged" && s.Effect == "Deny"]) == { StringNotEquals = { "aws:ResourceTag/Stack" = "konjir-test" } }
    error_message = "no CloudFront or ACM change to what isn't tagged as production's"
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.site.policy).Statement : s.Resource != "*" || can(s.Condition) || s.Sid == "OriginAccessAndHeaders" if s.Effect == "Allow"])
    error_message = "a CloudFront or ACM allow on every resource needs a tag condition"
  }
  # DNS: the konjir.com zone, and only the record types production uses.
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.write.policy).Statement : s if s.Sid == "OwnDnsRecords"]).Resource == "arn:aws:route53:::hostedzone/Z0507288XMQWHJUJUA0O" && one([for s in jsondecode(aws_iam_policy.write.policy).Statement : s if s.Sid == "OwnDnsRecords"]).Condition["ForAllValues:StringEquals"]["route53:ChangeResourceRecordSetsRecordTypes"] == ["A", "AAAA", "CNAME", "TXT"]
    error_message = "DNS changes are limited to the konjir.com zone, as A, AAAA, CNAME or TXT"
  }
  # A trust is never set or changed from CI, and no role made or deleted.
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_policy.roles.policy).Statement : anytrue([for a in flatten([s.Action]) : contains(["iam:CreateRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy"], a)]) if s.Effect == "Allow"])
    error_message = "the deploy role must not create or delete a role, or change a trust"
  }
}
