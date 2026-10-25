# A fixture for tests/site_files.tftest.hcl: the site module on the repository's own site/, with
# both its providers configured here, where the test mocks them. (A run whose module is
# modules/site itself fails terraform validate, which can't wire its us_east_1 alias.)
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

variable "site_dir" {
  description = "The directory whose files are published, from deploy/terraform, where tests run."
  type        = string
  default     = "../../site"
}

module "site" {
  source = "../../modules/site"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name        = "konjir-test"
  zone_id     = "Z0000000000000"
  domain_name = "konjir.com"
  site_dir    = var.site_dir
}

output "files" { value = module.site.files }
output "objects" { value = module.site.objects }
