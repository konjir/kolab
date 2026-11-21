terraform {
  required_version = ">= 1.15.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.58"
    }
  }

  # Its own state, apart from production's, which the deploy role can neither read nor write.
  backend "s3" {
    bucket       = "konjir-terraform"
    key          = "konjir/github-oidc/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "konjir"
      Stack     = "konjir-github-oidc"
      ManagedBy = "terraform"
    }
  }
}
