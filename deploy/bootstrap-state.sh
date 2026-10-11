#!/usr/bin/env bash
# One-time: create the S3 bucket that holds Konjir's Terraform state.
# Everything else is provisioned (and torn down) by Terraform in deploy/terraform.
#
#   deploy/bootstrap-state.sh
#
# Safe to re-run: it only creates the bucket if it's missing, then (re)applies the settings.
set -euo pipefail

BUCKET="${KONJIR_STATE_BUCKET:-konjir-terraform}"
export AWS_PROFILE="${AWS_PROFILE:-icedlee337}"
export AWS_REGION="us-east-1"
export AWS_PAGER=""

account="$(aws sts get-caller-identity --query Account --output text)" \
  || { echo "error: profile $AWS_PROFILE has no working credentials" >&2; exit 1; }
echo "Account $account, profile $AWS_PROFILE, region $AWS_REGION, bucket $BUCKET"

if aws s3api head-bucket --bucket "$BUCKET" --expected-bucket-owner "$account" 2>/dev/null; then
  echo "Bucket exists and belongs to this account; re-applying settings."
else
  # us-east-1 takes no LocationConstraint.
  if ! aws s3api create-bucket --bucket "$BUCKET" --object-ownership BucketOwnerEnforced >/dev/null; then
    echo "error: couldn't create $BUCKET. S3 names are global, so another account may own it." >&2
    echo "       Pick another name: KONJIR_STATE_BUCKET=<name> $0, and update deploy/terraform/backend.tf to match." >&2
    exit 1
  fi
  aws s3api wait bucket-exists --bucket "$BUCKET"
  echo "Created $BUCKET."
fi

# Versioning: every state write is recoverable (HashiCorp's recommendation for the S3 backend).
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
# Private, encrypted, TLS-only.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyInsecureTransport",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": ["arn:aws:s3:::$BUCKET", "arn:aws:s3:::$BUCKET/*"],
    "Condition": {"Bool": {"aws:SecureTransport": "false"}}
  }]
}
POLICY
)"
# Old state versions are kept 90 days, then expire.
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-old-state-versions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'

echo "Done. Next:"
echo "  cd deploy/terraform && terraform init && terraform apply"
