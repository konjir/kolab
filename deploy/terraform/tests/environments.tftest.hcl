# Applies each environment offline, against mocked providers, so CI checks what one configuration
# makes of production and of staging without AWS credentials (W2.23). Nothing reaches AWS. Run from
# deploy/terraform:
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
}

# Applied (to the mocks), not planned: the release module's check reads /healthz only after apply.
run "production_keeps_its_names_and_state" {
  variables {
    environment = "production"
  }

  assert {
    condition     = output.name == "konjir-test"
    error_message = "production's resources must keep the prefix konjir-test, or every one is replaced"
  }
  assert {
    condition     = output.site == "https://kolab.konjir.com"
    error_message = "production is kolab.konjir.com"
  }
  assert {
    condition     = output.state_key == "konjir/test/terraform.tfstate"
    error_message = "production's state must stay at its key"
  }
  assert {
    condition     = strcontains(file("environments/production.s3.tfbackend"), "key = \"${output.state_key}\"")
    error_message = "environments/production.s3.tfbackend must give init production's state key"
  }
  assert {
    condition     = output.admin_token_parameter == "/konjir/konjir-test/admin-token"
    error_message = "production's SSM parameters are under /konjir/konjir-test/"
  }
  assert {
    condition     = output.release == "0123456789abcdef0123456789abcdef01234567"
    error_message = "the release is the one CI built"
  }
}

run "staging_is_its_own" {
  variables {
    environment = "staging"
  }

  assert {
    condition     = output.name == "konjir-staging"
    error_message = "staging's resources are named konjir-staging-*"
  }
  assert {
    condition     = output.site == "https://staging.kolab.konjir.com"
    error_message = "staging is staging.kolab.konjir.com"
  }
  assert {
    condition     = output.state_key == "konjir/staging/terraform.tfstate"
    error_message = "staging's state has a key of its own"
  }
  assert {
    condition     = strcontains(file("environments/staging.s3.tfbackend"), "key = \"${output.state_key}\"")
    error_message = "environments/staging.s3.tfbackend must give init staging's state key"
  }
  assert {
    condition     = output.admin_token_parameter == "/konjir/konjir-staging/admin-token"
    error_message = "staging's SSM parameters are under /konjir/konjir-staging/"
  }
  assert {
    condition     = output.log_group == "/konjir/konjir-staging"
    error_message = "staging logs to a group of its own"
  }
}

run "an_unknown_environment_is_refused" {
  command = plan
  variables {
    environment = "prod"
  }
  expect_failures = [var.environment]
}
