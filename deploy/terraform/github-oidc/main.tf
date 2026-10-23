# What lets GitHub Actions deploy production (D73, D83, W2.23): GitHub's OIDC identity provider in
# the account, and one role, konjir-deploy-production, that .github/workflows/deploy.yml assumes with
# the job's OIDC token, so no AWS key is stored anywhere.
#
# Who may assume it: only a job of deploy.yml on main that runs in the production GitHub
# environment, which waits for Lee's approval. The trust checks the token's subject in GitHub's
# default form for this repository, which uses immutable subjects (below), and, in claims of their
# own, the repository's and owner's ids, the workflow file and the branch. The repository's subject
# isn't customised, so npm's trusted publishing (release-cli.yml) sees the subject it always has.
#
# What it may do: what production's plan and apply need, and little else. Its state key only; EC2
# only on resources tagged Stack=konjir-test, or created with that tag, in us-east-1, and never
# account-wide settings; RDS, S3, SSM parameters, logs, alarms and the topic by production's names;
# DNS records in the konjir.com zone by name and type; CloudFront and the certificate by tag; the
# install only through the SSM document below; and IAM only on the two roles the modules make,
# never creating or deleting one (below).
#
# IAM: the role may change only the instance role (konjir-test-kolab-*) and the snapshot role
# (konjir-test-dlm-*), each only with its permissions boundary attached and only the one AWS-managed
# policy the modules attach to it. It can't create or delete a role, or change a trust: IAM has no
# condition key on a trust policy's contents, so a role made from CI could trust anyone. Creating
# either role again is Lee's, from his machine (deploy/plan.sh refuses a plan that would). The
# boundaries limit what each role may do whatever its policy says: the instance boundary refuses
# every call not made with an EC2 instance's credentials (or by a service on its behalf), and the
# snapshot boundary allows only snapshots of production's own volumes, which it can't copy or share.
#
# Lee applies this from his machine, with his own credentials, whenever the role or its policies
# change (README: Deploying from CI). The role can neither read nor change it: it has its own state,
# and its role, policies and document are outside the names the role may touch.

variable "repository" {
  description = "The GitHub repository whose deploy workflow may assume the role, as owner/name."
  type        = string
  default     = "konjir/kolab"
}

# GitHub's immutable ids of the repository and its owner. The repository was created after GitHub
# turned on immutable OIDC subjects (gh api repos/konjir/kolab/actions/oidc/customization/sub shows
# use_immutable_subject: true, sub_claim_prefix repo:konjir@340888484/kolab@1414997919), so its
# tokens' subjects carry these ids, not only the names. A name can be freed and claimed by someone
# else; these ids can't. gh api repos/konjir/kolab --jq '{id, owner: .owner.id}' shows them.
variable "github_owner_id" {
  description = "The numeric id of the repository's owner, konjir."
  type        = string
  default     = "340888484"
}

variable "github_repository_id" {
  description = "The numeric id of the repository, konjir/kolab."
  type        = string
  default     = "1414997919"
}

variable "oidc_provider_exists" {
  description = "True if the account already has GitHub's OIDC provider (https://token.actions.githubusercontent.com): it is then looked up, not created. An account has at most one per URL."
  type        = bool
  default     = false
}

# Other projects' resources in this account that the role's CloudFront and ACM rights could
# otherwise reach (a read-only inventory, 2026-10-22: onivoro's cloud-disk.onivoro.com). Denied
# outright, whatever their tags. Add any that appear.
variable "other_projects_site_arns" {
  description = "CloudFront distributions and ACM certificates of other projects, which the role may never change."
  type        = list(string)
  default = [
    "arn:aws:cloudfront::747533038441:distribution/E3LXY6CF24V3AR",
    "arn:aws:acm:us-east-1:747533038441:certificate/e5ffa8d9-322d-47ea-9b8b-d69bd147cb7d",
  ]
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

# Production's VPC, found by its tags. An Elastic IP may be associated only with a network interface
# in it. If the VPC is ever replaced, apply this again so the role names the new one.
data "aws_vpc" "production" {
  tags = { Stack = "konjir-test", Name = "konjir-test-vpc" }
}

# The AWS-managed keys production's volumes, database and SecureStrings are encrypted with.
data "aws_kms_alias" "managed" {
  for_each = toset(["ebs", "rds", "ssm"])
  name     = "alias/aws/${each.key}"
}

locals {
  p      = data.aws_partition.current.partition
  a      = data.aws_caller_identity.current.account_id
  r      = "us-east-1"
  issuer = "token.actions.githubusercontent.com"

  # Production, as deploy/terraform names it.
  name      = "konjir-test"
  state_key = "konjir/test/terraform.tfstate"
  zone      = "konjir.com"
  zone_id   = "Z0507288XMQWHJUJUA0O" # konjir.com's hosted zone
  # An ACM DNS validation label after its underscore: 32 characters (an MD5 in hex).
  acm_label = join("", [for i in range(32) : "?"])
  domain    = "kolab.konjir.com"

  # The OIDC subject of a job in the production environment: GitHub's default subject, which for a
  # repository with immutable subjects names the owner and repository with their ids. The workflow
  # file and branch are claims of their own (job_workflow_ref, ref), which the trust checks too.
  subject_prefix = "repo:${split("/", var.repository)[0]}@${var.github_owner_id}/${split("/", var.repository)[1]}@${var.github_repository_id}"
  subject        = "${local.subject_prefix}:environment:production"
  workflow_ref   = "${var.repository}/.github/workflows/deploy.yml@refs/heads/main"

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
  ec2          = "arn:${local.p}:ec2:${local.r}:${local.a}"
  instances    = "${local.ec2}:instance/*"
  volumes      = "${local.ec2}:volume/*"
  snapshots    = "arn:${local.p}:ec2:${local.r}::snapshot/*"
  ssm_core     = "arn:${local.p}:iam::aws:policy/AmazonSSMManagedInstanceCore"
  dlm_managed  = "arn:${local.p}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
  managed_keys = [for k in data.aws_kms_alias.managed : k.target_key_arn]
  functions    = "arn:${local.p}:cloudfront::${local.a}:function/${local.name}-site-*"
  only_here    = { StringEquals = { "aws:RequestedRegion" = local.r } }
  own_stack    = { StringEquals = { "aws:ResourceTag/Stack" = local.name } }
  tagged_new   = { StringEquals = { "aws:RequestTag/Stack" = local.name } }

  # Production's EC2 resources, by type: each tagged Stack=konjir-test (deploy/terraform's
  # default_tags), as all of production's are.
  own_ec2 = [for t in ["vpc", "internet-gateway", "subnet", "route-table", "security-group", "instance", "volume", "elastic-ip"] : "${local.ec2}:${t}/*"]

  # The create calls the modules make, which tag what they create in the same call.
  ec2_creates = ["RunInstances", "CreateVolume", "CreateVpc", "CreateInternetGateway", "CreateSubnet", "CreateRouteTable", "CreateSecurityGroup", "AllocateAddress", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "CreateSnapshot"]

  # The install's document (below), the only one the role may associate.
  install_document = "${local.name}-install-release"
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

# ---- Which certificate authorities may issue for konjir.com

# Only Amazon (ACM: the marketing site's certificate) and Let's Encrypt (Caddy's certificate for
# kolab.konjir.com, which Let's Encrypt issues today) may issue for konjir.com and every name under
# it. Caddy's fallback to ZeroSSL is refused, and so is any other CA, so a TXT record CI could
# write proves nothing to one. Here, in Lee's own stack, because the deploy role can't change CAA.
resource "aws_route53_record" "caa" {
  zone_id = local.zone_id
  name    = local.zone
  type    = "CAA"
  ttl     = 3600
  records = ["0 issue \"amazon.com\"", "0 issue \"letsencrypt.org\"", "0 issuewild \";\""]
}

# ---- The install's SSM document

# What deploy/terraform's release module runs on production's instance to install a release: the
# boot script's konjir-update, and nothing else. Its one parameter is the release id, a hex tree id,
# so no command can be passed through it; a new id is what makes the association run again. The
# deploy role may associate only this document, never AWS-RunShellScript.
resource "aws_ssm_document" "install" {
  name            = local.install_document
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Install a Kolab release on its instance: wait for first boot, then konjir-update (W2.23)"
    parameters = {
      release = {
        type           = "String"
        description    = "The release id: the tree id deploy/release/pack.sh printed"
        allowedPattern = "^[0-9a-f]{40}([0-9a-f]{24})?$"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "install"
      inputs = {
        timeoutSeconds = "1800"
        runCommand = [
          "cloud-init status --wait >/dev/null || true",
          "echo 'Installing release {{ release }}'",
          "/usr/local/bin/konjir-update",
        ]
      }
    }]
  })
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
        Resource  = data.aws_kms_alias.managed["ssm"].target_key_arn
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
# expired; nothing copied or shared, and no tag set on any snapshot but its own.
#
# It has no deny like the instance boundary's OnlyFromAnInstance: Data Lifecycle Manager calls EC2
# with this role's own credentials (CloudTrail: invokedBy dlm.amazonaws.com), and no condition key
# tells those calls from the same credentials used elsewhere, so such a deny would stop the backups.
# A trust to anyone else can't be planted instead: the deploy role can't create or delete a role,
# or change a trust, and Lee's applies set this one to dlm.amazonaws.com only.
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
        Action   = ["ec2:CreateSnapshot", "ec2:CreateSnapshots"]
        Resource = local.snapshots
      },
      # Tags as a snapshot is made (Data Lifecycle Manager copies the volume's, Stack included), and
      # later only on a snapshot that already has Stack=konjir-test (it adds dlm:managed after).
      {
        Sid       = "TagNewSnapshots"
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = local.snapshots
        Condition = { StringEquals = { "ec2:CreateAction" = ["CreateSnapshot", "CreateSnapshots"] } }
      },
      {
        Sid       = "TagOwnSnapshots"
        Effect    = "Allow"
        Action    = ["ec2:CreateTags"]
        Resource  = local.snapshots
        Condition = local.own_stack
      },
      # So no other snapshot can be made its own by a Stack tag, and none of its own made another's.
      {
        Sid       = "NeverMoveStack"
        Effect    = "Deny"
        Action    = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "aws:TagKeys" = ["Stack"] }, Null = { "ec2:CreateAction" = "true" } }
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
          "ec2:Describe*", "ec2:GetDefaultCreditSpecification", "ec2:GetInstanceMetadataDefaults",
          "ec2:GetEbsEncryptionByDefault", "ec2:GetEbsDefaultKmsKeyId", "rds:Describe*", "rds:ListTagsForResource",
          "logs:Describe*", "logs:ListTagsForResource", "logs:ListTagsLogGroup", "cloudwatch:DescribeAlarms",
          "cloudwatch:ListTagsForResource", "sns:GetTopicAttributes", "sns:ListTagsForResource",
          "sns:GetSubscriptionAttributes", "sns:ListSubscriptionsByTopic", "route53:Get*", "route53:List*",
          "dlm:Get*", "dlm:List*", "ssm:DescribeParameters", "ssm:DescribeAssociation",
          "ssm:DescribeAssociationExecutions", "ssm:DescribeAssociationExecutionTargets", "ssm:ListAssociations",
          "ssm:ListAssociationVersions", "ssm:ListTagsForResource", "ssm:DescribeDocument", "ssm:GetDocument",
          "ssm:DescribeInstanceInformation", "cloudfront:Get*", "cloudfront:List*", "cloudfront:DescribeFunction",
          "acm:DescribeCertificate", "acm:ListCertificates", "acm:ListTagsForCertificate", "acm:GetCertificate",
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
        Resource  = data.aws_kms_alias.managed["ssm"].target_key_arn
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

# ---- What it may change in EC2: only what is tagged as production's, or created so

resource "aws_iam_policy" "ec2" {
  name        = "konjir-deploy-production-ec2"
  path        = "/konjir/"
  description = "Apply Kolab's production: its EC2 resources, by their Stack tag (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Creates, each only with Stack=konjir-test on what it makes. The parent each needs (a VPC, a
      # subnet, a security group) must be production's too (OwnResources).
      {
        Sid       = "CreateVpcTagged"
        Effect    = "Allow"
        Action    = ["ec2:CreateVpc"]
        Resource  = "${local.ec2}:vpc/*"
        Condition = local.tagged_new
      },
      {
        Sid       = "CreateInVpcTagged"
        Effect    = "Allow"
        Action    = ["ec2:CreateInternetGateway", "ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup"]
        Resource  = [for t in ["internet-gateway", "subnet", "route-table", "security-group"] : "${local.ec2}:${t}/*"]
        Condition = local.tagged_new
      },
      # No snapshot resource: a volume is never made from a snapshot, so no snapshot can be read so.
      {
        Sid       = "LaunchTagged"
        Effect    = "Allow"
        Action    = ["ec2:RunInstances", "ec2:CreateVolume", "ec2:AllocateAddress"]
        Resource  = [local.instances, local.volumes, "${local.ec2}:elastic-ip/*"]
        Condition = local.tagged_new
      },
      # What a launch or a rule uses besides production's own: the new network interface a launch
      # makes (in a subnet that must be production's), a rule, and Amazon's own image.
      {
        Sid      = "LaunchParts"
        Effect   = "Allow"
        Action   = ["ec2:RunInstances", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:ModifySecurityGroupRules"]
        Resource = ["${local.ec2}:network-interface/*", "${local.ec2}:security-group-rule/*"]
      },
      # An address goes only to a network interface in production's VPC. Network interfaces aren't
      # tagged (a launch doesn't tag the one it makes), so the VPC is what makes one production's.
      {
        Sid       = "AddressToOwnInterface"
        Effect    = "Allow"
        Action    = ["ec2:AssociateAddress", "ec2:DisassociateAddress"]
        Resource  = "${local.ec2}:network-interface/*"
        Condition = { StringEquals = { "ec2:Vpc" = data.aws_vpc.production.arn } }
      },
      {
        Sid       = "AmazonImages"
        Effect    = "Allow"
        Action    = ["ec2:RunInstances"]
        Resource  = "arn:${local.p}:ec2:${local.r}::image/*"
        Condition = { StringEquals = { "ec2:Owner" = "amazon" } }
      },
      # Everything else, only on resources already tagged Stack=konjir-test. CreateSnapshot is for
      # the data volume's final snapshot, when an allowed plan deletes it.
      {
        Sid    = "OwnResources"
        Effect = "Allow"
        Action = [for a in [
          "CreateSubnet", "CreateRouteTable", "CreateSecurityGroup", "RunInstances", "DeleteVpc", "ModifyVpcAttribute",
          "AttachInternetGateway", "DetachInternetGateway", "DeleteInternetGateway", "DeleteSubnet", "ModifySubnetAttribute",
          "DeleteRouteTable", "CreateRoute", "DeleteRoute", "ReplaceRoute", "AssociateRouteTable", "DisassociateRouteTable",
          "DeleteSecurityGroup", "AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupIngress",
          "RevokeSecurityGroupEgress", "ModifySecurityGroupRules", "UpdateSecurityGroupRuleDescriptionsIngress",
          "UpdateSecurityGroupRuleDescriptionsEgress", "TerminateInstances", "StopInstances", "StartInstances",
          "ModifyInstanceAttribute", "ModifyInstanceMetadataOptions", "ModifyInstanceCreditSpecification",
          "AssociateIamInstanceProfile", "ReplaceIamInstanceProfileAssociation", "DeleteVolume", "ModifyVolume",
          "AttachVolume", "DetachVolume", "CreateSnapshot", "ReleaseAddress", "AssociateAddress", "DisassociateAddress",
          "CreateTags", "DeleteTags",
        ] : "ec2:${a}"]
        Resource  = local.own_ec2
        Condition = local.own_stack
      },
      {
        Sid      = "SnapshotOfOwnVolume"
        Effect   = "Allow"
        Action   = ["ec2:CreateSnapshot"]
        Resource = local.snapshots
      },
      # Tags set in the same call that creates, which the creates above allow only on production's.
      {
        Sid      = "TagWhatItCreates"
        Effect   = "Allow"
        Action   = ["ec2:CreateTags"]
        Resource = "*"
        Condition = {
          StringEquals = { "ec2:CreateAction" = local.ec2_creates, "aws:RequestedRegion" = local.r }
        }
      },
      # The Stack tag is set only as a resource is created, never added to or removed from one that
      # exists, so nothing can be made production's, or made another's, by its tags.
      {
        Sid       = "NeverMoveStack"
        Effect    = "Deny"
        Action    = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "aws:TagKeys" = ["Stack"] }, Null = { "ec2:CreateAction" = "true" } }
      },
      # DeleteTags that names no keys deletes every tag, Stack included.
      {
        Sid       = "NeverDeleteAllTags"
        Effect    = "Deny"
        Action    = ["ec2:DeleteTags"]
        Resource  = "*"
        Condition = { Null = { "aws:TagKeys" = "true" } }
      },
      # A backstop to OwnResources: no change to an EC2 resource that isn't tagged as production's.
      {
        Sid    = "NotOthers"
        Effect = "Deny"
        Action = [for a in [
          "DeleteVpc", "ModifyVpcAttribute", "AttachInternetGateway", "DetachInternetGateway", "DeleteInternetGateway",
          "DeleteSubnet", "ModifySubnetAttribute", "DeleteRouteTable", "CreateRoute", "DeleteRoute", "ReplaceRoute",
          "AssociateRouteTable", "DisassociateRouteTable", "DeleteSecurityGroup", "RevokeSecurityGroupIngress",
          "RevokeSecurityGroupEgress", "TerminateInstances", "StopInstances", "StartInstances", "ModifyInstanceAttribute",
          "ModifyInstanceMetadataOptions", "DeleteVolume", "ModifyVolume", "AttachVolume", "DetachVolume",
          "ReleaseAddress", "AssociateAddress", "DisassociateAddress", "DeleteTags",
        ] : "ec2:${a}"]
        Resource  = local.own_ec2
        Condition = { StringNotEquals = { "aws:ResourceTag/Stack" = local.name } }
      },
    ]
  })
}

# ---- What it may change elsewhere: production's resources

resource "aws_iam_policy" "write" {
  name        = "konjir-deploy-production-write"
  path        = "/konjir/"
  description = "Apply Kolab's production: change its resources (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "OwnDatabase"
        Effect    = "Allow"
        Action    = ["rds:CreateDBInstance", "rds:ModifyDBInstance", "rds:DeleteDBInstance", "rds:CreateDBSnapshot", "rds:AddTagsToResource", "rds:RemoveTagsFromResource", "rds:CreateDBSubnetGroup", "rds:ModifyDBSubnetGroup", "rds:DeleteDBSubnetGroup"]
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
      # The release's install: an association of the install document above, and no other, on
      # production's instance. Associations have only ids in their ARNs, so they are production's by
      # their Stack tag: created with it, and changed or deleted only while they have it.
      {
        Sid      = "InstallDocument"
        Effect   = "Allow"
        Action   = ["ssm:CreateAssociation", "ssm:UpdateAssociation"]
        Resource = aws_ssm_document.install.arn
      },
      {
        Sid       = "CreateTaggedAssociation"
        Effect    = "Allow"
        Action    = ["ssm:CreateAssociation", "ssm:AddTagsToResource"]
        Resource  = "arn:${local.p}:ssm:${local.r}:${local.a}:association/*"
        Condition = local.tagged_new
      },
      {
        Sid       = "OwnAssociation"
        Effect    = "Allow"
        Action    = ["ssm:UpdateAssociation", "ssm:DeleteAssociation", "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource"]
        Resource  = "arn:${local.p}:ssm:${local.r}:${local.a}:association/*"
        Condition = local.own_stack
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
      # In the konjir.com zone only, each name only with the types production gives it. Never MX, NS
      # or CAA (the CAA record below is Lee's), and no _acme-challenge or other proof of control:
      # - A and AAAA: kolab.konjir.com, and the marketing site's apex and www aliases;
      # - CNAME: ACM's validation records, _<32 hex>.konjir.com and _<32 hex>.www.konjir.com;
      # - TXT: _dmarc, and the apex, which holds the site module's SPF record (v=spf1 -all). Moving
      #   SPF out of the site module would free the apex of TXT; until then CI can rewrite it.
      {
        Sid      = "OwnAddressRecords"
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:${local.p}:route53:::hostedzone/${local.zone_id}"
        Condition = {
          "ForAllValues:StringEquals" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [local.domain, local.zone, "www.${local.zone}"]
            "route53:ChangeResourceRecordSetsRecordTypes"           = ["A", "AAAA"]
          }
        }
      },
      {
        Sid      = "CertificateValidationRecords"
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:${local.p}:route53:::hostedzone/${local.zone_id}"
        Condition = {
          "ForAllValues:StringLike"   = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = ["_${local.acm_label}.${local.zone}", "_${local.acm_label}.www.${local.zone}"] }
          "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsRecordTypes" = ["CNAME"] }
        }
      },
      {
        Sid      = "MailPolicyRecords"
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:${local.p}:route53:::hostedzone/${local.zone_id}"
        Condition = {
          "ForAllValues:StringEquals" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [local.zone, "_dmarc.${local.zone}"]
            "route53:ChangeResourceRecordSetsRecordTypes"           = ["TXT"]
          }
        }
      },
      # Health checks have no names to scope by, so this reaches any in the account: there are none
      # but production's today. Another project's would be reachable; deny its id here if one appears.
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
        Condition = local.tagged_new
      },
      {
        Sid       = "ChangeOwnSchedule"
        Effect    = "Allow"
        Action    = ["dlm:UpdateLifecyclePolicy", "dlm:DeleteLifecyclePolicy", "dlm:UntagResource"]
        Resource  = "*"
        Condition = local.own_stack
      },
      # Encrypted volumes, database and SecureStrings: the AWS-managed keys only, through their services.
      {
        Sid       = "ManagedKeys"
        Effect    = "Allow"
        Action    = ["kms:CreateGrant", "kms:DescribeKey", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"]
        Resource  = local.managed_keys
        Condition = { StringEquals = { "kms:ViaService" = ["ec2.${local.r}.amazonaws.com", "rds.${local.r}.amazonaws.com", "ssm.${local.r}.amazonaws.com"] } }
      },
    ]
  })
}

# ---- The marketing site (D81): CloudFront and its certificate, by tag

# Distributions, functions and certificates are created only tagged Stack=konjir-test, and changed
# or deleted only while they are. Functions are also limited to production's names. Origin access
# controls and response headers policies have neither tags nor names in their ARNs: there are none
# but production's in the account today. Other projects' distributions and certificates are denied
# by ARN (other_projects_site_arns), since a create's tagging (TagResource, AddTagsToCertificate,
# which a create with tags needs) can't be told from tagging one that exists without a Stack tag.
resource "aws_iam_policy" "site" {
  name        = "konjir-deploy-production-site"
  path        = "/konjir/"
  description = "Apply Kolab's production: the marketing site's CloudFront and certificate, by tag (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CreateTagged"
        Effect    = "Allow"
        Action    = ["cloudfront:CreateDistribution", "cloudfront:CreateFunction", "cloudfront:TagResource"]
        Resource  = "*"
        Condition = local.tagged_new
      },
      {
        Sid       = "ChangeOwnDistribution"
        Effect    = "Allow"
        Action    = ["cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", "cloudfront:TagResource", "cloudfront:UntagResource"]
        Resource  = "arn:${local.p}:cloudfront::${local.a}:distribution/*"
        Condition = local.own_stack
      },
      {
        Sid       = "ChangeOwnFunctions"
        Effect    = "Allow"
        Action    = ["cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction", "cloudfront:TagResource", "cloudfront:UntagResource"]
        Resource  = local.functions
        Condition = local.own_stack
      },
      {
        Sid    = "OriginAccessAndHeaders"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateOriginAccessControl", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl",
          "cloudfront:CreateResponseHeadersPolicy", "cloudfront:UpdateResponseHeadersPolicy", "cloudfront:DeleteResponseHeadersPolicy",
        ]
        Resource = "*"
      },
      # konjir.com and www.konjir.com only.
      {
        Sid      = "RequestTaggedCertificate"
        Effect   = "Allow"
        Action   = ["acm:RequestCertificate"]
        Resource = "*"
        Condition = {
          StringEquals                = { "aws:RequestTag/Stack" = local.name }
          "ForAllValues:StringEquals" = { "acm:DomainNames" = [local.zone, "www.${local.zone}"] }
        }
      },
      {
        Sid       = "TagCertificateAsRequested"
        Effect    = "Allow"
        Action    = ["acm:AddTagsToCertificate"]
        Resource  = "arn:${local.p}:acm:${local.r}:${local.a}:certificate/*"
        Condition = local.tagged_new
      },
      {
        Sid       = "ChangeOwnCertificate"
        Effect    = "Allow"
        Action    = ["acm:DeleteCertificate", "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate"]
        Resource  = "arn:${local.p}:acm:${local.r}:${local.a}:certificate/*"
        Condition = local.own_stack
      },
      # Backstops. Nothing of another project's, by ARN; no change to a distribution, function or
      # certificate not tagged as production's; and no tag on one tagged as another stack's.
      {
        Sid      = "NotOtherProjects"
        Effect   = "Deny"
        Action   = ["cloudfront:*", "acm:*"]
        Resource = var.other_projects_site_arns
      },
      {
        Sid    = "NotUntagged"
        Effect = "Deny"
        Action = [
          "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", "cloudfront:UntagResource",
          "cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction",
          "acm:DeleteCertificate", "acm:RemoveTagsFromCertificate",
        ]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:ResourceTag/Stack" = local.name } }
      },
      {
        Sid       = "NotAnotherStacks"
        Effect    = "Deny"
        Action    = ["cloudfront:TagResource", "acm:AddTagsToCertificate"]
        Resource  = "*"
        Condition = { Null = { "aws:ResourceTag/Stack" = "false" }, StringNotEquals = { "aws:ResourceTag/Stack" = local.name } }
      },
    ]
  })
}

# ---- What it may do in IAM: production's two roles as they are, each only inside its boundary

resource "aws_iam_policy" "roles" {
  name        = "konjir-deploy-production-roles"
  path        = "/konjir/"
  description = "Apply Kolab's production: its instance and snapshot roles, only with their boundaries (W2.23)"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # No CreateRole, DeleteRole or UpdateAssumeRolePolicy: a role's trust is set only by Lee.
      {
        Sid       = "InstanceRoleWithItsBoundary"
        Effect    = "Allow"
        Action    = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PutRolePermissionsBoundary"]
        Resource  = local.kolab_roles
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.instance_boundary.arn } }
      },
      {
        Sid       = "SnapshotRoleWithItsBoundary"
        Effect    = "Allow"
        Action    = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PutRolePermissionsBoundary"]
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
      {
        Sid      = "OwnRolesAndProfile"
        Effect   = "Allow"
        Action   = ["iam:TagRole", "iam:UntagRole", "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile", "iam:UntagInstanceProfile"]
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
        Sid      = "KeepTheBoundariesAndTrusts"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary", "iam:CreateRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy"]
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
          "${local.issuer}:aud"                 = "sts.amazonaws.com"
          "${local.issuer}:sub"                 = local.subject
          "${local.issuer}:repository_id"       = var.github_repository_id
          "${local.issuer}:repository_owner_id" = var.github_owner_id
          "${local.issuer}:job_workflow_ref"    = local.workflow_ref
          "${local.issuer}:ref"                 = "refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "deploy" {
  for_each = {
    read  = aws_iam_policy.read.arn
    ec2   = aws_iam_policy.ec2.arn
    write = aws_iam_policy.write.arn
    site  = aws_iam_policy.site.arn
    roles = aws_iam_policy.roles.arn
  }
  role       = aws_iam_role.deploy.name
  policy_arn = each.value
}
