# Where Kolab's code and data live.
#  - artifact bucket: releases shipped by the release module (emptied and removed on destroy)
#  - data volume: Kolab's database, separate from the instance so the instance can be replaced
#  - daily snapshots of the data volume, kept 7 days

variable "name" { type = string }
variable "az" { type = string }
variable "data_gib" { type = number }
variable "final_snapshot" { type = bool }

resource "aws_s3_bucket" "artifacts" {
  #checkov:skip=CKV_AWS_18:Release artifacts only; access logging not needed for a test environment
  #checkov:skip=CKV_AWS_144:Releases are rebuildable from source; no replication
  #checkov:skip=CKV_AWS_145:SSE-S3 is sufficient for release artifacts
  #checkov:skip=CKV2_AWS_62:Nothing consumes bucket events
  bucket_prefix = "${var.name}-artifacts-"
  force_destroy = true # releases are rebuildable; teardown shouldn't need a manual empty
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-old-releases"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "artifacts_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket     = aws_s3_bucket.artifacts.id
  policy     = data.aws_iam_policy_document.artifacts_tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

resource "aws_ebs_volume" "data" {
  #checkov:skip=CKV_AWS_189:Encrypted with the AWS-managed EBS key; a customer-managed key is a production step
  availability_zone = var.az
  size              = var.data_gib
  type              = "gp3"
  encrypted         = true
  final_snapshot    = var.final_snapshot
  tags = {
    Name          = "${var.name}-data"
    konjir-backup = var.name
  }
}

data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name_prefix        = "${var.name}-dlm-"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "daily" {
  description        = "Daily snapshots of ${var.name} data kept 7 days"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { konjir-backup = var.name }

    schedule {
      name      = "daily"
      copy_tags = true
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["08:00"]
      }
      retain_rule { count = 7 }
    }
  }
}

output "artifact_bucket" { value = aws_s3_bucket.artifacts.id }
output "artifact_bucket_arn" { value = aws_s3_bucket.artifacts.arn }
output "data_volume_id" { value = aws_ebs_volume.data.id }
