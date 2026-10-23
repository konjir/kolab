output "url" {
  description = "MCP endpoint collaborators connect their harnesses to."
  value       = "https://${var.domain_name}/mcp"
}

output "instance_id" {
  value = module.kolab.instance_id
}

output "public_ip" {
  value = module.kolab.public_ip
}

output "artifact_bucket" {
  value = module.storage.artifact_bucket
}

output "data_volume_id" {
  value = module.storage.data_volume_id
}

output "database_endpoint" {
  description = "Kolab's Postgres on RDS, reachable only from the Kolab instance."
  value       = module.database.endpoint
}

output "database_recovery" {
  description = "What a restore needs (deploy/RECOVERY.md, deploy/recovery-drill.sh): the database's identifier, its URL's SSM parameter, its subnet group, security group, class, storage type and backup retention."
  value       = module.database.recovery
}

output "admin_token_parameter" {
  description = "SSM SecureString holding the break-glass admin token, outside Terraform (W2.22). Read it with deploy/konjir-ops.sh admin-token; rotate it with rotate-admin-token."
  value       = module.secrets.admin_token_param_name
}

output "log_group" {
  description = "CloudWatch Logs group holding Kolab's and Caddy's journal (streams konjir and caddy), kept 30 days."
  value       = module.monitoring.log_group_name
}

output "alarm_topic" {
  description = "SNS topic every alarm notifies; alarm_email subscribes to it."
  value       = module.monitoring.alarm_topic_arn
}

output "alarms" {
  description = "The CloudWatch alarms (README: Alarms)."
  value       = module.monitoring.alarm_names
}

output "release" {
  description = "The release shipped to Kolab: the tree id of the commit deploy/release/pack.sh packed."
  value       = module.release.release
}

output "site" {
  description = "The marketing site (D81): its URL, bucket and CloudFront distribution. Null when site_enabled is false."
  value = var.site_enabled ? {
    url             = module.site[0].url
    bucket          = module.site[0].bucket
    distribution_id = module.site[0].distribution_id
  } : null
}
