# What lets GitHub Actions deploy production (D73, D83, W2.23): GitHub's OIDC identity provider in
# the account, and one role, konjir-deploy-production, that .github/workflows/deploy.yml assumes with
# the job's OIDC token, so no AWS key is stored anywhere.
#
# Who may assume it: only a job of deploy.yml on main that runs in the production GitHub
# environment, which waits for Lee's approval. The repository's OIDC subject is customised to
# carry the workflow (README: Deploying from CI), so the trust names the workflow file and its
# branch, not only the environment.
#
# What it may do: what production's plan and apply need, and little else. Its state key only; EC2 by
# an allowlist of the actions the modules call, in us-east-1, never account-wide settings; RDS, S3,
# SSM parameters, logs, alarms, the topic and DNS records by production's names; and IAM roles only
# as the modules make them (below).
#
# IAM: the role may create or change only the instance role (konjir-test-kolab-*) and the snapshot
# role (konjir-test-dlm-*), each only with its permissions boundary attached and only the one
# AWS-managed policy the modules attach to it, and it may never change a trust policy after
# creation. IAM has no condition key on a trust policy's contents, so the boundaries are what limit
# a role made with another trust: the instance boundary refuses every call not made with an EC2
# instance's credentials (or by a service on its behalf), and the snapshot boundary allows only
# snapshots of production's own volumes, which it can't copy or share.
#
# Lee applies this from his machine, with his own credentials, whenever the role or its policies
# change (README: Deploying from CI). The role can neither read nor change it: it has its own state,
# and its role and policies are outside the names the role may touch.

variable "repository" {
  description = "The GitHub repository whose deploy workflow may assume the role."
  type        = string
  default     = "konjir/kolab"
}

variable "oidc_provider_exists" {
  description = "True if the account already has GitHub's OIDC provider (https://token.actions.githubusercontent.com): it is then looked up, not created. An account has at most one per URL."
  type        = bool
  default     = false
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  p      = data.aws_partition.current.partition
  a      = data.aws_caller_identity.current.account_id
  r      = "us-east-1"
  issuer = "token.actions.githubusercontent.com"

  # Production, as deploy/terraform names it.
  name      = "konjir-test"
  state_key = "konjir/test/terraform.tfstate"
  zone      = "konjir.com"
  domain    = "kolab.konjir.com"

  # The OIDC subject of a deploy.yml job on main in the production environment, with the
  # repository's subject customised to repo, context and job_workflow_ref (README).
  subject = "repo:${var.repository}:environment:production:job_workflow_ref:${var.repository}/.github/workflows/deploy.yml@refs/heads/main"

  oidc_provider_arn = var.oidc_provider_exists ? data.aws_iam_openid_connect_provider.github[0].arn : aws_iam_openid_connect_provider.github[0].arn

  state        = "arn:${local.p}:s3:::konjir-terraform/${local.state_key}"
  buckets      = ["arn:${local.p}:s3:::${local.name}-artifacts-*", "arn:${local.p}:s3:::${local.name}-site-*"]
  objects      = ["arn:${local.p}:s3:::${local.name}-artifacts-*/*", "arn:${local.p}:s3:::${local.name}-site-*/*"]
  parameters   = "arn:${local.p}:ssm:${local.r}:${local.a}:parameter/konjir/${local.name}/*"
  public_amis  = "arn:${local.p}:ssm:${local.r}::parameter/aws/service/*"
  kolab_roles  = "arn:${local.p}:iam::${local.a}:role/${local.name}-kolab-*"
  dlm_roles    = "arn:${local.p}:iam::${local.a}:role/${local.name}-dlm-*"
  profiles     = "arn:${local.p}:iam::${local.a}:instance-profile/${local.name}-kolab-*"
  log_group    = ["arn:${local.p}:logs:${local.r}:${local.a}:log-group:/konjir/${local.name}", "arn:${local.p}:logs:${local.r}:${local.a}:log-group:/konjir/${local.name}:*"]
  alarms       = "arn:${local.p}:cloudwatch:${local.r}:${local.a}:alarm:${local.name}-*"
  topic        = ["arn:${local.p}:sns:${local.r}:${local.a}:${local.name}-alarms", "arn:${local.p}:sns:${local.r}:${local.a}:${local.name}-alarms:*"]
  dlm_rules    = "arn:${local.p}:events:${local.r}:${local.a}:rule/AwsDataLifecycleRule.managed-cwe.*"
  instances    = "arn:${local.p}:ec2:${local.r}:${local.a}:instance/*"
  volumes      = "arn:${local.p}:ec2:${local.r}:${local.a}:volume/*"
  snapshots    = "arn:${local.p}:ec2:${local.r}::snapshot/*"
  ssm_core     = "arn:${local.p}:iam::aws:policy/AmazonSSMManagedInstanceCore"
  dlm_managed  = "arn:${local.p}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
  only_here    = { StringEquals = { "aws:RequestedRegion" = local.r } }
  own_stack    = { StringEquals = { "aws:ResourceTag/Stack" = local.name } }
  not_own_tags = { StringNotEquals = { "aws:ResourceTag/Stack" = local.name } }
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

# ---- The permissions boundaries of the two roles deploy/terraform makes

# The instance role: what Kolab's instance uses (AmazonSSMManagedInstanceCore and modules/iam's
# policy), and only from an EC2 instance.
resource "aws_iam_policy" "instance_boundary" {
  name        = "${local.name}-instance-boundary"
  path        = "/konjir/"
  description = "The most Kolab's instance role may do, and only from an EC2 instance (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SystemsManagerAgent"
        Effect = "Allow"
        Action = [
          "ssm:DescribeAssociation", "ssm:GetDeployablePatchSnapshotForInstance", "ssm:GetDocument",
          "ssm:DescribeDocument", "ssm:GetManifest", "ssm:ListAssociations", "ssm:ListInstanceAssociations",
          "ssm:PutInventory", "ssm:PutComplianceItems", "ssm:PutConfigurePackageResult",
          "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus", "ssm:UpdateInstanceInformation",
          "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel", "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage",
          "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply",
        ]
        Resource = "*"
      },
      {
        Sid      = "OwnParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = local.parameters
      },
      # SecureStrings use the AWS-managed SSM key.
      {
        Sid       = "DecryptParameters"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${local.r}.amazonaws.com" } }
      },
      {
        Sid      = "ReadReleases"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = ["arn:${local.p}:s3:::${local.name}-artifacts-*", "arn:${local.p}:s3:::${local.name}-artifacts-*/*"]
      },
      {
        Sid      = "ShipLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = local.log_group
      },
      {
        Sid      = "PutMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
      },
      # Credentials of this role used anywhere but on an EC2 instance (through a trust to someone
      # else, say) can do nothing. A service acting for the instance, such as SSM decrypting a
      # SecureString through KMS, is allowed.
      {
        Sid      = "OnlyFromAnInstance"
        Effect   = "Deny"
        Action   = "*"
        Resource = "*"
        Condition = {
          Null = { "ec2:SourceInstanceARN" = "true" }
          Bool = { "aws:ViaAWSService" = "false" }
        }
      },
    ]
  })
}

# The snapshot role (Data Lifecycle Manager): snapshots of production's own volumes, kept and
# expired; nothing copied or shared.
resource "aws_iam_policy" "dlm_boundary" {
  name        = "${local.name}-dlm-boundary"
  path        = "/konjir/"
  description = "The most Kolab's snapshot role may do: snapshot production's own volumes (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "SnapshotOwnVolumes"
        Effect    = "Allow"
        Action    = ["ec2:CreateSnapshot", "ec2:CreateSnapshots"]
        Resource  = [local.volumes, local.instances]
        Condition = local.own_stack
      },
      {
        Sid      = "NewSnapshots"
        Effect   = "Allow"
        Action   = ["ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:CreateTags"]
        Resource = local.snapshots
      },
      {
        Sid       = "ExpireOwnSnapshots"
        Effect    = "Allow"
        Action    = ["ec2:DeleteSnapshot"]
        Resource  = local.snapshots
        Condition = local.own_stack
      },
      {
        Sid      = "Describe"
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeSnapshots", "ec2:DescribeAvailabilityZones", "ec2:DescribeSnapshotAttribute"]
        Resource = "*"
      },
      {
        Sid      = "Schedule"
        Effect   = "Allow"
        Action   = ["events:PutRule", "events:DeleteRule", "events:DescribeRule", "events:EnableRule", "events:DisableRule", "events:ListTargetsByRule", "events:PutTargets", "events:RemoveTargets"]
        Resource = local.dlm_rules
      },
    ]
  })
}

# ---- What the deploy role may read: enough to plan production

resource "aws_iam_policy" "read" {
  name        = "konjir-deploy-production-read"
  path        = "/konjir/"
  description = "Plan Kolab's production: its state, with the lock, and read its resources (W2.23)"
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
        Sid      = "State"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = [local.state, "${local.state}.tflock"]
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
          "cloudfront:Get*", "cloudfront:List*", "cloudfront:DescribeFunction", "acm:DescribeCertificate",
          "acm:ListCertificates", "acm:ListTagsForCertificate", "acm:GetCertificate",
        ]
        Resource = "*"
      },
      {
        Sid      = "ReadOwnBuckets"
        Effect   = "Allow"
        Action   = ["s3:Get*", "s3:List*"]
        Resource = concat(local.buckets, local.objects)
      },
      {
        Sid      = "ReadOwnParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [local.parameters, local.public_amis]
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
        Resource = [local.kolab_roles, local.dlm_roles, local.profiles]
      },
    ]
  })
}

# ---- What it may change: production's resources

resource "aws_iam_policy" "write" {
  name        = "konjir-deploy-production-write"
  path        = "/konjir/"
  description = "Apply Kolab's production: change its resources (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # The EC2 actions the network, storage and kolab modules call, and no account-wide setting.
      {
        Sid    = "Ec2Allowlist"
        Effect = "Allow"
        Action = [
          "ec2:CreateVpc", "ec2:DeleteVpc", "ec2:ModifyVpcAttribute", "ec2:CreateInternetGateway",
          "ec2:AttachInternetGateway", "ec2:DetachInternetGateway", "ec2:DeleteInternetGateway",
          "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:ModifySubnetAttribute", "ec2:CreateRouteTable",
          "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:DeleteRoute", "ec2:ReplaceRoute",
          "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:CreateSecurityGroup",
          "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules",
          "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
          "ec2:RunInstances", "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances",
          "ec2:ModifyInstanceAttribute", "ec2:ModifyInstanceMetadataOptions", "ec2:ModifyInstanceCreditSpecification",
          "ec2:MonitorInstances", "ec2:UnmonitorInstances", "ec2:CreateVolume", "ec2:DeleteVolume",
          "ec2:ModifyVolume", "ec2:AttachVolume", "ec2:DetachVolume", "ec2:CreateSnapshot",
          "ec2:AllocateAddress", "ec2:ReleaseAddress", "ec2:AssociateAddress", "ec2:DisassociateAddress",
          "ec2:CreateTags", "ec2:DeleteTags", "ec2:GetDefaultCreditSpecification", "ec2:GetInstanceMetadataDefaults",
          "ec2:GetEbsEncryptionByDefault", "ec2:GetEbsDefaultKmsKeyId",
        ]
        Resource  = "*"
        Condition = local.only_here
      },
      # Instances and volumes that aren't production's (the account may hold others) stay out of reach.
      {
        Sid    = "NotOtherInstancesOrVolumes"
        Effect = "Deny"
        Action = [
          "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances", "ec2:ModifyInstanceAttribute",
          "ec2:ModifyInstanceMetadataOptions", "ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume",
          "ec2:ModifyVolume", "ec2:CreateSnapshot",
        ]
        Resource  = [local.instances, local.volumes]
        Condition = local.not_own_tags
      },
      {
        Sid       = "OwnDatabase"
        Effect    = "Allow"
        Action    = ["rds:CreateDBInstance", "rds:ModifyDBInstance", "rds:DeleteDBInstance", "rds:RebootDBInstance", "rds:CreateDBSnapshot", "rds:AddTagsToResource", "rds:RemoveTagsFromResource", "rds:CreateDBSubnetGroup", "rds:ModifyDBSubnetGroup", "rds:DeleteDBSubnetGroup"]
        Resource  = [for r in ["db:${local.name}-*", "subgrp:${local.name}-*", "snapshot:${local.name}-*", "pg:default*", "og:default*"] : "arn:${local.p}:rds:${local.r}:${local.a}:${r}"]
        Condition = local.only_here
      },
      {
        Sid      = "OwnBuckets"
        Effect   = "Allow"
        Action   = ["s3:*"]
        Resource = concat(local.buckets, local.objects)
      },
      {
        Sid      = "OwnParameters"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"]
        Resource = local.parameters
      },
      # The release's install: an association running AWS-RunShellScript on production's instance.
      {
        Sid      = "InstallAssociation"
        Effect   = "Allow"
        Action   = ["ssm:CreateAssociation", "ssm:UpdateAssociation", "ssm:DeleteAssociation", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"]
        Resource = ["arn:${local.p}:ssm:${local.r}:${local.a}:association/*", "arn:${local.p}:ssm:${local.r}::document/AWS-RunShellScript"]
      },
      {
        Sid       = "InstallOnOwnInstance"
        Effect    = "Allow"
        Action    = ["ssm:CreateAssociation", "ssm:UpdateAssociation"]
        Resource  = local.instances
        Condition = { StringEquals = { "ssm:resourceTag/Stack" = local.name } }
      },
      {
        Sid      = "OwnLogs"
        Effect   = "Allow"
        Action   = ["logs:*"]
        Resource = local.log_group
      },
      {
        Sid      = "OwnAlarms"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
        Resource = local.alarms
      },
      {
        Sid      = "OwnTopic"
        Effect   = "Allow"
        Action   = ["sns:*"]
        Resource = local.topic
      },
      # kolab.konjir.com, and the marketing site's apex, www and certificate validation records.
      {
        Sid       = "OwnDnsRecords"
        Effect    = "Allow"
        Action    = ["route53:ChangeResourceRecordSets"]
        Resource  = "arn:${local.p}:route53:::hostedzone/*"
        Condition = { "ForAllValues:StringLike" = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [local.domain, local.zone, "www.${local.zone}", "_*.${local.zone}"] } }
      },
      # Health checks have no names; production's role is the only one that changes any (D83).
      {
        Sid      = "HealthCheck"
        Effect   = "Allow"
        Action   = ["route53:CreateHealthCheck", "route53:UpdateHealthCheck", "route53:DeleteHealthCheck", "route53:ChangeTagsForResource"]
        Resource = "*"
      },
      {
        Sid       = "CreateOwnSchedule"
        Effect    = "Allow"
        Action    = ["dlm:CreateLifecyclePolicy", "dlm:TagResource"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestTag/Stack" = local.name } }
      },
      {
        Sid       = "ChangeOwnSchedule"
        Effect    = "Allow"
        Action    = ["dlm:UpdateLifecyclePolicy", "dlm:DeleteLifecyclePolicy", "dlm:UntagResource"]
        Resource  = "*"
        Condition = local.own_stack
      },
      # Encrypted volumes, database and SecureStrings, all with AWS-managed keys.
      {
        Sid       = "ManagedKeys"
        Effect    = "Allow"
        Action    = ["kms:CreateGrant", "kms:DescribeKey", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = ["ec2.${local.r}.amazonaws.com", "rds.${local.r}.amazonaws.com", "ssm.${local.r}.amazonaws.com"] } }
      },
      # The marketing site (D81): its CloudFront distribution, function, headers policy and origin
      # access control, and its certificate, which have no names to scope by.
      {
        Sid    = "Site"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateDistribution", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution",
          "cloudfront:TagResource", "cloudfront:UntagResource", "cloudfront:CreateOriginAccessControl",
          "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl", "cloudfront:CreateFunction",
          "cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction",
          "cloudfront:CreateResponseHeadersPolicy", "cloudfront:UpdateResponseHeadersPolicy",
          "cloudfront:DeleteResponseHeadersPolicy", "acm:RequestCertificate", "acm:DeleteCertificate",
          "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate",
        ]
        Resource = "*"
      },
    ]
  })
}

# ---- What it may do in IAM: production's two roles, each only inside its boundary

resource "aws_iam_policy" "roles" {
  name        = "konjir-deploy-production-roles"
  path        = "/konjir/"
  description = "Apply Kolab's production: its instance and snapshot roles, only with their boundaries (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "InstanceRoleWithItsBoundary"
        Effect    = "Allow"
        Action    = ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PutRolePermissionsBoundary"]
        Resource  = local.kolab_roles
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.instance_boundary.arn } }
      },
      {
        Sid       = "SnapshotRoleWithItsBoundary"
        Effect    = "Allow"
        Action    = ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PutRolePermissionsBoundary"]
        Resource  = local.dlm_roles
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.dlm_boundary.arn } }
      },
      {
        Sid      = "InstanceRoleManagedPolicy"
        Effect   = "Allow"
        Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource = local.kolab_roles
        Condition = {
          StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.instance_boundary.arn }
          ArnEquals    = { "iam:PolicyARN" = local.ssm_core }
        }
      },
      {
        Sid      = "SnapshotRoleManagedPolicy"
        Effect   = "Allow"
        Action   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
        Resource = local.dlm_roles
        Condition = {
          StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.dlm_boundary.arn }
          ArnEquals    = { "iam:PolicyARN" = local.dlm_managed }
        }
      },
      # No UpdateAssumeRolePolicy: a trust is set when the role is made and never changed.
      {
        Sid      = "OwnRolesAndProfile"
        Effect   = "Allow"
        Action   = ["iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile", "iam:UntagInstanceProfile"]
        Resource = [local.kolab_roles, local.dlm_roles, local.profiles]
      },
      {
        Sid       = "PassInstanceRole"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = local.kolab_roles
        Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } }
      },
      {
        Sid       = "PassSnapshotRole"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = local.dlm_roles
        Condition = { StringEquals = { "iam:PassedToService" = "dlm.amazonaws.com" } }
      },
      {
        Sid      = "KeepTheBoundaries"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary"]
        Resource = "*"
      },
    ]
  })
}

# ---- The role

resource "aws_iam_role" "deploy" {
  name        = "konjir-deploy-production"
  path        = "/konjir/"
  description = "Assumed by .github/workflows/deploy.yml on main, in the production environment, to plan and apply Kolab (W2.23)"
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
          "${local.issuer}:sub" = local.subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "deploy" {
  for_each = {
    read  = aws_iam_policy.read.arn
    write = aws_iam_policy.write.arn
    roles = aws_iam_policy.roles.arn
  }
  role       = aws_iam_role.deploy.name
  policy_arn = each.value
}
