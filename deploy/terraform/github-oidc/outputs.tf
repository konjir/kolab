output "role_arn" {
  description = "The role .github/workflows/deploy.yml assumes; its jobs name the same ARN."
  value       = aws_iam_role.deploy.arn
}

output "subject" {
  description = "The OIDC subject the role trusts: GitHub's default for the production environment of a repository with immutable subjects. The repository's subject must not be customised (README: Deploying from CI)."
  value       = local.subject
}

output "install_document" {
  description = "The SSM document deploy/terraform's release module installs with (its install_document variable)."
  value       = aws_ssm_document.install.name
}

output "boundary_arns" {
  description = "The permissions boundaries deploy/terraform attaches to the instance role and the snapshot role."
  value       = { instance = aws_iam_policy.instance_boundary.arn, dlm = aws_iam_policy.dlm_boundary.arn }
}
