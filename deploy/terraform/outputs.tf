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

output "admin_token_parameter" {
  description = "SSM SecureString holding the admin token. Read it with deploy/konjir-ops.sh admin-token."
  value       = module.secrets.admin_token_param_name
}

output "release" {
  description = "Hash of the code currently shipped to Kolab."
  value       = module.release.release_md5
}
