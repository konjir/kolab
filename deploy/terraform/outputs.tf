output "url" {
  description = "MCP endpoint collaborators connect their harnesses to."
  value       = "https://${var.domain_name}/mcp"
}

output "instance_id" {
  value = module.hub.instance_id
}

output "public_ip" {
  value = module.hub.public_ip
}

output "artifact_bucket" {
  value = module.storage.artifact_bucket
}

output "data_volume_id" {
  value = module.storage.data_volume_id
}

output "admin_token_parameter" {
  description = "SSM SecureString holding the admin token. Read it with deploy/konjir-ops.sh admin-token."
  value       = module.secrets.admin_token_param_name
}

output "release" {
  description = "Hash of the code currently shipped to the hub."
  value       = module.release.release_md5
}
