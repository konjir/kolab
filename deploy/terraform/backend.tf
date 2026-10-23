# State lives in the bucket created by deploy/bootstrap-state.sh. init takes the key from
# environments/production.s3.tfbackend, the one environment there is (D83: staging dropped for now):
#   terraform init -backend-config=environments/production.s3.tfbackend
# deploy/konjir-ops.sh terraform … and the deploy workflow do it for you. Credentials come from the
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
