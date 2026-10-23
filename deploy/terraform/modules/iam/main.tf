# The Kolab instance's role: Systems Manager access (no SSH), read its releases, admin token and database URL,
# and the GitHub OAuth app's client id and the secret Lee puts by hand, by name (D55). Both
# SecureStrings use the AWS-managed SSM key, whose key policy lets the account's principals decrypt
# through SSM, so no KMS statement is needed (the admin token reads the same way).
# The CloudWatch agent (P11, D68) may write Kolab's log group and put metrics in its one namespace,
# and nothing more: no other log group, no namespace of anyone else's.
# Nothing else: Kolab makes no model calls (REV5), so it has no Bedrock access.

variable "name" { type = string }
variable "artifact_bucket_arn" { type = string }
variable "admin_token_param_arn" { type = string }
variable "database_url_param_arn" { type = string }
variable "github_param_arns" {
  type    = list(string)
  default = []
}

variable "cli_npm_spec_param_arn" {
  type    = string
  default = ""
}

variable "log_group_arn" { type = string }
variable "metrics_namespace" { type = string }

# The permissions boundary deploy/terraform/github-oidc makes for this environment (W2.23). The
# deploy roles may create or change a role only with it attached, so a role made from CI can't
# hold more than it allows, whatever its own policy says.
variable "permissions_boundary_arn" { type = string }

data "aws_partition" "current" {}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "kolab" {
  name_prefix          = "${var.name}-kolab-"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.kolab.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "kolab" {
  statement {
    sid       = "ReadReleases"
    actions   = ["s3:GetObject"]
    resources = ["${var.artifact_bucket_arn}/releases/*"]
  }
  statement {
    sid       = "ListReleases"
    actions   = ["s3:ListBucket"]
    resources = [var.artifact_bucket_arn]
  }
  statement {
    sid       = "ReadAdminTokenAndDatabaseUrl"
    actions   = ["ssm:GetParameter"]
    resources = concat([var.admin_token_param_arn, var.database_url_param_arn], var.github_param_arns, compact([var.cli_npm_spec_param_arn]))
  }
  # The CloudWatch agent ships the journal's copies into streams of Kolab's log group. Terraform
  # creates the group and sets its retention, so the agent may neither.
  statement {
    sid       = "ShipLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = [var.log_group_arn, "${var.log_group_arn}:*"]
  }
  # PutMetricData has no resource; its namespace condition is how it is scoped.
  statement {
    sid       = "PutMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.metrics_namespace]
    }
  }
}

resource "aws_iam_role_policy" "kolab" {
  name   = "konjir-kolab"
  role   = aws_iam_role.kolab.id
  policy = data.aws_iam_policy_document.kolab.json
}

resource "aws_iam_instance_profile" "kolab" {
  name_prefix = "${var.name}-kolab-"
  role        = aws_iam_role.kolab.name
}

output "instance_profile_name" { value = aws_iam_instance_profile.kolab.name }
output "role_arn" { value = aws_iam_role.kolab.arn }

# Renamed from "hub" on 2026-10-11 (Decisions Log D11).
moved {
  from = aws_iam_role.hub
  to   = aws_iam_role.kolab
}
moved {
  from = aws_iam_role_policy.hub
  to   = aws_iam_role_policy.kolab
}
moved {
  from = aws_iam_instance_profile.hub
  to   = aws_iam_instance_profile.kolab
}
