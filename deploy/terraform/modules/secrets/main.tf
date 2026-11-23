# Kolab's break-glass admin token (W2.22, D69): an SSM SecureString, /konjir/<name>/admin-token,
# that Terraform names but never holds. deploy/konjir-ops.sh rotate-admin-token writes it, with a
# fresh value, and restarts Kolab; the value is in no Terraform variable, file or state, like the
# GitHub app's secret. Admins are people who sign in: the token is for bootstrapping the first
# admin and for emergencies. Until W2.22 Terraform generated it, so it was in the state; the
# root module's `removed` blocks let Terraform forget it without deleting the parameter, and the
# first rotation after that makes the value the state still holds worthless.

variable "name" { type = string }

# The GitHub OAuth app people sign in with (D55). Its client id is public, so Terraform keeps
# it as a String parameter. Its client secret is never Terraform's: Lee puts it himself as the
# SecureString /konjir/<name>/github-client-secret (README, "Deploying to AWS"), so it is in no
# Terraform variable, file or state. The instance may read it by that name.
variable "github_client_id" {
  type    = string
  default = ""
}

# The published kolab CLI's npm spec, pinned to an exact version (W3.7). The release's start.sh
# reads it as KONJIR_CLI_NPM_SPEC, so the web page shows npx commands for it. Empty: no parameter.
variable "cli_npm_spec" {
  type    = string
  default = ""
}

# Sign in with Apple (Lee, 2026-11-23): the Services ID, the team id and the key id, none of them
# secret, each a String parameter when given, /konjir/<name>/apple-signin-<what>. The key's private
# key is never Terraform's: Lee puts it himself as the SecureString
# /konjir/<name>/apple-signin-private-key (README, "Deploying to AWS"), as he does GitHub's secret.
variable "apple_signin_services_id" {
  type    = string
  default = ""
}

variable "apple_signin_team_id" {
  type    = string
  default = ""
}

variable "apple_signin_key_id" {
  type    = string
  default = ""
}

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  github_client_secret_name     = "/konjir/${var.name}/github-client-secret"
  admin_token_name              = "/konjir/${var.name}/admin-token"
  apple_signin_private_key_name = "/konjir/${var.name}/apple-signin-private-key"
  # Only those given are made.
  apple_signin = { for k, v in {
    services-id = var.apple_signin_services_id
    team-id     = var.apple_signin_team_id
    key-id      = var.apple_signin_key_id
  } : k => v if v != "" }
}

# Read by name, whether or not the parameter exists yet: a new stack's Kolab starts once
# rotate-admin-token has written it.
output "admin_token_param_name" { value = local.admin_token_name }
output "admin_token_param_arn" {
  value = "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.admin_token_name}"
}

resource "aws_ssm_parameter" "github_client_id" {
  count       = var.github_client_id == "" ? 0 : 1
  name        = "/konjir/${var.name}/github-client-id"
  description = "Client id of the GitHub OAuth app Kolab signs people in with (D55)"
  type        = "String"
  value       = var.github_client_id
}

# Kolab's start script finds them beside the admin token: /konjir/<name>/github-client-id, and the
# secret Lee puts by hand, named here by its ARN whether or not it exists yet.
output "github_param_arns" {
  value = concat(aws_ssm_parameter.github_client_id[*].arn, [
    "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.github_client_secret_name}",
  ])
}

output "github_client_secret_param_name" { value = local.github_client_secret_name }

resource "aws_ssm_parameter" "apple_signin" {
  for_each    = local.apple_signin
  name        = "/konjir/${var.name}/apple-signin-${each.key}"
  description = "Sign in with Apple's ${each.key} for Kolab (not secret); the private key is apple-signin-private-key, which Lee puts by hand"
  type        = "String"
  value       = each.value
}

# Kolab's start script finds them beside the admin token, and the private key Lee puts by hand,
# named here by its ARN whether or not it exists yet.
output "apple_param_arns" {
  value = concat([for p in aws_ssm_parameter.apple_signin : p.arn], [
    "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.apple_signin_private_key_name}",
  ])
}

output "apple_signin_param_names" {
  value = { for k, p in aws_ssm_parameter.apple_signin : k => p.name }
}

output "apple_signin_private_key_param_name" { value = local.apple_signin_private_key_name }

resource "aws_ssm_parameter" "cli_npm_spec" {
  count       = var.cli_npm_spec == "" ? 0 : 1
  name        = "/konjir/${var.name}/cli-npm-spec"
  description = "The published kolab CLI's npm spec, pinned to an exact version, that Kolab's web page shows (W3.7)"
  type        = "String"
  value       = var.cli_npm_spec
}

# Read by name, like the GitHub app's secret, whether or not the parameter exists.
output "cli_npm_spec_param_arn" {
  value = "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/konjir/${var.name}/cli-npm-spec"
}

# Expo's access token, with which Kolab sends push notifications to konnect's phone app through
# Expo's push service (S4): the SecureString /konjir/<name>/expo-access-token. Terraform makes it
# with a placeholder, `unset`, as a write-only value (value_wo), so neither the placeholder nor the
# token Lee puts in its place is ever in a Terraform variable, file or state, and Terraform never
# writes it again while value_wo_version stays 1. Lee puts the token with put-parameter --overwrite
# (README, "Deploying to AWS"). Until then start.sh reads `unset` as no token, and Kolab runs with
# push off, saying so in one line.
resource "aws_ssm_parameter" "expo_access_token" {
  #checkov:skip=CKV_AWS_337:SecureString with the AWS-managed SSM key; a customer-managed key is a production step
  name             = "/konjir/${var.name}/expo-access-token"
  description      = "Expo access token Kolab sends push notifications with (konnect's app); unset until Lee puts it"
  type             = "SecureString"
  value_wo         = "unset"
  value_wo_version = 1
}

output "expo_access_token_param_arn" { value = aws_ssm_parameter.expo_access_token.arn }
output "expo_access_token_param_name" { value = aws_ssm_parameter.expo_access_token.name }
