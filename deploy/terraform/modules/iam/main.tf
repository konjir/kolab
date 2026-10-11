# The hub instance's role: Systems Manager access (no SSH), read its releases and admin token,
# and call Bedrock for the review gate. Nothing else.

variable "name" { type = string }
variable "artifact_bucket_arn" { type = string }
variable "admin_token_param_arn" { type = string }

data "aws_caller_identity" "current" {}
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

resource "aws_iam_role" "hub" {
  name_prefix        = "${var.name}-hub-"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.hub.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "hub" {
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
    sid       = "ReadAdminToken"
    actions   = ["ssm:GetParameter"]
    resources = [var.admin_token_param_arn]
  }
  # Claude models on Bedrock (Messages API, served by bedrock-mantle).
  statement {
    sid       = "ReviewGateClaude"
    actions   = ["bedrock-mantle:CreateInference", "bedrock-mantle:GetModel", "bedrock-mantle:ListModels"]
    resources = ["arn:${data.aws_partition.current.partition}:bedrock-mantle:*:${data.aws_caller_identity.current.account_id}:project/*"]
  }
  # Other Bedrock models (e.g. Kimi) through the Converse API.
  statement {
    sid     = "ReviewGateOtherModels"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:*::foundation-model/*",
      "arn:${data.aws_partition.current.partition}:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
    ]
  }
  # Third-party models subscribe through Marketplace on first use, only when Bedrock asks.
  statement {
    sid       = "MarketplaceViaBedrock"
    actions   = ["aws-marketplace:Subscribe", "aws-marketplace:ViewSubscriptions"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:CalledViaLast"
      values   = ["bedrock-mantle.amazonaws.com", "bedrock.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "hub" {
  name   = "konjir-hub"
  role   = aws_iam_role.hub.id
  policy = data.aws_iam_policy_document.hub.json
}

resource "aws_iam_instance_profile" "hub" {
  name_prefix = "${var.name}-hub-"
  role        = aws_iam_role.hub.name
}

output "instance_profile_name" { value = aws_iam_instance_profile.hub.name }
output "role_arn" { value = aws_iam_role.hub.arn }
