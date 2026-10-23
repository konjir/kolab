# Applies the configuration offline, against mocked providers, so CI checks what it makes of
# production without AWS credentials (W2.23). Nothing reaches AWS. Run from deploy/terraform:
#   terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "us-east-1", name = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "747533038441" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  # ARNs other resources check the form of.
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:747533038441:mock-alarms" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::747533038441:role/mock" }
  }
}
mock_provider "aws" {
  alias = "us_east_1"
}
mock_provider "random" {}
mock_provider "external" {}
mock_provider "http" {
  mock_data "http" {
    defaults = { status_code = 200 }
  }
}

# The release CI builds (deploy.yml), so nothing runs pack.sh.
variables {
  release_zip = "/tmp/konjir-release.zip"
  release_id  = "0123456789abcdef0123456789abcdef01234567"
  # The marketing site's certificate can't be mocked through an apply (its validation records are
  # keyed by values the mock invents twice); production's own plan in CI covers it.
  site_enabled = false
}

# Applied (to the mocks), not planned: the release module's check reads /healthz only after apply.
run "production_keeps_its_names" {
  assert {
    condition     = output.url == "https://kolab.konjir.com/mcp"
    error_message = "production is kolab.konjir.com"
  }
  assert {
    condition     = output.admin_token_parameter == "/konjir/konjir-test/admin-token"
    error_message = "production's resources must keep the prefix konjir-test, or every one is replaced"
  }
  assert {
    condition     = output.log_group == "/konjir/konjir-test"
    error_message = "production's log group is /konjir/konjir-test"
  }
  assert {
    condition     = output.release == "0123456789abcdef0123456789abcdef01234567"
    error_message = "the release is the one CI built"
  }
  # The install runs github-oidc's fixed document, which the deploy role may associate, and no other.
  assert {
    condition     = module.release.install.document == "konjir-test-install-release" && module.release.install.parameters == tomap({ release = "0123456789abcdef0123456789abcdef01234567" })
    error_message = "the install is the konjir-test-install-release document, given only the release id"
  }
  assert {
    condition     = module.database.deletion_protection
    error_message = "production's database keeps deletion protection on"
  }
  # The state key and the names it holds resources under go together.
  assert {
    condition     = output.admin_token_parameter != null && strcontains(file("environments/production.s3.tfbackend"), "key = \"konjir/test/terraform.tfstate\"")
    error_message = "production's state must stay at konjir/test/terraform.tfstate"
  }
}
