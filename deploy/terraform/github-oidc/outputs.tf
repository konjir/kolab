output "role_arns" {
  description = "The roles .github/workflows/deploy.yml assumes, by name. Its env block names the same ARNs."
  value       = { for name, role in aws_iam_role.ci : name => role.arn }
}

output "boundary_arns" {
  description = "Each environment's permissions boundary; deploy/terraform attaches it to every role it creates."
  value       = { for env, policy in aws_iam_policy.boundary : env => policy.arn }
}
