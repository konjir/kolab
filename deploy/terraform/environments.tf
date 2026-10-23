# Two Kolabs from this one configuration (D73, W2.23): production and staging, listed in
# modules/environments. Each has its own state, under its own key in s3://konjir-terraform
# (environments/<environment>.s3.tfbackend), and its own name prefix, so its own instance,
# database, release bucket, SSM parameters, log group, alarms and DNS record.
#
# .github/workflows/deploy.yml applies staging on every merge to main, then production once Lee
# approves the run in the production GitHub environment. Locally, deploy/konjir-ops.sh --env <env>
# terraform … runs Terraform against either one.

variable "environment" {
  description = "Which Kolab this state is: production or staging (D73). It must match the backend key init was given: environments/<environment>.s3.tfbackend."
  type        = string

  validation {
    condition     = contains(["production", "staging"], var.environment)
    error_message = "environment is production or staging."
  }
}

module "environments" {
  source = "./modules/environments"
}

locals {
  env  = module.environments.all[var.environment]
  name = local.env.name

  # A variable set by hand (-var) wins over the environment's value.
  instance_type             = coalesce(var.instance_type, local.env.instance_type)
  data_volume_gib           = coalesce(var.data_volume_gib, local.env.data_volume_gib)
  db_instance_class         = coalesce(var.db_instance_class, local.env.db_instance_class)
  db_allocated_gib          = coalesce(var.db_allocated_gib, local.env.db_allocated_gib)
  final_snapshot_on_destroy = var.final_snapshot_on_destroy == null ? local.env.final_snapshot_on_destroy : var.final_snapshot_on_destroy

  # Every IAM role this configuration creates carries this permissions boundary, which
  # deploy/terraform/github-oidc creates. The deploy roles may create or change a role only with
  # it, so no role made from CI can hold more than it allows (README: Deploying from CI).
  permissions_boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/konjir/${local.name}-boundary"
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
