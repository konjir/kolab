output "role_arn" {
  description = "The role .github/workflows/deploy.yml assumes; its jobs name the same ARN."
  value       = aws_iam_role.deploy.arn
}

output "subject" {
  description = "The OIDC subject the role trusts. It needs the repository's subject customised to repo, context and job_workflow_ref (README: Deploying from CI)."
  value       = local.subject
}

output "boundary_arns" {
  description = "The permissions boundaries deploy/terraform attaches to the instance role and the snapshot role."
  value       = { instance = aws_iam_policy.instance_boundary.arn, dlm = aws_iam_policy.dlm_boundary.arn }
}
