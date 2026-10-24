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
  mock_data "aws_vpc" {
    defaults = { arn = "arn:aws:ec2:us-east-1:747533038441:vpc/vpc-0ce63124e64459538" }
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
    condition     = alltrue([for p in [aws_iam_policy.instance_boundary, aws_iam_policy.dlm_boundary, aws_iam_policy.read, aws_iam_policy.ec2, aws_iam_policy.write, aws_iam_policy.site, aws_iam_policy.roles, aws_iam_policy.not_admin_token] : length(replace(p.policy, "/\\s/", "")) <= 6144])
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
      try(s.Condition.StringEquals["aws:ResourceTag/Stack"], s.Condition.StringEquals["aws:RequestTag/Stack"], s.Condition.StringEquals["ec2:Owner"], s.Condition.StringEquals["ec2:Vpc"], "") != "" || s.Sid == "LaunchParts" || s.Sid == "SnapshotOfOwnVolume" || try(length(s.Condition.StringEquals["ec2:CreateAction"]) > 0, false)
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
    condition     = !strcontains(aws_iam_policy.write.policy, "AWS-RunShellScript") && strcontains(jsonencode(one([for s in jsondecode(aws_iam_policy.write.policy).Statement : s.Resource if s.Sid == "InstallDocument"])), "document/konjir-test-install-release")
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
  # Associations are changed or deleted only while tagged as production's.
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.write.policy).Statement : s.Condition if s.Sid == "OwnAssociation"]) == { StringEquals = { "aws:ResourceTag/Stack" = "konjir-test" } } && !anytrue([for s in jsondecode(aws_iam_policy.write.policy).Statement : contains(flatten([s.Action]), "ssm:DeleteAssociation") && !can(s.Condition) if s.Effect == "Allow"])
    error_message = "an association may be changed or deleted only while tagged Stack=konjir-test"
  }
  # An Elastic IP goes only to a network interface in production's VPC.
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.ec2.policy).Statement : s.Sid == "AddressToOwnInterface" || s.Sid == "OwnResources" if s.Effect == "Allow" && contains(flatten([s.Action]), "ec2:AssociateAddress")]) && one([for s in jsondecode(aws_iam_policy.ec2.policy).Statement : s.Condition if s.Sid == "AddressToOwnInterface"]) == { StringEquals = { "ec2:Vpc" = "arn:aws:ec2:us-east-1:747533038441:vpc/vpc-0ce63124e64459538" } }
    error_message = "AssociateAddress must reach only production's instances, addresses and network interfaces"
  }
  # DeleteTags with no keys (every tag) is refused.
  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.ec2.policy).Statement : s.Condition if s.Sid == "NeverDeleteAllTags" && s.Effect == "Deny"]) == { Null = { "aws:TagKeys" = "true" } }
    error_message = "DeleteTags without keys must be denied"
  }
  # DNS: the konjir.com zone, each name only with its types, and no other names.
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_policy.write.policy).Statement : s.Resource == "arn:aws:route53:::hostedzone/Z0507288XMQWHJUJUA0O" if contains(flatten([s.Action]), "route53:ChangeResourceRecordSets")]) && [for s in jsondecode(aws_iam_policy.write.policy).Statement : s.Condition if contains(flatten([s.Action]), "route53:ChangeResourceRecordSets")] == [
      { "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = ["kolab.konjir.com", "konjir.com", "www.konjir.com"], "route53:ChangeResourceRecordSetsRecordTypes" = ["A", "AAAA"] } },
      { "ForAllValues:StringLike" = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = ["_????????????????????????????????.konjir.com", "_????????????????????????????????.www.konjir.com"] }, "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsRecordTypes" = ["CNAME"] } },
      { "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = ["konjir.com", "_dmarc.konjir.com"], "route53:ChangeResourceRecordSetsRecordTypes" = ["TXT"] } },
    ]
    error_message = "DNS changes: A/AAAA for kolab, the apex and www; CNAME for ACM's validation names; TXT for the apex and _dmarc; in the konjir.com zone only"
  }
  # Only Amazon and Let's Encrypt may issue for konjir.com, and no one a wildcard.
  assert {
    condition     = aws_route53_record.caa.type == "CAA" && aws_route53_record.caa.name == "konjir.com" && toset(aws_route53_record.caa.records) == toset(["0 issue \"amazon.com\"", "0 issue \"letsencrypt.org\"", "0 issuewild \";\""])
    error_message = "konjir.com's CAA names Amazon and Let's Encrypt only, and forbids wildcards"
  }
  # A trust is never set or changed from CI, and no role made or deleted.
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_policy.roles.policy).Statement : anytrue([for a in flatten([s.Action]) : contains(["iam:CreateRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy"], a)]) if s.Effect == "Allow"])
    error_message = "the deploy role must not create or delete a role, or change a trust"
  }
  # The break-glass admin token (W2.23a): every SSM action on it denied, no reads by path, and no
  # KMS call under its encryption context, in a policy attached to the role. tests/simulate.sh asks
  # IAM's policy simulator the same of the rendered policies, with Lee's credentials.
  assert {
    condition = jsondecode(aws_iam_policy.not_admin_token.policy).Statement == [
      { Sid = "NotTheAdminToken", Effect = "Deny", Action = ["ssm:*"], Resource = "arn:aws:ssm:us-east-1:747533038441:parameter/konjir/konjir-test/admin-token" },
      { Sid = "NoReadsByPath", Effect = "Deny", Action = ["ssm:GetParametersByPath"], Resource = "*" },
      { Sid = "NotItsEncryption", Effect = "Deny", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"], Resource = "*", Condition = { StringEquals = { "kms:EncryptionContext:PARAMETER_ARN" = "arn:aws:ssm:us-east-1:747533038441:parameter/konjir/konjir-test/admin-token" } } },
    ]
    error_message = "the deploy role must be denied every SSM action on /konjir/konjir-test/admin-token, GetParametersByPath, and KMS under that parameter's encryption context"
  }
  assert {
    condition     = aws_iam_role_policy_attachment.deploy["not_admin_token"].policy_arn == aws_iam_policy.not_admin_token.arn && aws_iam_role_policy_attachment.deploy["not_admin_token"].role == aws_iam_role.deploy.name
    error_message = "the admin token's denies must be attached to the deploy role"
  }
  # No allow anywhere names the token or grants reads by path.
  assert {
    condition     = !anytrue([for p in [aws_iam_policy.read, aws_iam_policy.ec2, aws_iam_policy.write, aws_iam_policy.site, aws_iam_policy.roles] : strcontains(p.policy, "admin-token") || strcontains(p.policy, "GetParametersByPath") || strcontains(p.policy, "ssm:*") || strcontains(p.policy, "ssm:GetParameter*")])
    error_message = "no allow may name the admin token, GetParametersByPath, ssm:* or ssm:GetParameter*"
  }
  # The role can't undo the deny: every IAM action it is allowed reaches only the instance and
  # snapshot roles and the instance profile, never itself (DetachRolePolicy, PutRolePolicy) nor any
  # policy (DeletePolicy, CreatePolicyVersion, SetDefaultPolicyVersion). Widening a glob in
  # ReadOwnRoles or the roles policy to reach role/konjir/konjir-deploy-production or policy/ fails here.
  assert {
    condition = alltrue(flatten([for p in [aws_iam_policy.read, aws_iam_policy.ec2, aws_iam_policy.write, aws_iam_policy.site, aws_iam_policy.roles] : [
      for s in jsondecode(p.policy).Statement : [
        for r in flatten([s.Resource]) : can(regex("^arn:aws:iam::747533038441:(role|instance-profile)/konjir-test-(kolab|dlm)-\\*$", r))
      ] if s.Effect == "Allow" && anytrue([for a in flatten([s.Action]) : startswith(a, "iam:") || a == "*"])
    ]]))
    error_message = "an IAM allow reaches beyond role/konjir-test-{kolab,dlm}-* and instance-profile/konjir-test-*: the deploy role could detach, delete or re-version its own deny"
  }
}
