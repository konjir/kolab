# State lives in the bucket created by deploy/bootstrap-state.sh.
# S3 native locking (use_lockfile) replaces the deprecated DynamoDB lock table.
terraform {
  backend "s3" {
    bucket       = "konjir-terraform"
    key          = "konjir/test/terraform.tfstate"
    region       = "us-east-1"
    profile      = "icedlee337"
    encrypt      = true
    use_lockfile = true
  }
}
