# Kolab's database: managed Postgres on RDS (binding DAT1, Decisions Log D39), in private
# subnets, encrypted, with 7 days of automated backups. Kolab connects with TLS, verified
# against the RDS certificate bundle. Its URL, password included, is an SSM SecureString;
# it is also in Terraform state, like the admin token.

variable "name" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "postgres_version" { type = string }
variable "instance_class" { type = string }
variable "allocated_gib" { type = number }
variable "final_snapshot" { type = bool }

# Where the instance keeps the RDS certificate bundle; the kolab module's bootstrap downloads it.
locals { ca_path = "/etc/konjir/rds-ca.pem" }

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.subnet_ids
}

resource "random_password" "db" {
  length  = 40
  special = false
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_157:One zone for a test environment; Multi-AZ is a production step (P10)
  #checkov:skip=CKV_AWS_118:Enhanced monitoring adds cost and no consumer reads it yet
  #checkov:skip=CKV_AWS_353:Performance Insights is a production step (P11)
  #checkov:skip=CKV_AWS_129:Log exports to CloudWatch are a production step (P11)
  #checkov:skip=CKV2_AWS_30:Query logging is a production step (P11)
  #checkov:skip=CKV_AWS_161:Kolab logs in with a password from SSM; IAM auth is a production step
  identifier                 = "${var.name}-db"
  engine                     = "postgres"
  engine_version             = var.postgres_version
  instance_class             = var.instance_class
  allocated_storage          = var.allocated_gib
  storage_type               = "gp3"
  storage_encrypted          = true
  db_name                    = "kolab"
  username                   = "kolab"
  password                   = random_password.db.result
  db_subnet_group_name       = aws_db_subnet_group.this.name
  vpc_security_group_ids     = [var.security_group_id]
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  # A stack that keeps a final snapshot also refuses an accidental delete; a full teardown sets both off.
  deletion_protection       = var.final_snapshot
  skip_final_snapshot       = !var.final_snapshot
  final_snapshot_identifier = "${var.name}-db-final"
  apply_immediately         = false
}

resource "aws_ssm_parameter" "database_url" {
  #checkov:skip=CKV_AWS_337:SecureString with the AWS-managed SSM key; a customer-managed key is a production step
  name        = "/konjir/${var.name}/database-url"
  description = "Kolab's Postgres URL, password included"
  type        = "SecureString"
  value = format(
    "postgres://kolab:%s@%s/kolab?sslmode=verify-full&sslrootcert=%s",
    random_password.db.result, aws_db_instance.this.endpoint, local.ca_path,
  )
}

output "database_url_param_name" { value = aws_ssm_parameter.database_url.name }
output "database_url_param_arn" { value = aws_ssm_parameter.database_url.arn }
output "endpoint" { value = aws_db_instance.this.endpoint }
output "ca_path" { value = local.ca_path }
