provider "aws" {
  region  = var.region
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
  name   = var.name
  az     = local.az
}

module "storage" {
  source         = "./modules/storage"
  name           = var.name
  az             = local.az
  data_gib       = var.data_volume_gib
  final_snapshot = var.final_snapshot_on_destroy
}

module "secrets" {
  source = "./modules/secrets"
  name   = var.name
}

module "iam" {
  source               = "./modules/iam"
  name                 = var.name
  artifact_bucket_arn   = module.storage.artifact_bucket_arn
  admin_token_param_arn = module.secrets.admin_token_param_arn
}

module "hub" {
  source                 = "./modules/hub"
  name                   = var.name
  instance_type          = var.instance_type
  subnet_id              = module.network.subnet_id
  security_group_id      = module.network.security_group_id
  instance_profile_name  = module.iam.instance_profile_name
  data_volume_id         = module.storage.data_volume_id
  artifact_bucket        = module.storage.artifact_bucket
  admin_token_param_name = module.secrets.admin_token_param_name
  domain_name            = var.domain_name
  zone_id                = data.aws_route53_zone.this.zone_id
  review_mode            = var.review_mode
  review_model           = var.review_model
  letsencrypt_email      = var.letsencrypt_email
}

module "release" {
  source          = "./modules/release"
  name            = var.name
  source_dir      = coalesce(var.app_source_dir, abspath("${path.root}/../.."))
  artifact_bucket = module.storage.artifact_bucket
  instance_id     = module.hub.instance_id
  domain_name     = var.domain_name

  # The instance must be attached to its data volume and reachable before a release installs.
  depends_on = [module.hub]
}
