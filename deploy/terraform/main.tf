provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "konjir"
      Stack     = local.name
      ManagedBy = "terraform"
    }
  }
}

# CloudFront takes certificates only from us-east-1, whatever var.region is.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "konjir"
      Stack     = var.name
      ManagedBy = "terraform"
    }
  }
}

data "aws_route53_zone" "this" {
  name         = var.zone_name
  private_zone = false
}

locals {
  az = var.availability_zone
}

module "network" {
  source = "./modules/network"
  name   = local.name
  az     = local.az
}

module "storage" {
  source         = "./modules/storage"
  name           = local.name
  az             = local.az
  data_gib       = local.data_volume_gib
  final_snapshot = local.final_snapshot_on_destroy

  permissions_boundary_arn = local.permissions_boundary_arn
}

module "secrets" {
  source           = "./modules/secrets"
  name             = local.name
  github_client_id = local.env.github_oauth_client_id
  cli_npm_spec     = var.cli_npm_spec
}

module "database" {
  source            = "./modules/database"
  name              = local.name
  subnet_ids        = module.network.db_subnet_ids
  security_group_id = module.network.db_security_group_id
  postgres_version  = var.postgres_version
  instance_class    = local.db_instance_class
  allocated_gib     = local.db_allocated_gib
  final_snapshot    = local.final_snapshot_on_destroy

  deletion_protection = var.db_deletion_protection
}

module "iam" {
  source                 = "./modules/iam"
  name                   = local.name
  artifact_bucket_arn    = module.storage.artifact_bucket_arn
  admin_token_param_arn  = module.secrets.admin_token_param_arn
  database_url_param_arn = module.database.database_url_param_arn
  github_param_arns      = module.secrets.github_param_arns
  cli_npm_spec_param_arn = module.secrets.cli_npm_spec_param_arn
  log_group_arn          = module.monitoring.log_group_arn
  metrics_namespace      = module.monitoring.metrics_namespace

  permissions_boundary_arn = local.permissions_boundary_arn
}

# Logs and alarms (P11, D68): failures are noticed before users report them.
module "monitoring" {
  source                 = "./modules/monitoring"
  name                   = local.name
  domain_name            = local.env.domain_name
  db_instance_identifier = module.database.identifier
  alarm_email            = var.alarm_email
}

module "kolab" {
  source                  = "./modules/kolab"
  name                    = local.name
  instance_type           = local.instance_type
  subnet_id               = module.network.subnet_id
  security_group_id       = module.network.security_group_id
  instance_profile_name   = module.iam.instance_profile_name
  data_volume_id          = module.storage.data_volume_id
  artifact_bucket         = module.storage.artifact_bucket
  admin_token_param_name  = module.secrets.admin_token_param_name
  database_url_param_name = module.database.database_url_param_name
  database_ca_path        = module.database.ca_path
  domain_name             = local.env.domain_name
  zone_id                 = data.aws_route53_zone.this.zone_id
  letsencrypt_email       = var.letsencrypt_email
}

# The server was named "hub" until 2026-10-11 (Decisions Log D11).
moved {
  from = module.hub
  to   = module.kolab
}

module "release" {
  source          = "./modules/release"
  name            = local.name
  source_dir      = coalesce(var.app_source_dir, abspath("${path.root}/../.."))
  artifact_bucket = module.storage.artifact_bucket
  instance_id     = module.kolab.instance_id
  domain_name     = local.env.domain_name
  release_zip     = var.release_zip
  release_id      = var.release_id

  # The instance must be attached to its data volume and reachable before a release installs,
  # and the log group and the role's right to write it there before the release's observe.sh
  # starts the CloudWatch agent.
  depends_on = [module.kolab, module.iam, module.monitoring]
}

# konjir.com, the marketing site (D81): the files in site/, on S3 behind CloudFront.
# This stack, konjir-test, is production (staging was dropped, D83), so site_enabled defaults to true.
module "site" {
  source = "./modules/site"
  count  = var.site_enabled ? 1 : 0

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name        = var.name
  zone_id     = data.aws_route53_zone.this.zone_id
  domain_name = var.zone_name
  site_dir    = abspath("${path.root}/../../site")
}
