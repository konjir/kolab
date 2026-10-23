# State lives in the bucket created by deploy/bootstrap-state.sh, one key per environment (D73):
# init takes the key from environments/<environment>.s3.tfbackend, as in
#   terraform init -backend-config=environments/staging.s3.tfbackend
# (deploy/konjir-ops.sh --env <env> terraform … does it for you). Credentials come from the
# environment: AWS_PROFILE=icedlee337 on Lee's machine, the OIDC role in CI.
# S3 native locking (use_lockfile) replaces the deprecated DynamoDB lock table.
terraform {
  backend "s3" {
    bucket       = "konjir-terraform"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
