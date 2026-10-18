# The Kolab instance's role: Systems Manager access (no SSH), read its releases, admin token and database URL,
# and the GitHub OAuth app's client id and the secret Lee puts by hand, by name (D55). Both
# SecureStrings use the AWS-managed SSM key, whose key policy lets the account's principals decrypt
# through SSM, so no KMS statement is needed (the admin token reads the same way).
# Nothing else: Kolab makes no model calls (REV5), so it has no Bedrock access.

variable "name" { type = string }
variable "artifact_bucket_arn" { type = string }
variable "admin_token_param_arn" { type = string }
variable "database_url_param_arn" { type = string }
variable "github_param_arns" {
  type    = list(string)
  default = []
}

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
  name_prefix        = "${var.name}-kolab-"
  assume_role_policy = data.aws_iam_policy_document.assume.json
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
    resources = concat([var.admin_token_param_arn, var.database_url_param_arn], var.github_param_arns)
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
