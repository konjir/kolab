# What lets GitHub Actions deploy Kolab (D73, W2.23): GitHub's OIDC identity provider in the account,
# and three roles that .github/workflows/deploy.yml assumes with the job's OIDC token, so no AWS key
# is stored anywhere.
#
# - konjir-deploy-staging: plans and applies staging. Only a job on main of konjir/kolab may assume it.
# - konjir-plan-production: plans production, read-only, so Lee sees the change before he approves
#   it. Also only a job on main.
# - konjir-deploy-production: applies production. Only a job in the production GitHub environment may
#   assume it, and that environment waits for Lee's approval (README: Deploying from CI).
#
# Each deploy role reaches its own environment only: its own state key, and resources named with its
# own prefix (konjir-staging-*, konjir-test-*) where AWS can tell by name or tag. EC2, Route 53 health
# checks and SSM associations can't all be told apart by name; the EC2 instances, volumes and
# snapshots of the other environment are refused by their Stack tag.
#
# A deploy role may create or change an IAM role only with its environment's permissions boundary
# attached (aws_iam_policy.boundary), so no role made from CI can hold more than the boundary allows:
# what the instance and the snapshot schedule need, and nothing of IAM, STS, the other environment's
# parameters or control of other instances.
#
# Lee applies this once from his machine (README: Deploying from CI), and again only to change it.
# Neither deploy role can read or change it: it has its own state, and its roles and policies are
# outside the names the deploy roles may touch.

variable "repository" {
  description = "The GitHub repository whose workflows may assume the roles."
  type        = string
  default     = "konjir/kolab"
}

variable "oidc_provider_exists" {
  description = "True if the account already has GitHub's OIDC provider (https://token.actions.githubusercontent.com): it is then looked up, not created. An account has at most one per URL."
  type        = bool
  default     = false
}

module "environments" {
  source = "../modules/environments"
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  p      = data.aws_partition.current.partition
  a      = data.aws_caller_identity.current.account_id
  r      = "us-east-1"
  issuer = "token.actions.githubusercontent.com"
  envs   = module.environments.all

  # The sub claim of the job's OIDC token: a job on main, or a job in the production environment.
  on_main = "repo:${var.repository}:ref:refs/heads/main"
  subjects = {
    staging    = local.on_main
    production = "repo:${var.repository}:environment:production"
  }

  oidc_provider_arn = var.oidc_provider_exists ? data.aws_iam_openid_connect_provider.github[0].arn : aws_iam_openid_connect_provider.github[0].arn

  # Each environment's resources, by ARN.
  arns = { for k, e in local.envs : k => {
    state       = "arn:${local.p}:s3:::konjir-terraform/${e.state_key}"
    artifacts   = ["arn:${local.p}:s3:::${e.name}-artifacts-*", "arn:${local.p}:s3:::${e.name}-artifacts-*/*"]
    parameters  = "arn:${local.p}:ssm:${local.r}:${local.a}:parameter/konjir/${e.name}/*"
    roles       = "arn:${local.p}:iam::${local.a}:role/${e.name}-*"
    profiles    = "arn:${local.p}:iam::${local.a}:instance-profile/${e.name}-*"
    boundary    = "arn:${local.p}:iam::${local.a}:policy/konjir/${e.name}-boundary"
    log_group   = ["arn:${local.p}:logs:${local.r}:${local.a}:log-group:/konjir/${e.name}", "arn:${local.p}:logs:${local.r}:${local.a}:log-group:/konjir/${e.name}:*"]
    alarms      = "arn:${local.p}:cloudwatch:${local.r}:${local.a}:alarm:${e.name}-*"
    topic       = ["arn:${local.p}:sns:${local.r}:${local.a}:${e.name}-alarms", "arn:${local.p}:sns:${local.r}:${local.a}:${e.name}-alarms:*"]
    rds         = ["db:${e.name}-*", "subgrp:${e.name}-*", "snapshot:${e.name}-*", "pg:default*", "og:default*"]
    tagged_ec2  = ["arn:${local.p}:ec2:${local.r}:${local.a}:instance/*", "arn:${local.p}:ec2:${local.r}:${local.a}:volume/*", "arn:${local.p}:ec2:${local.r}::snapshot/*"]
    dlm_rules   = "arn:${local.p}:events:${local.r}:${local.a}:rule/AwsDataLifecycleRule.managed-cwe.*"
    public_amis = "arn:${local.p}:ssm:${local.r}::parameter/aws/service/*"
  } }
}

# ---- GitHub's OIDC identity provider

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.oidc_provider_exists ? 0 : 1
  url            = "https://${local.issuer}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.oidc_provider_exists ? 1 : 0
  url   = "https://${local.issuer}"
}

# ---- The permissions boundary of every role an environment's Terraform creates

resource "aws_iam_policy" "boundary" {
  for_each    = local.envs
  name        = "${each.value.name}-boundary"
  path        = "/konjir/"
  description = "The most any IAM role of Kolab's ${each.key} environment may do (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # The Systems Manager agent (AmazonSSMManagedInstanceCore) and the CloudWatch agent's metrics.
      # The denials below take away what would reach beyond the instance itself.
      {
        Sid      = "Agents"
        Effect   = "Allow"
        Action   = ["ssm:*", "ssmmessages:*", "ec2messages:*", "cloudwatch:PutMetricData", "ec2:Describe*"]
        Resource = "*"
      },
      {
        Sid      = "ReadReleases"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = local.arns[each.key].artifacts
      },
      {
        Sid      = "ShipLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = local.arns[each.key].log_group
      },
      # SecureStrings use the AWS-managed SSM key.
      {
        Sid       = "DecryptParameters"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${local.r}.amazonaws.com" } }
      },
      # The daily snapshots (AWSDataLifecycleManagerServiceRole); it deletes only this environment's.
      {
        Sid    = "Snapshots"
        Effect = "Allow"
        Action = [
          "ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:CopySnapshot", "ec2:ModifySnapshotAttribute",
          "ec2:DescribeSnapshotAttribute", "ec2:ModifySnapshotTier", "ec2:DescribeSnapshotTierStatus",
          "ec2:EnableFastSnapshotRestores", "ec2:DisableFastSnapshotRestores", "ec2:DescribeFastSnapshotRestores",
        ]
        Resource = "*"
      },
      {
        Sid       = "DeleteOwnSnapshots"
        Effect    = "Allow"
        Action    = ["ec2:DeleteSnapshot"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:ResourceTag/Stack" = each.value.name } }
      },
      {
        Sid      = "TagSnapshots"
        Effect   = "Allow"
        Action   = ["ec2:CreateTags"]
        Resource = "arn:${local.p}:ec2:*::snapshot/*"
      },
      {
        Sid      = "SnapshotSchedule"
        Effect   = "Allow"
        Action   = ["events:PutRule", "events:DeleteRule", "events:DescribeRule", "events:EnableRule", "events:DisableRule", "events:ListTargetsByRule", "events:PutTargets", "events:RemoveTargets"]
        Resource = local.arns[each.key].dlm_rules
      },
      {
        Sid         = "NoOtherParameters"
        Effect      = "Deny"
        Action      = ["ssm:GetParameter*"]
        NotResource = [local.arns[each.key].parameters, "arn:${local.p}:ssm:*::parameter/aws/*"]
      },
      {
        Sid    = "NoControlBeyondTheInstance"
        Effect = "Deny"
        Action = [
          "ssm:SendCommand", "ssm:StartSession", "ssm:ResumeSession", "ssm:StartAutomationExecution",
          "ssm:StartChangeRequestExecution", "ssm:CreateAssociation", "ssm:CreateAssociationBatch",
          "ssm:UpdateAssociation", "ssm:DeleteAssociation", "ssm:PutParameter", "ssm:DeleteParameter",
          "ssm:DeleteParameters", "ssm:LabelParameterVersion", "ssm:CreateDocument", "ssm:UpdateDocument",
          "ssm:DeleteDocument", "ssm:UpdateDocumentDefaultVersion", "ssm:ModifyDocumentPermission",
          "ssm:CreateActivation", "ssm:RegisterTaskWithMaintenanceWindow", "ssm:UpdateMaintenanceWindowTask",
          "ssm:CreateMaintenanceWindow", "ssm:UpdateServiceSetting", "ssm:ResetServiceSetting",
        ]
        Resource = "*"
      },
    ]
  })
}

# ---- What each role may read: enough to plan its environment

resource "aws_iam_policy" "read" {
  for_each    = local.envs
  name        = "konjir-deploy-${each.key}-read"
  path        = "/konjir/"
  description = "Plan Kolab's ${each.key} environment: read its state and its resources (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Object names only: init lists the bucket for workspaces.
      {
        Sid      = "ListState"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:${local.p}:s3:::konjir-terraform"
      },
      {
        Sid      = "ReadState"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = local.arns[each.key].state
      },
      {
        Sid    = "Describe"
        Effect = "Allow"
        Action = [
          "ec2:Describe*", "rds:Describe*", "rds:ListTagsForResource", "logs:Describe*", "logs:ListTagsForResource",
          "logs:ListTagsLogGroup", "cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource",
          "sns:GetTopicAttributes", "sns:ListTagsForResource", "sns:GetSubscriptionAttributes",
          "sns:ListSubscriptionsByTopic", "route53:Get*", "route53:List*", "dlm:Get*", "dlm:List*",
          "ssm:DescribeParameters", "ssm:DescribeAssociation", "ssm:DescribeAssociationExecutions",
          "ssm:DescribeAssociationExecutionTargets", "ssm:ListAssociations", "ssm:ListAssociationVersions",
          "ssm:ListTagsForResource", "ssm:DescribeDocument", "ssm:GetDocument", "ssm:DescribeInstanceInformation",
        ]
        Resource = "*"
      },
      {
        Sid      = "ReadOwnBucket"
        Effect   = "Allow"
        Action   = ["s3:Get*", "s3:List*"]
        Resource = local.arns[each.key].artifacts
      },
      # Its own parameters (the admin token and database URL among them, which state holds too),
      # and the public one naming the latest Amazon Linux AMI.
      {
        Sid      = "ReadOwnParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [local.arns[each.key].parameters, local.arns[each.key].public_amis]
      },
      {
        Sid       = "DecryptOwnParameters"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${local.r}.amazonaws.com" } }
      },
      {
        Sid    = "ReadOwnRoles"
        Effect = "Allow"
        Action = [
          "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole", "iam:ListRoleTags", "iam:GetInstanceProfile", "iam:ListInstanceProfileTags",
        ]
        Resource = [local.arns[each.key].roles, local.arns[each.key].profiles]
      },
    ]
  })
}

# ---- What a deploy role may change: its own environment

resource "aws_iam_policy" "write" {
  for_each    = local.envs
  name        = "konjir-deploy-${each.key}-write"
  path        = "/konjir/"
  description = "Apply Kolab's ${each.key} environment: write its state and its resources (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteStateAndLock"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [local.arns[each.key].state, "${local.arns[each.key].state}.tflock"]
      },
      {
        Sid       = "Ec2InThisRegion"
        Effect    = "Allow"
        Action    = ["ec2:*"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.r } }
      },
      # The other environment's instance, volumes and snapshots are refused by their Stack tag.
      {
        Sid    = "NotTheOtherStacksInstances"
        Effect = "Deny"
        Action = [
          "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances", "ec2:RebootInstances",
          "ec2:ModifyInstanceAttribute", "ec2:ModifyInstanceMetadataOptions", "ec2:AssociateIamInstanceProfile",
          "ec2:ReplaceIamInstanceProfileAssociation", "ec2:DisassociateIamInstanceProfile", "ec2:AttachVolume",
          "ec2:DetachVolume", "ec2:DeleteVolume", "ec2:ModifyVolume", "ec2:DeleteSnapshot",
        ]
        Resource  = local.arns[each.key].tagged_ec2
        Condition = { StringNotEquals = { "aws:ResourceTag/Stack" = each.value.name } }
      },
      # Nor retagged into this one. Tags given at creation (ec2:CreateAction) are allowed.
      {
        Sid       = "NotRetaggingTheOtherStack"
        Effect    = "Deny"
        Action    = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource  = local.arns[each.key].tagged_ec2
        Condition = { StringNotEquals = { "aws:ResourceTag/Stack" = each.value.name }, Null = { "ec2:CreateAction" = "true" } }
      },
      {
        Sid      = "OwnDatabase"
        Effect   = "Allow"
        Action   = ["rds:*"]
        Resource = [for r in local.arns[each.key].rds : "arn:${local.p}:rds:${local.r}:${local.a}:${r}"]
      },
      {
        Sid      = "OwnBucket"
        Effect   = "Allow"
        Action   = ["s3:*"]
        Resource = local.arns[each.key].artifacts
      },
      {
        Sid      = "OwnParameters"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"]
        Resource = local.arns[each.key].parameters
      },
      # The release's install: an association running AWS-RunShellScript on this environment's instance.
      {
        Sid    = "InstallAssociation"
        Effect = "Allow"
        Action = ["ssm:CreateAssociation", "ssm:UpdateAssociation", "ssm:DeleteAssociation", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"]
        Resource = [
          "arn:${local.p}:ssm:${local.r}:${local.a}:association/*",
          "arn:${local.p}:ssm:${local.r}::document/AWS-RunShellScript",
        ]
      },
      {
        Sid       = "InstallOnOwnInstance"
        Effect    = "Allow"
        Action    = ["ssm:CreateAssociation", "ssm:UpdateAssociation"]
        Resource  = "arn:${local.p}:ec2:${local.r}:${local.a}:instance/*"
        Condition = { StringEquals = { "ssm:resourceTag/Stack" = each.value.name } }
      },
      {
        Sid      = "OwnLogs"
        Effect   = "Allow"
        Action   = ["logs:*"]
        Resource = local.arns[each.key].log_group
      },
      {
        Sid      = "OwnAlarms"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
        Resource = local.arns[each.key].alarms
      },
      {
        Sid      = "OwnTopic"
        Effect   = "Allow"
        Action   = ["sns:*"]
        Resource = local.arns[each.key].topic
      },
      {
        Sid       = "OwnDnsRecord"
        Effect    = "Allow"
        Action    = ["route53:ChangeResourceRecordSets"]
        Resource  = "arn:${local.p}:route53:::hostedzone/*"
        Condition = { "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [each.value.domain_name] } }
      },
      {
        Sid      = "HealthChecks"
        Effect   = "Allow"
        Action   = ["route53:CreateHealthCheck", "route53:UpdateHealthCheck", "route53:DeleteHealthCheck", "route53:ChangeTagsForResource"]
        Resource = "*"
      },
      {
        Sid      = "SnapshotSchedule"
        Effect   = "Allow"
        Action   = ["dlm:CreateLifecyclePolicy", "dlm:UpdateLifecyclePolicy", "dlm:DeleteLifecyclePolicy", "dlm:TagResource", "dlm:UntagResource"]
        Resource = "*"
      },
      {
        Sid       = "NotTheOtherStacksSchedule"
        Effect    = "Deny"
        Action    = ["dlm:UpdateLifecyclePolicy", "dlm:DeleteLifecyclePolicy"]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:ResourceTag/Stack" = each.value.name } }
      },
      # Encrypted volumes, database and SecureStrings, all with AWS-managed keys.
      {
        Sid       = "ManagedKeys"
        Effect    = "Allow"
        Action    = ["kms:CreateGrant", "kms:DescribeKey", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = ["ec2.${local.r}.amazonaws.com", "rds.${local.r}.amazonaws.com", "ssm.${local.r}.amazonaws.com"] } }
      },
    ]
  })
}

# ---- What a deploy role may do in IAM: its own environment's roles, only inside the boundary

resource "aws_iam_policy" "roles" {
  for_each    = local.envs
  name        = "konjir-deploy-${each.key}-roles"
  path        = "/konjir/"
  description = "Apply Kolab's ${each.key} environment: its IAM roles, only with its permissions boundary (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Roles only with the boundary, and only the two AWS-managed policies the modules attach.
      {
        Sid       = "OwnRolesWithTheBoundary"
        Effect    = "Allow"
        Action    = ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary"]
        Resource  = local.arns[each.key].roles
        Condition = { StringEquals = { "iam:PermissionsBoundary" = local.arns[each.key].boundary } }
      },
      {
        Sid      = "OwnRolesAttachOnlyManaged"
        Effect   = "Allow"
        Action   = ["iam:AttachRolePolicy"]
        Resource = local.arns[each.key].roles
        Condition = {
          StringEquals = { "iam:PermissionsBoundary" = local.arns[each.key].boundary }
          ArnEquals = { "iam:PolicyARN" = [
            "arn:${local.p}:iam::aws:policy/AmazonSSMManagedInstanceCore",
            "arn:${local.p}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole",
          ] }
        }
      },
      {
        Sid    = "OwnRolesAndProfiles"
        Effect = "Allow"
        Action = [
          "iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateRole", "iam:UpdateRoleDescription",
          "iam:UpdateAssumeRolePolicy", "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile",
          "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile",
          "iam:UntagInstanceProfile",
        ]
        Resource = [local.arns[each.key].roles, local.arns[each.key].profiles]
      },
      {
        Sid       = "PassOwnRoles"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = local.arns[each.key].roles
        Condition = { StringEquals = { "iam:PassedToService" = ["ec2.amazonaws.com", "dlm.amazonaws.com"] } }
      },
      {
        Sid      = "KeepTheBoundary"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary"]
        Resource = "*"
      },
    ]
  })
}

# ---- The roles

locals {
  roles = {
    "konjir-deploy-staging"    = { subject = local.subjects.staging, policies = [aws_iam_policy.read["staging"].arn, aws_iam_policy.write["staging"].arn, aws_iam_policy.roles["staging"].arn] }
    "konjir-plan-production"   = { subject = local.on_main, policies = [aws_iam_policy.read["production"].arn] }
    "konjir-deploy-production" = { subject = local.subjects.production, policies = [aws_iam_policy.read["production"].arn, aws_iam_policy.write["production"].arn, aws_iam_policy.roles["production"].arn] }
  }

  role_policies = merge([for role, r in local.roles : { for i, arn in r.policies : "${role}/${i}" => { role = role, arn = arn } }]...)
}

resource "aws_iam_role" "ci" {
  for_each    = local.roles
  name        = each.key
  path        = "/konjir/"
  description = "Assumed by GitHub Actions in ${var.repository} (${each.value.subject}) to deploy Kolab (W2.23)"
  # An apply can wait 30 minutes for the install, after an RDS change of as long.
  max_session_duration = 7200
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.oidc_provider_arn }
      Action    = ["sts:AssumeRoleWithWebIdentity", "sts:TagSession"]
      Condition = {
        StringEquals = {
          "${local.issuer}:aud" = "sts.amazonaws.com"
          "${local.issuer}:sub" = each.value.subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ci" {
  for_each   = local.role_policies
  role       = aws_iam_role.ci[each.value.role].name
  policy_arn = each.value.arn
}
